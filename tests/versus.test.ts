import { describe, expect, it } from 'vitest';
import { uci } from '../src/chess/board.ts';
import { BASELINES, type Player } from '../src/players.ts';
import { MOVE_QUESTION } from '../src/question.ts';
import { fitRatings, pairings, playMatch, renderVersusMarkdown, summarizeVersus, toPgn, VERSUS_OPPONENT, type MatchGame } from '../src/versus.ts';

const baseline = (id: string) => BASELINES.find((p) => p.id === id)!;

/** A finished game between a and b with the given points for White. */
const game = (white: string, black: string, whitePoints: number, n = 0): MatchGame => {
  const side = (player: string, points: number) => ({ player, points, moves: 10, fallbacks: 0, invalid: 0, timeouts: 0, answered: 10, latencyMsSum: 100, cost: 0, turns: [] });
  return { game: n, opening: 'Italian Game', white: side(white, whitePoints), black: side(black, 1 - whitePoints), result: whitePoints === 1 ? '1-0' : whitePoints === 0 ? '0-1' : '1/2-1/2', termination: 'checkmate', plies: 20, san: ['e4', 'e5'], uci: [] };
};

describe('playing two players against each other', () => {
  it('gives each player its side and alternates colors', async () => {
    const asked: string[] = [];
    const spy = (id: string): Player => ({
      id,
      name: id,
      kind: 'decision',
      decide: async (req, g) => {
        asked.push(`${id}:${g.pos.turn === 0 ? 'w' : 'b'}`);
        expect(req.questions[MOVE_QUESTION].instructions).toContain(VERSUS_OPPONENT);
        return { answers: { [MOVE_QUESTION]: { type: 'choice', choice: uci(g.pos.moves()[0]) } } };
      },
    });
    const even = await playMatch(spy('a'), spy('b'), 0);
    expect([even.white.player, even.black.player]).toEqual(['a', 'b']);
    expect(new Set(asked)).toEqual(new Set(['a:w', 'b:b']));
    asked.length = 0;
    const odd = await playMatch(spy('a'), spy('b'), 1);
    expect([odd.white.player, odd.black.player]).toEqual(['b', 'a']);
    expect(new Set(asked)).toEqual(new Set(['a:b', 'b:w']));
    expect(even.white.points + even.black.points).toBe(1);
    expect(even.white.moves + even.black.moves).toBe(even.plies);
  });

  it('counts fallbacks per side', async () => {
    const broken: Player = { id: 'broken', name: 'Broken', kind: 'chat', decide: async () => ({ answers: {} }) };
    const g = await playMatch(broken, baseline('greedy'), 0);
    expect(g.white.fallbacks).toBe(g.white.moves);
    expect(g.white.invalid).toBe(g.white.moves);
    expect(g.black.fallbacks).toBe(0);
  });

  it('lets timers and network replies of other games run while built-in players play', async () => {
    let finished = false;
    const game = playMatch(baseline('greedy'), baseline('minimax'), 0).then(() => (finished = true));
    const timerFiredBeforeEnd = await new Promise<boolean>((resolve) => setTimeout(() => resolve(!finished), 20));
    await game;
    expect(timerFiredBeforeEnd).toBe(true);
  });

  it('lets the stronger rule win', async () => {
    const results = await Promise.all([0, 1, 2, 3].map((i) => playMatch(baseline('greedy'), baseline('random'), i)));
    const greedyPoints = results.reduce((a, g) => a + (g.white.player === 'greedy' ? g.white.points : g.black.points), 0);
    expect(greedyPoints).toBeGreaterThanOrEqual(3.5);
  });
});

describe('ratings', () => {
  it('pairs every player with every other once', () => {
    expect(pairings(['a', 'b', 'c'])).toEqual([['a', 'b'], ['a', 'c'], ['b', 'c']]);
  });

  it('rates equal players equally and averages 1500', () => {
    const r = fitRatings([game('a', 'b', 1), game('b', 'a', 1), game('a', 'b', 0.5)], ['a', 'b']);
    expect(r.a).toBeCloseTo(1500, 5);
    expect(r.b).toBeCloseTo(1500, 5);
  });

  it('orders a chain of players, and keeps a player who never scored finite', () => {
    const games = [...Array.from({ length: 10 }, (_, i) => game('a', 'b', i < 8 ? 1 : 0.5)), ...Array.from({ length: 10 }, () => game('b', 'c', 1))];
    const r = fitRatings(games, ['a', 'b', 'c']);
    expect(r.a).toBeGreaterThan(r.b);
    expect(r.b).toBeGreaterThan(r.c);
    expect(Number.isFinite(r.c)).toBe(true);
    expect((r.a + r.b + r.c) / 3).toBeCloseTo(1500, 5);
  });

  it('matches the Elo formula for one pair', () => {
    // 75% score with 1 virtual draw: (30 + 0.5) of 41 games.
    const games = Array.from({ length: 40 }, (_, i) => game('a', 'b', i < 30 ? 1 : 0));
    const r = fitRatings(games, ['a', 'b']);
    const share = 30.5 / 41;
    expect(r.a - r.b).toBeCloseTo(400 * Math.log10(share / (1 - share)), 3);
  });

  it('summarizes, renders and exports', () => {
    const players = [
      { id: 'a', name: 'A', kind: 'decision' as const },
      { id: 'b', name: 'B', kind: 'chat' as const },
    ];
    const games = [game('a', 'b', 1, 0), game('b', 'a', 0.5, 1)];
    const s = summarizeVersus(players, games);
    expect(s.entries.map((e) => e.player)).toEqual(['a', 'b']);
    expect(s.entries[0]).toMatchObject({ games: 2, scorePct: 75, winPct: 50, drawPct: 50, lossPct: 0 });
    expect(s.headToHead.a.b).toEqual({ scorePct: 75, games: 2 });
    const md = renderVersusMarkdown({ generatedAt: 'now', benchVersion: 1, complete: true, players: ['a', 'b'], settings: { gamesPerPair: 2, maxPlies: 200, moveTimeoutMs: 10_000 }, ...s, skipped: [] });
    expect(md).toMatch(/\| 1 \| A \| decision \| \d+ ± \d+ \| 75\.0 \|/);
    expect(md).toMatch(/\| A \| – \| 75\.0 \|/);
    const pgn = toPgn(games, { a: 'A', b: 'B "quoted"' });
    expect(pgn).toContain('[White "A"]\n[Black "B \\"quoted\\""]\n[Result "1-0"]');
    expect(pgn).toContain('1. e4 e5 1-0');
  });
});
