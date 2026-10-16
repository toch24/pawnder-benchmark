import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyResults, verifyVersus } from '../scripts/verify.ts';
import { OPPONENTS } from '../src/chess/engine.ts';
import { BENCH_VERSION, RULES, summarize, type GameResult, type Leaderboard } from '../src/leaderboard.ts';
import { BASELINES } from '../src/players.ts';
import { writeGames, type Recording } from '../src/recording.ts';
import { playOne } from '../src/run.ts';
import { pairFile, pairings, pairRecording, playMatch, renderVersusMarkdown, summarizeVersus, toPgn, writePair, type MatchGame, type PairRecording, type Versus } from '../src/versus.ts';

const facts = BASELINES.find((p) => p.id === 'facts')!;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A results folder as npm run leaderboard writes it: one player, one game against each opponent. */
async function results(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'chess-results-'));
  dirs.push(dir);
  const recordings: Recording[] = [];
  const games: GameResult[] = [];
  for (const opponent of OPPONENTS) {
    const { result, recording } = await playOne(facts, opponent, 0);
    games.push(result);
    recordings.push(recording);
  }
  writeGames(join(dir, 'games', facts.id), recordings);
  const board: Leaderboard = {
    generatedAt: 'now',
    benchVersion: BENCH_VERSION,
    settings: { gamesPerOpponent: 1, opponents: [...OPPONENTS], maxPlies: RULES.maxPlies, moveTimeoutMs: RULES.moveTimeoutMs },
    entries: [summarize(facts, games)],
    skipped: [],
  };
  writeFileSync(join(dir, 'leaderboard.json'), JSON.stringify(board));
  return dir;
}

const edit = (dir: string, change: (b: Leaderboard) => void) => {
  const board = JSON.parse(readFileSync(join(dir, 'leaderboard.json'), 'utf8')) as Leaderboard;
  change(board);
  writeFileSync(join(dir, 'leaderboard.json'), JSON.stringify(board));
};

describe('verifying the results', () => {
  it('replays a public run to its numbers, and catches numbers its games did not earn', async () => {
    const dir = await results();
    expect(await verifyResults(dir)).toEqual({ status: 'verified', games: 3 });
    edit(dir, (b) => (b.entries[0].scorePct += 10));
    expect(await verifyResults(dir)).toMatchObject({ error: /other numbers/ });
  });

  it('refuses games that are misnumbered, broken or joined by other files', async () => {
    const dir = await results();
    const folder = join(dir, 'games', facts.id);
    const random = readFileSync(join(folder, 'random-01.json.gz'));
    writeFileSync(join(folder, 'random-01.json.gz'), readFileSync(join(folder, 'minimax-01.json.gz')));
    expect(await verifyResults(dir)).toMatchObject({ error: /random-01.json.gz holds game 0 against minimax/ });
    writeFileSync(join(folder, 'random-01.json.gz'), 'not gzip');
    expect(await verifyResults(dir)).toMatchObject({ error: /random-01.json.gz: / });
    rmSync(join(folder, 'random-01.json.gz'));
    writeFileSync(join(folder, 'random-02.json.gz'), random);
    expect(await verifyResults(dir)).toMatchObject({ error: /random-02.json.gz: expected random-01.json.gz/ });
    rmSync(join(folder, 'random-02.json.gz'));
    writeFileSync(join(folder, 'random-01.json.gz'), random);
    writeFileSync(join(folder, 'notes.txt'), 'hi');
    expect(await verifyResults(dir)).toMatchObject({ error: /unexpected files: notes.txt/ });
  });

  it('refuses missing games and results from another version', async () => {
    const dir = await results();
    rmSync(join(dir, 'games'), { recursive: true });
    expect(await verifyResults(dir)).toMatchObject({ error: /no games/ });
    edit(dir, (b) => (b.benchVersion = BENCH_VERSION - 1));
    expect(await verifyResults(dir)).toMatchObject({ error: /bench version/ });
  });
});

describe('verifying the versus results', () => {
  const ids = ['random', 'facts', 'greedy'];
  const players = ids.map((id) => BASELINES.find((p) => p.id === id)!);
  const settings = { gamesPerPair: 2, maxPlies: RULES.maxPlies, moveTimeoutMs: RULES.moveTimeoutMs };

  /** A results folder as npm run versus -- --players all writes it, for three baselines and two games a pair. */
  async function versusResults(): Promise<{ dir: string; pairs: PairRecording[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'chess-versus-'));
    dirs.push(dir);
    const all: MatchGame[] = [];
    const pairs: PairRecording[] = [];
    for (const [a, b] of pairings(players)) {
      const games = [await playMatch(a, b, 0), await playMatch(a, b, 1)];
      all.push(...games);
      const rec = pairRecording(a.id, b.id, games, settings);
      pairs.push(rec);
      writePair(join(dir, 'versus-games'), rec);
    }
    const v: Versus = { generatedAt: 'now', benchVersion: BENCH_VERSION, complete: true, players: ids, settings, ...summarizeVersus(players, all), skipped: [] };
    writeFileSync(join(dir, 'versus.json'), JSON.stringify(v));
    writeFileSync(join(dir, 'VERSUS.md'), renderVersusMarkdown(v));
    writeFileSync(join(dir, 'versus.pgn'), toPgn(all, Object.fromEntries(players.map((p) => [p.id, p.name]))));
    return { dir, pairs };
  }
  const editVersus = (dir: string, change: (v: Versus) => void) => {
    const v = JSON.parse(readFileSync(join(dir, 'versus.json'), 'utf8')) as Versus;
    change(v);
    writeFileSync(join(dir, 'versus.json'), JSON.stringify(v));
  };

  it('replays every pair to the ratings and the grid, and catches numbers the games did not earn', async () => {
    const { dir } = await versusResults();
    expect(await verifyVersus(dir)).toEqual({ status: 'verified', games: 6 });
    editVersus(dir, (v) => (v.entries[0].scorePct += 1));
    expect(await verifyVersus(dir)).toMatchObject({ error: /other numbers/ });
  });

  it("checks the baselines' moves against their rules, and the fallbacks against the bench's", async () => {
    const { dir, pairs } = await versusResults();
    const rec = structuredClone(pairs[0]);
    // Say one of the random mover's moves was a fallback: the fallback would have been another move.
    const turns = rec.games[0].turns.white;
    turns[0] = { source: 'fallback', reason: 'timeout' };
    writePair(join(dir, 'versus-games'), rec);
    expect(await verifyVersus(dir)).toMatchObject({ error: /random vs facts: game 1: move 1 is \w+, but the fallback plays \w+/ });
    const swapped = structuredClone(pairs[2]);
    // greedy vs ... : replace greedy's first move by another legal one.
    swapped.games[0].plies[0] = swapped.games[0].plies[0] === 'a2a3' ? 'a2a4' : 'a2a3';
    writePair(join(dir, 'versus-games'), pairs[0]);
    writePair(join(dir, 'versus-games'), swapped);
    expect(await verifyVersus(dir)).toMatchObject({ error: /facts vs greedy: game 1: move 1 is a2a\d, but facts plays/ });
  });

  it('refuses an unfinished run, missing games and stale reports', async () => {
    const { dir } = await versusResults();
    writeFileSync(join(dir, 'VERSUS.md'), 'old');
    expect(await verifyVersus(dir)).toMatchObject({ error: /VERSUS.md does not match/ });
    editVersus(dir, (v) => (v.complete = false));
    expect(await verifyVersus(dir)).toMatchObject({ error: /did not finish/ });
    editVersus(dir, (v) => ((v.complete = true), (v.benchVersion = BENCH_VERSION - 1)));
    expect(await verifyVersus(dir)).toMatchObject({ error: /bench version/ });
    editVersus(dir, (v) => (v.benchVersion = BENCH_VERSION));
    rmSync(join(dir, 'versus-games', pairFile('random', 'facts')));
    expect(await verifyVersus(dir)).toMatchObject({ error: /random vs facts: no games/ });
  });
});
