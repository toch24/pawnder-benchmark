// Lists the available players; --check sends each model the warm-up question and reports the answer and latency.
// Run: npm run models [-- --check] [--players-file players.json] [model …]   (models named here are listed too)
import { parseArgs } from 'node:util';
import { loadPool, resolvePlayer } from '../src/cli.ts';
import type { Game } from '../src/game.ts';
import { WARM_UP, type Player } from '../src/players.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    check: { type: 'boolean', default: false },
    'players-file': { type: 'string', default: 'players.json' },
  },
});

let players: Player[];
try {
  const pool = loadPool(values['players-file']!);
  players = [...pool, ...positionals.map((n) => resolvePlayer(n, pool)).filter((p) => !pool.includes(p))];
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

async function check(p: Player): Promise<string> {
  if (p.problem) return p.problem;
  const t0 = performance.now();
  try {
    const res = await p.decide(WARM_UP, undefined as unknown as Game, AbortSignal.timeout(60_000));
    const choice = res.answers.warmup?.choice;
    const ms = Math.round(performance.now() - t0);
    return choice === 'a' || choice === 'b' ? `answers (${ms} ms)` : `answered ${JSON.stringify(choice)}, not one of the options (${ms} ms)`;
  } catch (err) {
    return (err as Error).message;
  }
}

const models = players.filter((p) => p.kind !== 'rules' || p.warmUp);
const baselines = players.filter((p) => !models.includes(p));
console.log(`baselines: ${baselines.map((p) => p.id).join(', ')}`);
if (!models.length) {
  console.log('\nno models yet: put a key in .env and name a model (npm run versus -- systemone:jev-latest greedy), set MODELS in .env, or list them in players.json (see README.md)');
} else {
  console.log('\nmodels:');
  for (const p of models) {
    const status = values.check ? await check(p) : (p.problem ?? 'ready');
    console.log(`  ${p.id.padEnd(24)} ${p.kind.padEnd(8)} ${(p.where ?? '').padEnd(56)} ${status}`);
  }
  if (!values.check) console.log('\nnpm run models -- --check asks each model one question, to see it answers');
}
