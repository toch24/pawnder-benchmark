import { uci, type Move } from './chess/board.ts';
import type { OpponentId } from './chess/engine.ts';
import { fallbackMove, playGame, setupFor, type Game } from './game.ts';
import { RULES, type BenchRules, type GameResult } from './leaderboard.ts';
import type { Player } from './players.ts';
import { buildRequest, MOVE_QUESTION } from './question.ts';
import { gameResult, recordingOf, type Recording, type Turn } from './recording.ts';

export interface PlayedRecord {
  result: GameResult;
  recording: Recording;
}

/** Rejects on abort, so a player that ignores `signal` can't hold up the game. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('timeout'));
    const onAbort = () => reject(new Error('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Consecutive failed calls (after postJson's retries) that stop a player, so an outage isn't scored as its play.
 * Timeouts and invalid answers are the model's own and don't count.
 */
export const MAX_FAILED_CALLS = 5;

export class PlayerFailedError extends Error {
  readonly player: string;
  constructor(player: string, last: string) {
    super(`${player} failed ${MAX_FAILED_CALLS} calls in a row (last: ${last}); its games were stopped so random fallback moves don't count as its play`);
    this.player = player;
  }
}

/** Shared across a player's parallel games. */
const failures = new WeakMap<Player, { count: number; last: string }>();

/** Late, failed or invalid answers become the fallback move. */
export async function askPlayer(player: Player, game: Game, timeoutMs: number, turns: Turn[], opponent?: string): Promise<Move> {
  const failed = failures.get(player);
  if (failed && failed.count >= MAX_FAILED_CALLS) throw new PlayerFailedError(player.id, failed.last);
  const request = buildRequest(game, opponent);
  const legal = game.pos.moves();
  const signal = AbortSignal.timeout(timeoutMs);
  const t0 = performance.now();
  try {
    const res = await bounded(player.decide(request, game, signal), signal);
    failures.delete(player);
    const latencyMs = Math.round(performance.now() - t0);
    const costUsd = typeof res.costUsd === 'number' ? res.costUsd : null;
    const choice = res.answers?.[MOVE_QUESTION]?.choice;
    const move = typeof choice === 'string' ? legal.find((m) => uci(m) === choice) : undefined;
    if (move) {
      turns.push({ source: 'model', latencyMs, costUsd });
      return move;
    }
    turns.push({ source: 'fallback', reason: 'invalid', latencyMs, costUsd, detail: String(choice).slice(0, 40) });
  } catch (err) {
    const timedOut = signal.aborted;
    const detail = (err as Error).message.slice(0, 120);
    turns.push({ source: 'fallback', reason: timedOut ? 'timeout' : 'error', ...(timedOut ? {} : { detail }) });
    if (!timedOut) {
      const count = (failures.get(player)?.count ?? 0) + 1;
      failures.set(player, { count, last: detail });
      if (count >= MAX_FAILED_CALLS) throw new PlayerFailedError(player.id, detail);
    }
  }
  return fallbackMove(game);
}

export const resetFailures = (player: Player): void => {
  failures.delete(player);
};

export interface PlayOptions {
  timeoutMs?: number;
  rules?: BenchRules;
}

export async function playOne(player: Player, opponent: OpponentId, index: number, opts: PlayOptions = {}): Promise<PlayedRecord> {
  const rules = opts.rules ?? RULES;
  const timeoutMs = opts.timeoutMs ?? rules.moveTimeoutMs;
  const turns: Turn[] = [];
  const played = await playGame(setupFor(index), opponent, rules.maxPlies, (game) => askPlayer(player, game, timeoutMs, turns));
  const recording = recordingOf(played, player.id, opponent, turns);
  return { result: gameResult(recording, played), recording };
}

/** Results keep job order. After a failure no new job starts; running ones finish, then the first error is thrown. */
export async function inBatches<T>(count: number, parallel: number, job: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(count);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < count) {
      const i = next++;
      try {
        out[i] = await job(i);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, count)) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return out;
}
