// Recordings are checked by replay: the game number, the recorded model moves and the opponent's rule determine the
// whole game, so a recording can't claim a result its moves didn't earn.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { uci, type Move } from './chess/board.ts';
import { isOpponentId, type OpponentId } from './chess/engine.ts';
import { playGame, setupFor, type Outcome, type PlayedGame, type Termination } from './game.ts';
import { BENCH_VERSION, RULES, type BenchRules, type GameResult } from './leaderboard.ts';

export interface Turn {
  source: 'model' | 'fallback';
  reason?: 'timeout' | 'error' | 'invalid';
  latencyMs?: number;
  costUsd?: number | null;
  detail?: string;
}

export interface Recording {
  version: 1;
  benchVersion: number;
  player: string;
  opponent: OpponentId;
  game: number;
  plies: string[];
  turns: Turn[];
  final: { outcome: Outcome; termination: Termination };
}

export function recordingOf(played: PlayedGame, player: string, opponent: OpponentId, turns: Turn[]): Recording {
  return {
    version: 1,
    benchVersion: BENCH_VERSION,
    player,
    opponent,
    game: played.game.setup.index,
    plies: [...played.game.plies],
    turns,
    final: { outcome: played.outcome, termination: played.termination },
  };
}

export function gameResult(rec: Recording, played: PlayedGame): GameResult {
  const answered = rec.turns.filter((t) => typeof t.latencyMs === 'number');
  return {
    game: rec.game,
    opponent: rec.opponent,
    color: played.game.setup.model === 0 ? 'white' : 'black',
    outcome: played.outcome,
    termination: played.termination,
    plies: played.game.plies.length,
    modelMoves: rec.turns.length,
    fallbacks: rec.turns.filter((t) => t.source === 'fallback').length,
    invalid: rec.turns.filter((t) => t.reason === 'invalid').length,
    timeouts: rec.turns.filter((t) => t.reason === 'timeout').length,
    answered: answered.length,
    latencyMsSum: answered.reduce((a, t) => a + t.latencyMs!, 0),
    cost: rec.turns.reduce((a, t) => a + (typeof t.costUsd === 'number' ? t.costUsd : 0), 0),
    materialLead: played.game.materialLead(),
  };
}

export type Verdict = { ok: true; result: GameResult } | { ok: false; error: string };

/** Far above any real call. */
const MAX_CALL_USD = 1;
const MAX_CALL_MS = 10 * 60_000;

export async function verifyGame(rec: Recording, rules: BenchRules = RULES): Promise<Verdict> {
  const fail = (error: string): Verdict => ({ ok: false, error });
  if (rec?.version !== 1) return fail('not a version 1 recording');
  if (rec.benchVersion !== BENCH_VERSION) return fail(`recorded on bench version ${rec.benchVersion}, the current one is ${BENCH_VERSION}`);
  if (!isOpponentId(rec.opponent) || !rules.opponents.includes(rec.opponent)) return fail(`unknown opponent ${String(rec.opponent)}`);
  if (!Number.isInteger(rec.game) || rec.game < 0 || rec.game > 100_000) return fail('game must be a game number');
  if (!Array.isArray(rec.plies) || !rec.plies.every((p) => typeof p === 'string')) return fail('plies must be a list of moves');
  if (rec.plies.length > rules.maxPlies) return fail(`${rec.plies.length} moves is more than the ${rules.maxPlies}-move cap`);
  if (!Array.isArray(rec.turns)) return fail('turns must be a list');
  for (const t of rec.turns) {
    if (!t || (t.source !== 'model' && t.source !== 'fallback')) return fail('a turn must come from the model or a fallback');
    if (t.source === 'fallback' && !['timeout', 'error', 'invalid'].includes(t.reason!)) return fail('a fallback needs a reason');
    const within = (v: unknown, max: number) => v === undefined || v === null || (typeof v === 'number' && v >= 0 && v <= max);
    if (!within(t.latencyMs, MAX_CALL_MS) || !within(t.costUsd, MAX_CALL_USD)) return fail('a turn with a negative or impossible latency or cost');
  }

  let modelMoves = 0;
  let played: PlayedGame;
  try {
    played = await playGame(setupFor(rec.game), rec.opponent, rules.maxPlies, (game): Move => {
      const at = game.plies.length;
      // playGame recomputes the opponent's moves; they must match the recorded ones.
      for (let i = 0; i < at; i++) if (game.plies[i] !== rec.plies[i]) throw new Error(`move ${i + 1} is ${rec.plies[i]}, but the opponent plays ${game.plies[i]}`);
      const text = rec.plies[at];
      if (text === undefined) throw new Error(`the recording stops at move ${at + 1}, before the game is over`);
      const move = game.pos.moves().find((m) => uci(m) === text);
      if (!move) throw new Error(`move ${at + 1}, ${text}, is not legal`);
      modelMoves += 1;
      return move;
    });
  } catch (err) {
    return fail((err as Error).message);
  }
  const plies = played.game.plies;
  if (plies.length !== rec.plies.length || plies.some((p, i) => p !== rec.plies[i])) return fail('the moves do not replay to the recorded game');
  if (modelMoves !== rec.turns.length) return fail(`${rec.turns.length} turns recorded for ${modelMoves} model moves`);
  if (rec.final?.outcome !== played.outcome || rec.final.termination !== played.termination) {
    return fail(`the replay ends in a ${played.outcome} (${played.termination}); the recording claims ${rec.final?.outcome} (${rec.final?.termination})`);
  }
  return { ok: true, result: gameResult(rec, played) };
}

export const gameFile = (opponent: OpponentId, game: number): string => `${opponent}-${String(game + 1).padStart(2, '0')}.json.gz`;

export function writeGames(dir: string, recordings: Recording[]): void {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/\.json\.gz$/.test(f)) rmSync(join(dir, f));
  for (const rec of recordings) writeFileSync(join(dir, gameFile(rec.opponent, rec.game)), gzipSync(JSON.stringify(rec)));
}

/** A real recording is a few KB. */
const MAX_FILE_BYTES = 1 << 20;
const MAX_GAME_BYTES = 8 << 20;

/**
 * Each opponent needs exactly `counts[opponent]` games (≥ rules.minGames), numbered from 1 with no gaps, and nothing
 * else in the folder: each game number fixes an opening and a color, so dropping one would skew the score.
 */
export async function checkGames(dir: string, counts: Partial<Record<string, number>>, opts: { rules?: BenchRules } = {}): Promise<{ results: GameResult[] } | { error: string }> {
  const rules = opts.rules ?? RULES;
  const files = readdirSync(dir);
  const number = (f: string) => Number(/-(\d+)\.json\.gz$/.exec(f)?.[1] ?? NaN);
  const results: GameResult[] = [];
  for (const opponent of rules.opponents) {
    const mine = files.filter((f) => f.startsWith(`${opponent}-`)).sort((a, b) => number(a) - number(b) || (a < b ? -1 : 1));
    if (mine.length < rules.minGames) return { error: `${mine.length} games against ${opponent}; at least ${rules.minGames} are needed` };
    if (mine.length !== counts[opponent]) return { error: `expected ${counts[opponent]} games against ${opponent}, the folder has ${mine.length}` };
    for (const [i, file] of mine.entries()) {
      if (file !== gameFile(opponent, i)) return { error: `${file}: expected ${gameFile(opponent, i)}` };
      const path = join(dir, file);
      if (statSync(path).size > MAX_FILE_BYTES) return { error: `${file} is larger than a recorded game` };
      let rec: Recording;
      try {
        rec = JSON.parse(gunzipSync(readFileSync(path), { maxOutputLength: MAX_GAME_BYTES }).toString('utf8')) as Recording;
      } catch (err) {
        return { error: `${file}: ${(err as Error).message}` };
      }
      if (rec?.opponent !== opponent || rec.game !== i) return { error: `${file} holds game ${rec?.game} against ${rec?.opponent}` };
      const verdict = await verifyGame(rec, rules);
      if (!verdict.ok) return { error: `${file}: ${verdict.error}` };
      results.push(verdict.result);
    }
  }
  const stray = files.filter((f) => !rules.opponents.some((o) => f.startsWith(`${o}-`)));
  if (stray.length) return { error: `unexpected files: ${stray.join(', ')}` };
  return { results };
}
