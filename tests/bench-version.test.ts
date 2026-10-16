import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OPPONENTS } from '../src/chess/engine.ts';
import { Game, OPENINGS, setupFor } from '../src/game.ts';
import { BENCH_VERSION, RULES } from '../src/leaderboard.ts';
import { BASELINES, type Player } from '../src/players.ts';
import { chatPrompt, SYSTEM_PROMPT } from '../src/providers.ts';
import { buildRequest, MOVE_QUESTION, type DecideRequest } from '../src/question.ts';
import { playOne } from '../src/run.ts';
import { VERSUS_OPPONENT } from '../src/versus.ts';

/**
 * Hashes everything results depend on: the rules, openings, every request of a few whole games (as JSON and as the
 * chat prompt), and the opponents' moves. When it fails, bump BENCH_VERSION and add the new fingerprint.
 */
const FINGERPRINT: Record<number, string> = {
  1: '1d660608abbd2d69b8527c3c93cd2e301a48c444ac2e5aec7b8dd9214799809e',
};

async function fingerprint(): Promise<string> {
  const h = createHash('sha256');
  h.update(JSON.stringify({ RULES, OPENINGS }));
  h.update(SYSTEM_PROMPT);
  h.update(JSON.stringify(buildRequest(new Game(setupFor(0)), VERSUS_OPPONENT)));
  const random = BASELINES.find((p) => p.id === 'random')!;
  const requests: DecideRequest[] = [];
  const recorder: Player = { ...random, decide: (req, game, signal) => (requests.push(req), random.decide(req, game, signal)) };
  for (const opponent of OPPONENTS) {
    for (const i of [0, 1]) h.update((await playOne(recorder, opponent, i)).recording.plies.join(' '));
  }
  for (const req of requests) h.update(JSON.stringify(req)).update(chatPrompt(req.state, req.questions[MOVE_QUESTION]));
  return h.digest('hex');
}

describe('bench version', () => {
  it('changes when the benchmark does', async () => {
    const now = await fingerprint();
    const hint =
      FINGERPRINT[BENCH_VERSION] === undefined
        ? `record this version's fingerprint: FINGERPRINT[${BENCH_VERSION}] = '${now}'`
        : `the benchmark changed: bump BENCH_VERSION and set FINGERPRINT[${BENCH_VERSION + 1}] = '${now}'`;
    expect(now, hint).toBe(FINGERPRINT[BENCH_VERSION]);
  });
});
