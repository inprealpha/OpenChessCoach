// One-command live smoke check for local Coach backends (Claude, Codex, Pi).
// Run on your own machine where your Claude, Codex (ChatGPT subscription), or Pi credentials are logged in:
//   npm run smoke:coach
//   npm run smoke:coach -- --provider codex
//   npm run smoke:coach -- --provider pi
//   npm run smoke:coach -- --provider claude
import { parseArgs } from 'node:util';
import { COACH_PROVIDERS, type CoachProvider } from '../packages/shared/src/protocol.ts';
import type { Brief } from '../packages/shared/src/coach/brief.ts';
import type { EngineQuestion } from '../packages/shared/src/coach/engine-tool.ts';
import { checkClaude } from '../packages/backend/src/claude-check.ts';
import { checkCodex } from '../packages/backend/src/codex-check.ts';
import { checkPi } from '../packages/backend/src/pi-check.ts';
import { RealCoach } from '../packages/backend/src/coach/real.ts';
import { CodexCoach } from '../packages/backend/src/coach/codex.ts';
import { PiCoach } from '../packages/backend/src/coach/pi.ts';
import type { CoachEngine, CoachPort } from '../packages/backend/src/coach/port.ts';

const SMOKE_BRIEF: Brief = {
  job: 'why',
  level: 'casual',
  sideToMove: 'white',
  fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
  recentMoves: '1. e4 e5 2. Nf3 Nc6',
  candidates: [
    { san: 'Bb5', uci: 'f1b5', evaluation: '+0.30', grade: 'Best', line: 'Bb5 a6 Ba4' },
    { san: 'Bc4', uci: 'f1c4', evaluation: '+0.20', grade: 'Good', line: 'Bc4 Bc5' },
  ],
  question: 'Why is Bb5 good here, and what happens if I play Bc4 instead?',
  maxWords: 80,
  allowNote: false,
  hideMoves: false,
};

function mockEngineTool(onAsk: (q: EngineQuestion) => void): CoachEngine {
  let asked = 0;
  return {
    maxQuestions: 2,
    maxCalls: 4,
    get exhausted() {
      return asked >= 2;
    },
    async ask(q: EngineQuestion) {
      asked += 1;
      onAsk(q);
      const label = q.line?.join(' ') ?? q.move ?? 'that line';
      return {
        text: `After ${label}, the position stays roughly equal (+0.2) with active piece play.`,
        refused: false,
      };
    },
  };
}

async function runProviderSmoke(provider: CoachProvider, model?: string): Promise<boolean> {
  process.stdout.write(`\n=== ${provider.toUpperCase()} ===\n`);
  let coach: CoachPort;
  if (provider === 'claude') {
    const check = await checkClaude();
    if (!check.ok) {
      process.stdout.write(`  [SKIP] ${check.message}\n`);
      return false;
    }
    coach = new RealCoach(check.path ? { claudePath: check.path } : {});
  } else if (provider === 'codex') {
    const check = await checkCodex();
    if (!check.ok) {
      process.stdout.write(`  [SKIP] ${check.message}\n`);
      return false;
    }
    coach = new CodexCoach(check.path ? { codexPath: check.path } : {});
  } else {
    const check = await checkPi();
    if (!check.ok) {
      process.stdout.write(`  [SKIP] ${check.message}\n`);
      return false;
    }
    coach = new PiCoach();
  }

  const status = await coach.status();
  process.stdout.write(`  status(): ${JSON.stringify(status)}\n`);
  if (status.state !== 'ready') {
    process.stdout.write(`  [FAIL] Provider not ready: ${status.reason ?? 'unknown'}\n`);
    return false;
  }

  let deltas = 0;
  let streamed = '';
  const engineCalls: EngineQuestion[] = [];
  const engine = coach.supportsEngineTool !== false ? mockEngineTool((q) => engineCalls.push(q)) : undefined;

  const started = Date.now();
  const reply = await coach.ask(
    {
      job: 'why',
      model: model ?? (provider === 'claude' ? 'haiku' : 'default'),
      brief: SMOKE_BRIEF,
      ...(engine ? { engine } : {}),
    },
    (delta) => {
      deltas += 1;
      streamed += delta;
    },
  );
  const elapsed = Date.now() - started;

  process.stdout.write(`  elapsed: ${elapsed}ms\n`);
  process.stdout.write(`  streamed chunks: ${deltas} (${streamed.length} chars)\n`);
  process.stdout.write(`  reply.text (${reply.text.length} chars): ${reply.text.slice(0, 160).replace(/\n/g, ' ')}\n`);
  process.stdout.write(`  structured: moves=${JSON.stringify(reply.moves)} arrows=${JSON.stringify(reply.arrows)} highlights=${JSON.stringify(reply.highlights)}\n`);
  if (engine) process.stdout.write(`  ask_engine calls: ${engineCalls.length}\n`);
  if (reply.usage) process.stdout.write(`  usage: ${JSON.stringify(reply.usage)}\n`);

  if (!reply.text.trim()) {
    process.stdout.write(`  [FAIL] Empty reply.text\n`);
    return false;
  }
  process.stdout.write(`  [PASS] ${provider} live smoke check succeeded.\n`);
  return true;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
    },
  });

  const requested = values.provider?.trim().toLowerCase();
  if (requested && !(COACH_PROVIDERS as readonly string[]).includes(requested)) {
    process.stderr.write(`--provider must be one of ${COACH_PROVIDERS.join(', ')}\n`);
    process.exit(2);
  }

  const targets: CoachProvider[] = requested ? [requested as CoachProvider] : [...COACH_PROVIDERS];
  let passed = 0;
  for (const provider of targets) {
    try {
      if (await runProviderSmoke(provider, values.model)) passed += 1;
    } catch (err) {
      process.stderr.write(`  [FAIL] ${provider}: ${err instanceof Error ? err.message : String(err)}\n`);
      if (requested) process.exit(1);
    }
  }

  process.stdout.write(`\nSummary: ${passed}/${targets.length} provider(s) passed.\n`);
  if (passed === 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
