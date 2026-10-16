// Versus: every pair of players over the same games, rated together.
// Run: npm run versus -- systemone:jev-latest ollama:llama3.1:8b     two models (ids or provider:model specs)
//      npm run versus                                                  the two in MODELS (.env), else pick them
//      npm run versus -- --players all                                 every player: the official round robin
// Also --endpoint id=http://… (repeatable), --games 24, --parallel (1 with a local model, else 4), --timeout, --out,
// --resume (keep the pairs an earlier, interrupted run of the same players finished, and play the rest).
// Named players write to runs/<a>-vs-<b>/, --players all to results/: versus.json, VERSUS.md, versus.pgn and each
// pair's recording in versus-games/. Results are rewritten after every finished pair.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { canAsk, defaultParallel, loadPool, modelsFromEnv, pickPlayers, readiness, resolvePlayer } from '../src/cli.ts';
import { BENCH_VERSION, RULES } from '../src/leaderboard.ts';
import { endpointPlayer, ID_PATTERN, type Player } from '../src/players.ts';
import { inBatches, PlayerFailedError } from '../src/run.ts';
import { clearPairs, pairings, pairRecording, playMatch, readPair, renderVersusMarkdown, replayPair, summarizeVersus, toPgn, writePair, type MatchGame, type Versus } from '../src/versus.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    players: { type: 'string' },
    endpoint: { type: 'string', multiple: true, default: [] },
    'players-file': { type: 'string', default: 'players.json' },
    games: { type: 'string', default: String(RULES.minGames) },
    parallel: { type: 'string' },
    timeout: { type: 'string', default: String(RULES.moveTimeoutMs) },
    out: { type: 'string' },
    resume: { type: 'boolean', default: false },
  },
});
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const attempt = <T>(f: () => T): T => {
  try {
    return f();
  } catch (err) {
    return fail((err as Error).message);
  }
};
const games = Number(values.games);
const timeoutMs = Number(values.timeout);
if (!Number.isInteger(games) || games < 1) fail('--games must be a whole number ≥ 1');
if (!(timeoutMs > 0)) fail('--timeout must be a number of milliseconds');

const fromArgs = values.endpoint!.map((spec): Player => {
  const [id, ...rest] = spec.split('=');
  const url = rest.join('=');
  if (!ID_PATTERN.test(id) || !/^https?:\/\//.test(url)) return fail(`--endpoint wants id=http(s)://…, got ${spec}`);
  return endpointPlayer({ id, name: id, kind: 'decision', url, token: process.env.BENCH_ENDPOINT_TOKEN });
});
const known = attempt(() => loadPool(values['players-file']!));
const everyone = values.players === 'all';
// The official round robin must use the standard rules so results stay comparable.
if (everyone && timeoutMs !== RULES.moveTimeoutMs) fail(`--players all uses the ${RULES.moveTimeoutMs} ms move limit`);
if (everyone && games % RULES.minGames !== 0) fail(`--players all plays a multiple of ${RULES.minGames} games per pair (each opening from each side)`);
const named = [...positionals, ...(values.players && !everyone ? values.players.split(',') : [])];
const resolve = (names: string[]) => attempt(() => names.map((n) => resolvePlayer(n, known)));
const USAGE = 'name two players: npm run versus -- <model> <model> (ids, or models like systemone:jev-latest, ollama:llama3.1:8b), or set MODELS in .env';
let picked: Player[];
if (everyone) picked = [...known, ...fromArgs];
else if (named.length || fromArgs.length) picked = [...resolve(named), ...fromArgs];
else if (modelsFromEnv().length) picked = resolve(modelsFromEnv());
else if (canAsk()) picked = await pickPlayers(2, known);
else picked = fail(USAGE);
const pool = [...new Set(picked)];
const ids = new Set<string>();
for (const p of pool) {
  if (ids.has(p.id)) fail(`two players are called ${p.id}`);
  ids.add(p.id);
}
if (pool.length < 2) fail(`versus needs at least two players: ${USAGE}`);
const parallel = Number(values.parallel ?? defaultParallel(pool));
if (!Number.isInteger(parallel) || parallel < 1) fail('--parallel must be a whole number ≥ 1');
// Ad-hoc runs get their own folder so they never overwrite the committed results.
const out = values.out ?? (everyone ? 'results/versus.json' : join('runs', pool.map((p) => p.id).join('-vs-'), 'versus.json'));

const skipped: Versus['skipped'] = [];
const ready: Player[] = [];
for (const p of pool) {
  const problem = await readiness(p, timeoutMs);
  if (problem) {
    console.log(`${p.name}: skipped, ${problem}`);
    skipped.push({ player: p.id, reason: problem });
  } else ready.push(p);
}
if (ready.length < 2) fail('fewer than two players can play');

const pairs = pairings(ready);
const dir = dirname(out);
const gamesDir = join(dir, 'versus-games');
const settings: Versus['settings'] = { gamesPerPair: games, maxPlies: RULES.maxPlies, moveTimeoutMs: timeoutMs };
const name = (id: string) => ready.find((p) => p.id === id)!.name;
/** Finished pairs only, by pair index. */
const done = new Map<number, MatchGame[]>();

if (values.resume) {
  for (const [i, [a, b]] of pairs.entries()) {
    const rec = readPair(gamesDir, a.id, b.id);
    if (!rec) continue;
    if (rec.benchVersion !== BENCH_VERSION || JSON.stringify(rec.settings) !== JSON.stringify(settings)) {
      console.log(`  ${a.id} vs ${b.id}: recorded under other rules, played again`);
      continue;
    }
    done.set(i, await replayPair(rec).catch((err: Error) => fail(`${a.id} vs ${b.id} does not replay (${err.message}); run without --resume`)));
  }
  console.log(`resuming: ${done.size} of ${pairs.length} pairs already played`);
} else clearPairs(gamesDir);

function write(complete: boolean): Versus {
  const finished = [...done.keys()].sort((x, y) => x - y).flatMap((i) => done.get(i)!);
  const versus: Versus = {
    generatedAt: new Date().toISOString(),
    benchVersion: BENCH_VERSION,
    complete,
    players: ready.map((p) => p.id),
    settings,
    ...summarizeVersus(ready, finished),
    skipped,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(out, `${JSON.stringify(versus, null, 2)}\n`);
  writeFileSync(join(dir, 'VERSUS.md'), renderVersusMarkdown(versus));
  writeFileSync(join(dir, 'versus.pgn'), toPgn(finished, Object.fromEntries(ready.map((p) => [p.id, p.name]))));
  return versus;
}

const todo = pairs.map((_, i) => i).filter((i) => !done.has(i));
console.log(`versus: ${ready.length} players, ${pairs.length} pairs × ${games} games, ${RULES.maxPlies}-move cap, ${timeoutMs} ms per move, ${parallel} at a time`);
const partial = new Map<number, MatchGame[]>();
try {
  await inBatches(todo.length * games, parallel, async (n) => {
    const pair = todo[Math.floor(n / games)];
    const [a, b] = pairs[pair];
    const g = await playMatch(a, b, n % games, { timeoutMs });
    console.log(`  ${name(g.white.player)} – ${name(g.black.player)}  ${g.result.padEnd(7)} (${g.opening}, ${g.termination}, ${g.plies} moves)`);
    const list = partial.get(pair) ?? new Array<MatchGame>(games);
    list[g.game] = g;
    partial.set(pair, list);
    if (list.filter(Boolean).length === games) {
      // Persist each pair as it finishes, so --resume can pick up after an interruption.
      writePair(gamesDir, pairRecording(a.id, b.id, list, settings));
      done.set(pair, list);
      partial.delete(pair);
      write(false);
    }
  });
} catch (err) {
  if (!(err instanceof PlayerFailedError)) throw err;
  skipped.push({ player: err.player, reason: err.message });
  write(false);
  fail(`\nstopped: ${err.message}.\nThe ${done.size} finished pairs are in ${out} (marked incomplete). Fix the player and run the same command with --resume to play the rest.`);
}

const versus = write(true);
console.log('');
for (const e of versus.entries) console.log(`${e.name.padEnd(20)} rating ${e.rating} ± ${e.margin}, score ${e.scorePct}%, W/D/L ${e.winPct}/${e.drawPct}/${e.lossPct}%, fallbacks ${e.fallbackPct}%`);
console.log(`\nwrote ${out}, ${join(dir, 'VERSUS.md')}, ${join(dir, 'versus.pgn')} and the games in ${gamesDir}`);
