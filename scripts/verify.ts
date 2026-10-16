// Replays the committed games (results/games/, results/versus-games/) and checks they reproduce the published numbers.
// Run: npm run verify [-- --dir results]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BENCH_VERSION, RULES, summarize, type Leaderboard } from '../src/leaderboard.ts';
import { BASELINES } from '../src/players.ts';
import { checkGames } from '../src/recording.ts';
import { renderMarkdown } from '../src/report.ts';
import { pairFile, pairings, readPair, renderVersusMarkdown, replayPair, summarizeVersus, toPgn, type MatchGame, type Versus } from '../src/versus.ts';

export type Verification = { status: 'verified' | 'empty'; games: number } | { error: string };

/** A missing file passes. */
const sameAs = (path: string, rendered: string): boolean => !existsSync(path) || readFileSync(path, 'utf8') === rendered;

export async function verifyResults(dir: string): Promise<Verification> {
  const path = join(dir, 'leaderboard.json');
  if (!existsSync(path)) return { status: 'empty', games: 0 };
  const board = JSON.parse(readFileSync(path, 'utf8')) as Leaderboard;
  const s = board.settings;
  if (board.benchVersion !== BENCH_VERSION) return { error: `the results are from bench version ${board.benchVersion}, the current one is ${BENCH_VERSION}: re-run npm run leaderboard` };
  if (s.maxPlies !== RULES.maxPlies || s.moveTimeoutMs !== RULES.moveTimeoutMs || String(s.opponents) !== String(RULES.opponents)) return { error: 'the results were played under other rules' };
  const counts = Object.fromEntries(RULES.opponents.map((o) => [o, s.gamesPerOpponent]));
  const rules = { ...RULES, minGames: 1 };
  let games = 0;
  for (const entry of board.entries) {
    const folder = join(dir, 'games', entry.player);
    if (!existsSync(folder)) return { error: `${entry.player}: no games in ${folder}` };
    const checked = await checkGames(folder, counts, { rules });
    if ('error' in checked) return { error: `${entry.player}: ${checked.error}` };
    const replayed = summarize({ id: entry.player, name: entry.name, kind: entry.kind }, checked.results);
    if (JSON.stringify(replayed) !== JSON.stringify(entry)) return { error: `${entry.player}: the games replay to other numbers than the leaderboard shows` };
    games += checked.results.length;
  }
  if (!sameAs(join(dir, 'LEADERBOARD.md'), renderMarkdown(board))) return { error: 'LEADERBOARD.md does not match leaderboard.json: re-run npm run leaderboard' };
  return { status: 'verified', games };
}

export async function verifyVersus(dir: string): Promise<Verification> {
  const path = join(dir, 'versus.json');
  if (!existsSync(path)) return { status: 'empty', games: 0 };
  const v = JSON.parse(readFileSync(path, 'utf8')) as Versus;
  if (v.benchVersion !== BENCH_VERSION) return { error: `versus.json is from bench version ${v.benchVersion}, the current one is ${BENCH_VERSION}: re-run npm run versus -- --players all` };
  if (v.complete !== true) return { error: 'versus.json is from a run that did not finish: resume it (--resume)' };
  if (v.settings?.maxPlies !== RULES.maxPlies || v.settings.moveTimeoutMs !== RULES.moveTimeoutMs) return { error: 'versus.json was played under other rules' };
  if (!Array.isArray(v.players) || new Set(v.players).size !== v.players.length || v.players.length < 2) return { error: 'versus.json does not list its players' };
  const entry = new Map(v.entries.map((e) => [e.player, e]));
  if (entry.size !== v.players.length || v.players.some((id) => !entry.has(id))) return { error: 'versus.json lists other players than it rates' };
  for (const b of BASELINES) if (entry.has(b.id) && (entry.get(b.id)!.kind !== 'rules' || entry.get(b.id)!.name !== b.name)) return { error: `${b.id} is a built-in baseline, but versus.json shows it as something else` };
  const gamesDir = join(dir, 'versus-games');
  const pairs = pairings(v.players);
  const expected = new Set(pairs.map(([a, b]) => pairFile(a, b)));
  const stray = existsSync(gamesDir) ? readdirSync(gamesDir).filter((f) => !expected.has(f)) : [];
  if (stray.length) return { error: `unexpected files in ${gamesDir}: ${stray.join(', ')}` };
  const games: MatchGame[] = [];
  for (const [a, b] of pairs) {
    const rec = readPair(gamesDir, a, b);
    if (!rec) return { error: `${a} vs ${b}: no games in ${join(gamesDir, pairFile(a, b))}` };
    if (String(rec.players) !== String([a, b]) || JSON.stringify(rec.settings) !== JSON.stringify(v.settings)) return { error: `${pairFile(a, b)} holds another pair or other settings` };
    try {
      games.push(...(await replayPair(rec)));
    } catch (err) {
      return { error: `${a} vs ${b}: ${(err as Error).message}` };
    }
  }
  const players = v.players.map((id) => ({ id, name: entry.get(id)!.name, kind: entry.get(id)!.kind }));
  const replayed = summarizeVersus(players, games);
  if (JSON.stringify(replayed.entries) !== JSON.stringify(v.entries) || JSON.stringify(replayed.headToHead) !== JSON.stringify(v.headToHead)) {
    return { error: 'the versus games replay to other numbers than versus.json shows' };
  }
  if (!sameAs(join(dir, 'VERSUS.md'), renderVersusMarkdown(v))) return { error: 'VERSUS.md does not match versus.json' };
  if (!sameAs(join(dir, 'versus.pgn'), toPgn(games, Object.fromEntries(players.map((p) => [p.id, p.name]))))) return { error: 'versus.pgn does not hold the recorded games' };
  return { status: 'verified', games: games.length };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const { values } = parseArgs({ options: { dir: { type: 'string', default: 'results' } } });
  for (const [what, check] of [
    ['leaderboard', verifyResults],
    ['versus', verifyVersus],
  ] as const) {
    const v = await check(values.dir!);
    if ('error' in v) {
      console.error(`REFUSED (${what}): ${v.error}`);
      process.exit(1);
    }
    if (v.status === 'empty') console.log(`no ${what} results in ${values.dir}`);
    else console.log(`verified: ${v.games} ${what} games replay to its numbers`);
  }
}
