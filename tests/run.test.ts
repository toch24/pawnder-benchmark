import { describe, expect, it } from 'vitest';
import { uci } from '../src/chess/board.ts';
import type { Player } from '../src/players.ts';
import { MOVE_QUESTION } from '../src/question.ts';
import { verifyGame } from '../src/recording.ts';
import { inBatches, MAX_FAILED_CALLS, playOne, PlayerFailedError } from '../src/run.ts';

const player = (decide: Player['decide']): Player => ({ id: 'test', name: 'Test', kind: 'decision', decide });

describe('playing a player', () => {
  it('falls back on invalid answers, errors and timeouts, and the game still replays', async () => {
    let n = 0;
    const flaky = player(async (req, game, signal) => {
      n += 1;
      if (n % 4 === 1) return { answers: { [MOVE_QUESTION]: { type: 'choice', choice: 'not-a-move' } } };
      if (n % 4 === 2) throw new Error('boom');
      if (n % 4 === 3) return new Promise(() => {}); // never answers, ignores the signal
      return { answers: { [MOVE_QUESTION]: { type: 'choice', choice: Object.keys(req.questions[MOVE_QUESTION].criteria)[0] } }, costUsd: 0.001 };
    });
    const { result, recording } = await playOne(flaky, 'random', 0, { timeoutMs: 20 });
    expect(result.invalid).toBeGreaterThan(0);
    expect(result.timeouts).toBeGreaterThan(0);
    expect(recording.turns.some((t) => t.reason === 'error' && t.detail === 'boom')).toBe(true);
    expect(result.fallbacks).toBe(recording.turns.filter((t) => t.source === 'fallback').length);
    expect(result.cost).toBeCloseTo(0.001 * recording.turns.filter((t) => t.source === 'model').length);
    expect((await verifyGame(recording)).ok).toBe(true);
  });

  it('plays the model side only', async () => {
    const seen: string[] = [];
    const first = player(async (req, game) => {
      seen.push(game.pos.turn === game.setup.model ? 'model' : 'opponent');
      return { answers: { [MOVE_QUESTION]: { type: 'choice', choice: uci(game.pos.moves()[0]) } } };
    });
    const { result } = await playOne(first, 'greedy', 1);
    expect(new Set(seen)).toEqual(new Set(['model']));
    expect(result.color).toBe('black');
    expect(result.fallbacks).toBe(0);
  });

  it('stops a player whose calls keep failing, instead of playing random moves for it', async () => {
    let calls = 0;
    const down = player(async () => {
      calls += 1;
      throw new Error('HTTP 402: Insufficient credits');
    });
    const err = await playOne(down, 'random', 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlayerFailedError);
    expect((err as PlayerFailedError).message).toMatch(/test failed 5 calls in a row \(last: HTTP 402: Insufficient credits\)/);
    expect(calls).toBe(MAX_FAILED_CALLS);
    // The other games of the run stop at once.
    await expect(playOne(down, 'random', 1)).rejects.toBeInstanceOf(PlayerFailedError);
    expect(calls).toBe(MAX_FAILED_CALLS);
  });

  it('starts no new job after one fails, and lets the running ones finish', async () => {
    const started: number[] = [];
    let finished = 0;
    const run = inBatches(10, 2, async (i) => {
      started.push(i);
      if (i === 1) throw new Error('down');
      await new Promise((r) => setTimeout(r, 10));
      finished += 1;
      return i;
    });
    await expect(run).rejects.toThrow('down');
    expect(started).toEqual([0, 1]);
    expect(finished).toBe(1);
  });

  it('runs jobs a few at a time, in order', async () => {
    let running = 0;
    let most = 0;
    const out = await inBatches(10, 3, async (i) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(most).toBe(3);
  });
});
