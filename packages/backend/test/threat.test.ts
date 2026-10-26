// Golden tests of the threat query on real positions, on the real Engine at verify mode's depth:
// the shared Engine (the build the browser runs, ADR 0007) and the desktop's Engine give the same
// answer, and so does the protocol the Review asks it through.
import { describe, expect, it } from 'vitest';
import { INITIAL_FEN, playLine } from '@chess-coach/shared/chess';
import { createNodeEngine } from '../src/engine/node-engine.ts';
import { EngineService } from '../src/engine/service.ts';
import { VERIFY_ENGINE } from '../src/verify/instance.ts';
import { client, instance } from './helpers.ts';

const after = (ucis: string[]): string => (playLine(INITIAL_FEN, ucis).at(-1) as { fenAfter: string }).fenAfter;

const POSITIONS = {
  // 1.e4 e5 2.Qh5 Nc6 3.Bc4: Scholar's Mate is threatened.
  scholar: after(['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4']),
  // 1.e4 e5 2.Nf3: the knight attacks the e5 pawn.
  pawn: after(['e2e4', 'e7e5', 'g1f3']),
  // 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6: the pawn attacks the bishop.
  bishop: after(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6']),
  // The Italian Game after 3...Bc5: quiet, Black's best free move would only develop.
  quiet: after(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5']),
  // 1.e4 f6 2.d4 g5 3.Qh5+: Black is in check.
  check: after(['e2e4', 'f7f6', 'd2d4', 'g7g5', 'd1h5']),
};

const EXPECTED = {
  scholar: { side: 'white', uci: 'h5f7', san: 'Qxf7#' },
  pawn: { side: 'white', uci: 'f3e5', san: 'Nxe5' },
  bishop: { side: 'black', uci: 'a6b5', san: 'axb5' },
  quiet: undefined,
  start: undefined,
  check: undefined,
};

const options = { multiPv: VERIFY_ENGINE.multiPv, depth: VERIFY_ENGINE.depth };
const cases = [...Object.entries(POSITIONS), ['start', INITIAL_FEN] as const].map(([name, fen]) => [name, fen, EXPECTED[name as keyof typeof EXPECTED]] as const);

describe('the threat query', () => {
  it.each(cases)('finds the threat in the %s position on the shared Engine', async (_name, fen, expected) => {
    const threat = await (await createNodeEngine(1)).threat(fen, options);
    if (expected) expect(threat).toMatchObject(expected);
    else expect(threat).toBeUndefined();
  });

  it.each(cases)('finds the same threat in the %s position on the desktop’s Engine', async (_name, fen, expected) => {
    const service = new EngineService(() => createNodeEngine(1), VERIFY_ENGINE);
    const threat = await service.threat(fen);
    if (expected) expect(threat).toMatchObject(expected);
    else expect(threat).toBeUndefined();
    expect(threat).toEqual(await (await createNodeEngine(1)).threat(fen, options));
  });

  it('answers over the protocol, and refuses a position that is not valid', async () => {
    const c = await client(await instance());
    expect((await c.request('engine.threat', { fen: POSITIONS.scholar })).threat).toMatchObject(EXPECTED.scholar);
    expect((await c.request('engine.threat', { fen: POSITIONS.quiet })).threat).toBeNull();
    await expect(c.request('engine.threat', { fen: 'not a position' })).rejects.toMatchObject({ code: 'bad-request' });
  });
});
