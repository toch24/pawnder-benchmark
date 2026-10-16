import { describe, expect, it } from 'vitest';
import { opponentScore, rank, summarize, tooCloseToCall, type GameResult } from '../src/leaderboard.ts';
import { renderMarkdown } from '../src/report.ts';

const game = (opponent: GameResult['opponent'], outcome: GameResult['outcome'], extra: Partial<GameResult> = {}): GameResult => ({
  game: 0,
  opponent,
  color: 'white',
  outcome,
  termination: outcome === 'draw' ? 'stalemate' : 'checkmate',
  plies: 40,
  modelMoves: 20,
  fallbacks: 0,
  invalid: 0,
  timeouts: 0,
  answered: 20,
  latencyMsSum: 2000,
  cost: 0.01,
  materialLead: 0,
  ...extra,
});

describe('percentages', () => {
  it('scores a win 1 and a draw ½', () => {
    const s = opponentScore([game('random', 'win'), game('random', 'win'), game('random', 'draw'), game('random', 'loss')]);
    expect(s).toMatchObject({ games: 4, wins: 2, draws: 1, losses: 1, winPct: 50, drawPct: 25, lossPct: 25, scorePct: 62.5 });
    // Scores 1, 1, ½, 0, plus a win and a loss for the error: sample sd 0.492, over √6.
    expect(s.stdErrorPct).toBeCloseTo(20.1, 1);
    // Every game alike still leaves a margin.
    expect(opponentScore(Array.from({ length: 24 }, () => game('random', 'win'))).stdErrorPct).toBeGreaterThan(3);
  });

  it('averages the opponents, so each counts the same', () => {
    const games = [
      ...Array.from({ length: 4 }, () => game('random', 'win')),
      ...Array.from({ length: 2 }, () => game('greedy', 'draw')),
      game('minimax', 'loss', { fallbacks: 5, invalid: 2, answered: 15 }),
    ];
    const e = summarize({ id: 'm', name: 'M', kind: 'decision' }, games);
    expect(e.scorePct).toBe(50); // (100 + 50 + 0) / 3
    expect(e.vs.random!.scorePct).toBe(100);
    expect(e.games).toBe(7);
    expect(e.fallbackPct).toBe(3.6); // 5 of 140 moves
    expect(e.invalidPct).toBe(1.4);
    expect(e.meanLatencyMs).toBe(Math.round((7 * 2000) / (6 * 20 + 15)));
    expect(e.costPerGame).toBe(0.01);
  });

  it('ranks by score, then fewer fallbacks, and knows when it is too close to call', () => {
    const a = summarize({ id: 'a', name: 'A', kind: 'decision' }, [game('random', 'win'), game('random', 'loss')]);
    const b = summarize({ id: 'b', name: 'B', kind: 'decision' }, [game('random', 'win'), game('random', 'win')]);
    const c = summarize({ id: 'c', name: 'C', kind: 'decision' }, [game('random', 'win', { fallbacks: 3 }), game('random', 'win')]);
    expect(rank([a, c, b]).map((e) => e.player)).toEqual(['b', 'c', 'a']);
    expect(tooCloseToCall(a, b)).toBe(true); // two games each prove nothing
    const many = (outcome: GameResult['outcome']) => summarize({ id: outcome, name: outcome, kind: 'decision' }, Array.from({ length: 40 }, (_, i) => game('random', i % 4 ? outcome : 'draw')));
    expect(tooCloseToCall(many('win'), many('loss'))).toBe(false);
  });

  it('renders a table that ranks models and not rules', () => {
    const model = summarize({ id: 'm', name: 'Model', kind: 'chat' }, [game('random', 'win')]);
    const rules = summarize({ id: 'r', name: 'Rules', kind: 'rules' }, [game('random', 'win'), game('random', 'win')]);
    const md = renderMarkdown({ generatedAt: 'now', benchVersion: 1, settings: { gamesPerOpponent: 1, opponents: ['random'], maxPlies: 200, moveTimeoutMs: 10_000 }, entries: [rules, model], skipped: [{ player: 'x', reason: 'down' }] });
    expect(md).toMatch(/\| – \| Rules \| rules \| 100\.0 ± 49\.0 \| 100\.0 \| – \| – \|/);
    expect(md).toMatch(/\| 1 \| Model \| chat \|/);
    expect(md).toMatch(/x skipped: down/);
  });
});
