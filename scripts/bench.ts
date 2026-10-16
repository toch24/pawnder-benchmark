// Gauntlet: players against the scripted opponents.
//
// One player:   npm run bench -- ollama:llama3.1:8b   a model (provider:model), a player id, or the first of MODELS
//               npm run bench -- --player facts [--opponent all|random|greedy|minimax] [--games 4] [--parallel 4]
//               npm run bench -- --endpoint http://localhost:8787 [--name "My Model"] [--kind decision|chat|rules]
//               --record dir   writes every game's recording to dir/<player>/<opponent>-NN.json.gz
// Leaderboard:  npm run leaderboard [-- --players all|id,id] [--games 24] [--out results/leaderboard.json]
//               baselines plus players.json (--players-file) against every opponent, games in results/games/<player>/.
//               A list of ids re-plays only those players and keeps the board's other rows.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { OPPONENTS, isOpponentId, type OpponentId } from '../src/chess/engine.ts';
import { setupFor } from '../src/game.ts';
import { BENCH_VERSION, isModelKind, rank, RULES, summarize, type GameResult, type Leaderboard, type LeaderboardEntry } from '../src/leaderboard.ts';
import { canAsk, defaultParallel, loadPool, modelsFromEnv, pickPlayers, readiness, resolvePlayer } from '../src/cli.ts';
import { endpointPlayer, type Player } from '../src/players.ts';
import { writeGames, type Recording } from '../src/recording.ts';
import { writeReport } from '../src/report.ts';
import { inBatches, playOne, PlayerFailedError, type PlayedRecord } from '../src/run.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    player: { type: 'string' },
    endpoint: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string' },
    opponent: { type: 'string', default: 'all' },
    games: { type: 'string' },
    parallel: { type: 'string' },
    timeout: { type: 'string' },
    record: { type: 'string' },
    leaderboard: { type: 'boolean', default: false },
    players: { type: 'string', default: 'all' },
    'players-file': { type: 'string', default: 'players.json' },
    out: { type: 'string', default: 'results/leaderboard.json' },
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
const games = Number(values.games ?? (values.leaderboard ? RULES.minGames : 4));
const timeoutMs = Number(values.timeout ?? RULES.moveTimeoutMs);
if (!Number.isInteger(games) || games < 1) fail('--games must be a whole number ≥ 1');
if (!(timeoutMs > 0)) fail('--timeout must be a number of milliseconds');
// Leaderboard runs must use the standard rules so results stay comparable.
if (values.leaderboard && timeoutMs !== RULES.moveTimeoutMs) fail(`leaderboard runs use the ${RULES.moveTimeoutMs} ms move limit`);
const opponents: OpponentId[] = values.opponent === 'all' ? [...OPPONENTS] : values.opponent!.split(',').map((o) => (isOpponentId(o) ? o : fail(`unknown opponent ${o}; one of ${OPPONENTS.join(', ')}, or all`)));
if (values.leaderboard && opponents.length !== RULES.opponents.length) fail('leaderboard runs play every opponent');
if (values.leaderboard && games % RULES.minGames !== 0) fail(`leaderboard runs play a multiple of ${RULES.minGames} games per opponent`);

const known = attempt(() => loadPool(values['players-file']!));
function endpointFromArgs(): Player {
  const kind = values.kind ?? 'decision';
  if (!isModelKind(kind)) return fail('--kind must be decision, chat or rules');
  return endpointPlayer({ id: 'endpoint', name: values.name ?? values.endpoint!, kind, url: values.endpoint!, token: process.env.BENCH_ENDPOINT_TOKEN });
}
const findPlayer = (name: string): Player => attempt(() => resolvePlayer(name, known));
let parallel = 4;
function setParallel(players: Player[]) {
  parallel = Number(values.parallel ?? defaultParallel(players));
  if (!Number.isInteger(parallel) || parallel < 1) fail('--parallel must be a whole number ≥ 1');
}

const colorOf = (i: number) => (setupFor(i).model === 0 ? 'White' : 'Black');
const line = (r: GameResult) =>
  `${r.opponent.padEnd(7)} game ${String(r.game + 1).padStart(2)} as ${r.color.padEnd(5)}: ${r.outcome.padEnd(4)} (${r.termination}, ${r.plies} moves, ${r.materialLead >= 0 ? '+' : ''}${r.materialLead}), ` +
  `fallbacks ${r.fallbacks}/${r.modelMoves}${r.answered ? `, ${Math.round(r.latencyMsSum / r.answered)} ms` : ''}`;

async function playAll(player: Player): Promise<PlayedRecord[]> {
  const out: PlayedRecord[] = [];
  for (const opponent of opponents) {
    out.push(
      ...(await inBatches(games, parallel, async (i) => {
        const r = await playOne(player, opponent, i, { timeoutMs });
        console.log(`  ${line(r.result)}`);
        return r;
      })),
    );
  }
  return out;
}

const summaryLine = (e: LeaderboardEntry) =>
  `score ${e.scorePct}% ± ${(1.96 * e.stdErrorPct).toFixed(1)} (${opponents.map((o) => `${o} ${e.vs[o]?.scorePct ?? '–'}%`).join(', ')}), ` +
  `W/D/L ${e.winPct}/${e.drawPct}/${e.lossPct}%, fallbacks ${e.fallbackPct}% (invalid ${e.invalidPct}%), latency ${e.meanLatencyMs ?? '–'} ms, $${e.costPerGame}/game`;

async function warm(player: Player): Promise<string | null> {
  const problem = await readiness(player, timeoutMs);
  if (!problem && player.warmUp) console.log(`  warm: ${player.name} answers in time`);
  return problem;
}

const recordings = (played: PlayedRecord[]): Recording[] => played.map((p) => p.recording);

if (values.leaderboard) {
  const everyone = values.players === 'all';
  const pool = everyone ? known : values.players!.split(',').map(findPlayer);
  setParallel(pool);
  const outDir = dirname(values.out!);
  const gamesDir = join(outDir, 'games');
  console.log(`leaderboard: ${pool.length} players × ${opponents.length} opponents × ${games} games, ${RULES.maxPlies}-move cap, ${timeoutMs} ms per move`);
  const entries: LeaderboardEntry[] = [];
  const skipped: Leaderboard['skipped'] = [];
  if (everyone) {
    rmSync(gamesDir, { recursive: true, force: true });
  } else {
    // Keep the other players' rows, if they were played under the same rules.
    const previous = existsSync(values.out!) ? (JSON.parse(readFileSync(values.out!, 'utf8')) as Leaderboard) : null;
    const same = previous && previous.benchVersion === BENCH_VERSION && JSON.stringify(previous.settings) === JSON.stringify({ gamesPerOpponent: games, opponents, maxPlies: RULES.maxPlies, moveTimeoutMs: timeoutMs });
    if (previous && !same) {
      console.log(`  ${values.out} was played under other rules or another bench version: it is replaced`);
      rmSync(gamesDir, { recursive: true, force: true });
    }
    const running = new Set(pool.map((p) => p.id));
    if (same) {
      entries.push(...previous.entries.filter((e) => !running.has(e.player)));
      skipped.push(...previous.skipped.filter((s) => !running.has(s.player)));
    }
  }
  const write = () => {
    const board: Leaderboard = {
      generatedAt: new Date().toISOString(),
      benchVersion: BENCH_VERSION,
      settings: { gamesPerOpponent: games, opponents, maxPlies: RULES.maxPlies, moveTimeoutMs: timeoutMs },
      entries: rank(entries),
      skipped,
    };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(values.out!, `${JSON.stringify(board, null, 2)}\n`);
    writeReport(outDir);
    return board;
  };
  const skip = (player: Player, reason: string) => {
    console.log(`  skipped: ${reason}`);
    skipped.push({ player: player.id, reason });
    rmSync(join(gamesDir, player.id), { recursive: true, force: true });
    write();
  };
  for (const player of pool) {
    console.log(`\n${player.name} (${player.id})`);
    const problem = await warm(player);
    if (problem) {
      skip(player, problem);
      continue;
    }
    let played: PlayedRecord[];
    try {
      played = await playAll(player);
    } catch (err) {
      if (!(err instanceof PlayerFailedError)) throw err;
      skip(player, err.message);
      continue;
    }
    const entry = summarize(player, played.map((p) => p.result));
    console.log(`  ${summaryLine(entry)}`);
    entries.push(entry);
    writeGames(join(gamesDir, player.id), recordings(played));
    write(); // after every player, so an interrupted run keeps its results
  }
  const board = write();
  console.log('');
  for (const e of board.entries) console.log(`${e.name.padEnd(20)} ${summaryLine(e)}`);
  for (const s of board.skipped) console.log(`${s.player.padEnd(20)} skipped: ${s.reason}`);
  console.log(`\nwrote ${values.out}, ${join(outDir, 'LEADERBOARD.md')} and the games in ${gamesDir}`);
} else {
  const name = positionals[0] ?? values.player ?? modelsFromEnv()[0];
  const player = values.endpoint
    ? endpointFromArgs()
    : name
      ? findPlayer(name)
      : canAsk()
        ? (await pickPlayers(1, known))[0]
        : fail(`name a model (provider:model, e.g. ollama:llama3.1:8b), a player (${known.map((p) => p.id).join(', ')}) or an --endpoint, or set MODELS in .env`);
  setParallel([player]);
  console.log(`bench ${player.name}: ${opponents.join(', ')} × ${games} games (game 1 is ${setupFor(0).opening.name} as ${colorOf(0)}), ${timeoutMs} ms per move`);
  const problem = await warm(player);
  if (problem) fail(`${player.name}: ${problem}`);
  const played = await playAll(player).catch((err: Error) => fail(err.message));
  if (values.record) {
    writeGames(join(values.record, player.id), recordings(played));
    console.log(`recorded ${played.length} games to ${join(values.record, player.id)}`);
  }
  const entry = summarize(player, played.map((p) => p.result));
  console.log(`\n${player.name}: ${summaryLine(entry)}`);
}
