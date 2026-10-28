// Prototype, not the app: runs the Maia2 model exported by data-prep/maia2-onnx-export.py from Node,
// with the board encoding written in TypeScript on chessops, and checks its top three against
// Python's on the same positions. Measures load time and time per position.
//
// Usage: node data-prep/maia2-node.ts <dir> <export dir> --ort=<folder with node_modules/onnxruntime-*>
//          [--runtime=node|web] [--model=maia2-blitz.onnx|maia2-blitz-fp16.onnx] [--threads=1]
// onnxruntime is not a dependency of the repo: install it in a folder outside git, for example
//   npm install --prefix <folder> onnxruntime-node@1.23.0 onnxruntime-web@1.23.0
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseFen } from 'chessops/fen';
import { legalMoves } from '@chess-coach/shared/chess';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const [dir, exportDir] = args.filter((a) => !a.startsWith('--'));
const runtime = flag('runtime', 'node');
const modelFile = flag('model', 'maia2-blitz.onnx');
const half = modelFile.includes('fp16');

interface Sample {
  id: string;
  fen: string;
  elo: number;
  oppElo: number;
  played: { uci: string };
  group?: string;
}

const ROLES = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'] as const;

/** Maia2's rating buckets: under 1100, then 100-point steps, then 2000 and up (0 to 10). */
export function eloCategory(elo: number): number {
  if (elo < 1100) return 0;
  if (elo >= 2000) return 10;
  return 1 + Math.floor((elo - 1100) / 100);
}

const mirrorUci = (uci: string) => uci.replace(/[1-8]/g, (r) => String(9 - Number(r)));

/**
 * Maia2's input for one position: 18 planes of 8×8, from the side to move's point of view (the
 * board is mirrored and the colours swapped when Black is to move, as python-chess's mirror() does).
 * Planes 0–5 are the mover's pawn, knight, bishop, rook, queen, king; 6–11 the opponent's; 12 is
 * "White to move"; 13–16 castling rights (White short, White long, Black short, Black long); 17 the
 * en passant square. Cell [plane][rank][file].
 */
export function encode(fen: string, out: Float32Array, offset: number): void {
  const setup = parseFen(fen).unwrap();
  const black = setup.turn === 'black';
  const flip = (sq: number) => (black ? sq ^ 56 : sq);
  for (const [sq, piece] of setup.board) {
    const own = (piece.color === 'white') !== black;
    out[offset + (ROLES.indexOf(piece.role) + (own ? 0 : 6)) * 64 + flip(sq)] = 1;
  }
  // After mirroring, the side to move is always White.
  for (let i = 0; i < 64; i++) out[offset + 12 * 64 + i] = 1;
  const rights = setup.castlingRights;
  const [ownRank, oppRank] = black ? [56, 0] : [0, 56];
  [ownRank + 7, ownRank, oppRank + 7, oppRank].forEach((rook, i) => {
    if (rights.has(rook)) for (let j = 0; j < 64; j++) out[offset + (13 + i) * 64 + j] = 1;
  });
  if (setup.epSquare !== undefined) out[offset + 17 * 64 + flip(setup.epSquare)] = 1;
}

const halfToFloat = (h: number): number => {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
};

const require = createRequire(join(flag('ort', '.'), 'node_modules', 'x.js'));
// The few onnxruntime calls used here; the package isn't a dependency of the repo, so no types.
interface Ort {
  Tensor: new (type: string, data: Float32Array | Uint16Array | BigInt64Array, dims: number[]) => unknown;
  InferenceSession: {
    create(path: string, options?: object): Promise<{ run(feeds: Record<string, unknown>, fetches: string[]): Promise<Record<string, { data: unknown }>> }>;
  };
  env: { wasm: { numThreads: number } };
}
const ort = require(runtime === 'web' ? 'onnxruntime-web' : 'onnxruntime-node') as Ort;
const threads = Number(flag('threads', '1'));
if (runtime === 'web') ort.env.wasm.numThreads = threads;

const moves = JSON.parse(readFileSync(join(exportDir!, 'maia2-moves.json'), 'utf8')) as string[];
const index = new Map(moves.map((m, i) => [m, i]));
const python = JSON.parse(readFileSync(join(exportDir!, 'maia2-python-top3.json'), 'utf8')) as Record<string, string[]>;
const samples = JSON.parse(readFileSync(join(dir!, 'samples.json'), 'utf8')) as Sample[];
const modelPath = join(exportDir!, modelFile);

const loadStart = performance.now();
const session = await ort.InferenceSession.create(modelPath, runtime === 'web' ? {} : { intraOpNumThreads: threads });
const loadMs = performance.now() - loadStart;

/** Maia2's three most likely legal moves, in the repo's UCI (castling as e1g1). */
async function top3(s: Sample): Promise<string[]> {
  const planes = new Float32Array(18 * 64);
  encode(s.fen, planes, 0);
  const boards = half
    ? new ort.Tensor('float16', Uint16Array.from(planes, (v) => (v ? 0x3c00 : 0)), [1, 18, 8, 8])
    : new ort.Tensor('float32', planes, [1, 18, 8, 8]);
  const feeds = {
    boards,
    elos_self: new ort.Tensor('int64', BigInt64Array.of(BigInt(eloCategory(s.elo))), [1]),
    elos_oppo: new ort.Tensor('int64', BigInt64Array.of(BigInt(eloCategory(s.oppElo))), [1]),
  };
  const out = await session.run(feeds, ['logits_maia']);
  const data = out.logits_maia!.data as Float32Array | Uint16Array;
  const logit = (i: number) => (half ? halfToFloat(data[i]!) : data[i]!);
  const black = s.fen.split(' ')[1] === 'b';
  return legalMoves(s.fen)
    .map((uci) => ({ uci, i: index.get(black ? mirrorUci(uci) : uci) }))
    .filter((m): m is { uci: string; i: number } => m.i !== undefined)
    .sort((a, b) => logit(b.i) - logit(a.i))
    .slice(0, 3)
    .map((m) => m.uci);
}

await top3(samples[0]!); // warm-up
let same1 = 0;
let same3 = 0;
let sameSet = 0;
// Hit rates against the human's move, to see what a smaller model costs: all, and quick mistakes.
const hits = { all: [0, 0, 0], mistake: [0, 0, 0] };
const started = performance.now();
for (const s of samples) {
  const ours = await top3(s);
  const theirs = python[s.id] ?? [];
  for (const key of s.group === 'mistake' ? (['all', 'mistake'] as const) : (['all'] as const)) {
    hits[key][0]!++;
    if (ours[0] === s.played.uci) hits[key][1]!++;
    if (ours.includes(s.played.uci)) hits[key][2]!++;
  }
  if (ours[0] === theirs[0]) same1++;
  if (ours.join() === theirs.join()) same3++;
  if (ours.length === theirs.length && ours.every((m) => theirs.includes(m))) sameSet++;
  else if (args.includes('--show')) console.error(`${s.id} ${s.fen}: node ${ours.join(' ')}, python ${theirs.join(' ')}`);
}
const perMs = (performance.now() - started) / samples.length;
console.log(
  JSON.stringify({
    runtime,
    model: modelFile,
    modelMB: Math.round(statSync(modelPath).size / 1e5) / 10,
    threads,
    loadMs: Math.round(loadMs),
    msPerPosition: Math.round(perMs * 10) / 10,
    positions: samples.length,
    sameFirstMove: same1,
    sameTop3InOrder: same3,
    sameTop3AnyOrder: sameSet,
    hitsTop1Top3: Object.fromEntries(Object.entries(hits).filter(([, [n]]) => n).map(([k, [n, h1, h3]]) => [k, `${Math.round((100 * h1!) / n!)}% / ${Math.round((100 * h3!) / n!)}%`])),
    rssMB: Math.round(process.memoryUsage().rss / 1e6),
  }),
);
process.exit(0);
