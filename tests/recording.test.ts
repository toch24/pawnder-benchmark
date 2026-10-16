import { describe, expect, it } from 'vitest';
import { RULES } from '../src/leaderboard.ts';
import { BASELINES } from '../src/players.ts';
import { verifyGame, type Recording } from '../src/recording.ts';
import { playOne } from '../src/run.ts';

const facts = BASELINES.find((p) => p.id === 'facts')!;
const copy = (r: Recording): Recording => JSON.parse(JSON.stringify(r));

describe('replaying a recorded game', () => {
  it('gives the same result as the game', async () => {
    for (const [opponent, game] of [['random', 0], ['greedy', 3], ['minimax', 1]] as const) {
      const { result, recording } = await playOne(facts, opponent, game);
      const verdict = await verifyGame(recording);
      expect(verdict).toEqual({ ok: true, result });
    }
  });

  it('refuses a recording that does not replay', async () => {
    const { recording } = await playOne(facts, 'greedy', 2);
    const expectError = async (rec: Recording, error: RegExp) => {
      const v = await verifyGame(rec);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toMatch(error);
    };

    // A model move the position does not allow.
    const illegal = copy(recording);
    illegal.plies[0] = 'e1e8';
    await expectError(illegal, /not legal/);

    // An opponent move its rule would not play: game 2 has the model as White, so ply 1 is the opponent's.
    const opponent = copy(recording);
    opponent.plies[1] = recording.plies[3];
    await expectError(opponent, /opponent plays|not legal|do not replay/);

    // A better result than the moves earned.
    const claimed = copy(recording);
    claimed.final = { outcome: recording.final.outcome === 'win' ? 'loss' : 'win', termination: 'checkmate' };
    await expectError(claimed, /recording claims/);

    // Stopping before the game is over.
    const short = copy(recording);
    short.plies = short.plies.slice(0, 10);
    await expectError(short, /stops at move|do not replay/);

    // Turns that do not match the model's moves.
    const turns = copy(recording);
    turns.turns.pop();
    await expectError(turns, /turns recorded/);

    // Impossible cost, another bench version, an opponent outside the rules.
    const cost = copy(recording);
    cost.turns[0].costUsd = -1;
    await expectError(cost, /impossible/);
    await expectError({ ...copy(recording), benchVersion: 0 }, /bench version/);
    expect((await verifyGame(recording, { ...RULES, opponents: ['random'] })).ok).toBe(false);
  });
});
