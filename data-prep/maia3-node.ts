// Prototype, not the app: runs the Maia-3 model exported by data-prep/maia3-onnx-export.py from Node,
// with Maia-3's input (the last 8 positions of the game) written in TypeScript on chessops, and
// checks its top three against Python's on the same positions. Measures load time and time per position.
//
// Usage: node data-prep/maia3-node.ts <dir> <export dir> --ort=<folder with node_modules/onnxruntime-*>
//          [--runtime=node|web] [--model=maia3-5m] [--threads=1] [--show]
// <dir>/samples.json needs each game's moves: run `node data-prep/human-moves.ts history` first.
// onnxruntime is not a dependency of the repo: install it in a folder outside git, for example
//   npm install --prefix <folder> onnxruntime-node@1.23.0 onnxruntime-web@1.23.0
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { INITIAL_FEN, legalMoves, piecesOf, playUci, turnOf } from '@chess-coach/shared/chess';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const [dir, exportDir] = args.filter((a) => !a.startsWith('--'));
const runtime = flag('runtime', 'node');
const model = flag('model', 'maia3-5m');

interface Sample {
  id: string;
  fen: string;
  elo: number;
  oppElo: number;
  moves: string[];
  played: { uci: string };
  group?: string;
}

const HISTORY = 8;
const WIDTH = 12 * HISTORY + 1;
const ROLES = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
const square = (name: string) => (Number(name[1]) - 1) * 8 + (name.charCodeAt(0) - 97);

/**
 * Maia-3's input: for each of the 64 squares, 12 piece planes for each of the last 8 positions
 * (oldest first, the earliest repeated when the game is shorter), then a think-time column the
 * model ignores. Each position is seen from its own side to move (python-chess's mirror() when
 * Black is to move): planes 0–5 are that side's pawn to king, 6–11 the other side's.
 */
export function encode(fens: readonly string[]): Float32Array {
  const last = fens.slice(-HISTORY);
  const padded = [...Array<string>(HISTORY - last.length).fill(last[0]!), ...last];
  const out = new Float32Array(64 * WIDTH);
  padded.forEach((fen, h) => {
    const turn = turnOf(fen);
    for (const piece of piecesOf(fen)) {
      const sq = turn === 'black' ? square(piece.square) ^ 56 : square(piece.square);
      out[sq * WIDTH + h * 12 + ROLES.indexOf(piece.role) + (piece.color === turn ? 0 : 6)] = 1;
    }
  });
  return out;
}

/** A move's index in Maia-3's output, from the side to move's point of view: 64×64 from-to, then promotions. */
export function moveIndex(uci: string, black: boolean): number {
  const m = black ? uci.replace(/[1-8]/g, (r) => String(9 - Number(r))) : uci;
  if (m.length === 5) return 4096 + (m.charCodeAt(0) - 97) * 32 + (m.charCodeAt(2) - 97) * 4 + 'qrbn'.indexOf(m[4]!);
  return square(m.slice(0, 2)) * 64 + square(m.slice(2, 4));
}

// The few onnxruntime calls used here; the package isn't a dependency of the repo, so no types.
interface Ort {
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => unknown;
  InferenceSession: {
    create(path: string, options?: object): Promise<{ run(feeds: Record<string, unknown>, fetches: string[]): Promise<Record<string, { data: unknown }>> }>;
  };
  env: { wasm: { numThreads: number } };
}
const require = createRequire(join(flag('ort', '.'), 'node_modules', 'x.js'));
const ort = require(runtime === 'web' ? 'onnxruntime-web' : 'onnxruntime-node') as Ort;
const threads = Number(flag('threads', '1'));
if (runtime === 'web') ort.env.wasm.numThreads = threads;

const python = JSON.parse(readFileSync(join(exportDir!, `${model}-python-top3.json`), 'utf8')) as Record<string, string[]>;
const samples = JSON.parse(readFileSync(join(dir!, 'samples.json'), 'utf8')) as Sample[];
const modelPath = join(exportDir!, `${model}.onnx`);

const loadStart = performance.now();
const session = await ort.InferenceSession.create(modelPath, runtime === 'web' ? {} : { intraOpNumThreads: threads });
const loadMs = performance.now() - loadStart;

/** Maia-3's three most likely legal moves, in the repo's UCI (castling as e1g1). */
async function top3(s: Sample): Promise<string[]> {
  const fens = [INITIAL_FEN];
  for (const uci of s.moves) fens.push(playUci(fens.at(-1)!, uci)!.fenAfter);
  const out = await session.run(
    {
      tokens: new ort.Tensor('float32', encode(fens), [1, 64, WIDTH]),
      self_elos: new ort.Tensor('int64', BigInt64Array.of(BigInt(s.elo)), [1]),
      oppo_elos: new ort.Tensor('int64', BigInt64Array.of(BigInt(s.oppElo)), [1]),
    },
    ['logits_move'],
  );
  const logits = out.logits_move!.data as Float32Array;
  const black = turnOf(s.fen) === 'black';
  return legalMoves(s.fen)
    .map((uci) => ({ uci, score: logits[moveIndex(uci, black)]! }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((m) => m.uci);
}

await top3(samples[0]!); // warm-up
let same1 = 0;
let same3 = 0;
let sameSet = 0;
const hits = { all: [0, 0, 0], mistake: [0, 0, 0] };
const started = performance.now();
for (const s of samples) {
  const ours = await top3(s);
  const theirs = python[s.id] ?? [];
  if (ours[0] === theirs[0]) same1++;
  if (ours.join() === theirs.join()) same3++;
  if (ours.length === theirs.length && ours.every((m) => theirs.includes(m))) sameSet++;
  else if (args.includes('--show')) console.error(`${s.id} ${s.fen}: node ${ours.join(' ')}, python ${theirs.join(' ')}`);
  for (const key of s.group === 'mistake' ? (['all', 'mistake'] as const) : (['all'] as const)) {
    hits[key][0]!++;
    if (ours[0] === s.played.uci) hits[key][1]!++;
    if (ours.includes(s.played.uci)) hits[key][2]!++;
  }
}
const perMs = (performance.now() - started) / samples.length;
console.log(
  JSON.stringify({
    runtime,
    model,
    modelMB: Math.round(statSync(modelPath).size / 1e5) / 10,
    threads,
    loadMs: Math.round(loadMs),
    msPerPosition: Math.round(perMs * 10) / 10,
    positions: samples.length,
    sameFirstMove: same1,
    sameTop3InOrder: same3,
    sameTop3AnyOrder: sameSet,
    hitsTop1Top3: Object.fromEntries(Object.entries(hits).map(([k, [n, h1, h3]]) => [k, `${Math.round((100 * h1!) / n!)}% / ${Math.round((100 * h3!) / n!)}%`])),
    rssMB: Math.round(process.memoryUsage().rss / 1e6),
  }),
);
process.exit(0);
