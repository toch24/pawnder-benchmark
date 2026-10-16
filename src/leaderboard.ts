import { OPPONENTS, type OpponentId } from './chess/engine.ts';
import type { Outcome, Termination } from './game.ts';

/** Bump when the rules, openings, opponents or question change; tests/bench-version.test.ts enforces it. */
export const BENCH_VERSION = 1;

export interface BenchRules {
  minGames: number;
  opponents: readonly OpponentId[];
  maxPlies: number;
  moveTimeoutMs: number;
}
/** maxPlies is a backstop: dead positions end earlier by fifty-move or repetition; 300 lets long won endings finish. */
export const RULES: BenchRules = { minGames: 24, opponents: OPPONENTS, maxPlies: 300, moveTimeoutMs: 30_000 };

/** decision: odds for every option in one pass; chat: a written answer; rules: no model, shown unranked. */
export const MODEL_KINDS = ['decision', 'chat', 'rules'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];
export const isModelKind = (v: unknown): v is ModelKind => MODEL_KINDS.includes(v as ModelKind);

export interface GameResult {
  game: number;
  opponent: OpponentId;
  color: 'white' | 'black';
  outcome: Outcome;
  termination: Termination;
  plies: number;
  modelMoves: number;
  fallbacks: number;
  invalid: number;
  timeouts: number;
  answered: number;
  latencyMsSum: number;
  cost: number;
  materialLead: number;
}

export interface OpponentScore {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  winPct: number;
  drawPct: number;
  lossPct: number;
  scorePct: number;
  stdErrorPct: number;
}

export interface LeaderboardEntry {
  player: string;
  name: string;
  kind: ModelKind;
  games: number;
  /** Mean of the per-opponent scores, so each opponent weighs the same. */
  scorePct: number;
  stdErrorPct: number;
  vs: Partial<Record<OpponentId, OpponentScore>>;
  winPct: number;
  drawPct: number;
  lossPct: number;
  fallbackPct: number;
  invalidPct: number;
  meanLatencyMs: number | null;
  costPerGame: number;
  meanPlies: number;
}

export interface Leaderboard {
  generatedAt: string;
  benchVersion: number;
  settings: { gamesPerOpponent: number; opponents: OpponentId[]; maxPlies: number; moveTimeoutMs: number };
  entries: LeaderboardEntry[];
  skipped: { player: string; reason: string }[];
}


const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;
const pct = (part: number, whole: number) => (whole ? round((100 * part) / whole) : 0);
const points = (o: Outcome) => (o === 'win' ? 1 : o === 'draw' ? 0.5 : 0);

/** Adds one virtual win and loss (for the error only) so a run of identical results doesn't report a margin of 0. */
function stdError(xs: number[]): number {
  if (!xs.length) return 0;
  const ys = [...xs, 0, 1];
  const m = ys.reduce((a, x) => a + x, 0) / ys.length;
  const variance = ys.reduce((a, x) => a + (x - m) ** 2, 0) / (ys.length - 1);
  return Math.sqrt(variance / ys.length);
}

export function opponentScore(games: GameResult[]): OpponentScore {
  const count = (o: Outcome) => games.filter((g) => g.outcome === o).length;
  const [wins, draws, losses] = [count('win'), count('draw'), count('loss')];
  return {
    games: games.length,
    wins,
    draws,
    losses,
    winPct: pct(wins, games.length),
    drawPct: pct(draws, games.length),
    lossPct: pct(losses, games.length),
    scorePct: pct(wins + draws / 2, games.length),
    stdErrorPct: round(100 * stdError(games.map((g) => points(g.outcome)))),
  };
}

export function summarize(player: { id: string; name: string; kind: ModelKind }, games: GameResult[]): LeaderboardEntry {
  const vs: LeaderboardEntry['vs'] = {};
  for (const id of OPPONENTS) {
    const mine = games.filter((g) => g.opponent === id);
    if (mine.length) vs[id] = opponentScore(mine);
  }
  const scores = Object.values(vs);
  const sum = (f: (g: GameResult) => number) => games.reduce((a, g) => a + f(g), 0);
  const all = opponentScore(games);
  const moves = sum((g) => g.modelMoves);
  const answered = sum((g) => g.answered);
  return {
    player: player.id,
    name: player.name,
    kind: player.kind,
    games: games.length,
    scorePct: scores.length ? round(scores.reduce((a, s) => a + s.scorePct, 0) / scores.length) : 0,
    stdErrorPct: scores.length ? round(Math.hypot(...scores.map((s) => s.stdErrorPct)) / scores.length) : 0,
    vs,
    winPct: all.winPct,
    drawPct: all.drawPct,
    lossPct: all.lossPct,
    fallbackPct: pct(sum((g) => g.fallbacks), moves),
    invalidPct: pct(sum((g) => g.invalid), moves),
    meanLatencyMs: answered ? Math.round(sum((g) => g.latencyMsSum) / answered) : null,
    costPerGame: games.length ? round(sum((g) => g.cost) / games.length, 5) : 0,
    meanPlies: games.length ? round(sum((g) => g.plies) / games.length) : 0,
  };
}

export const rank = <T extends LeaderboardEntry>(entries: T[]): T[] => [...entries].sort((a, b) => b.scorePct - a.scorePct || a.fallbackPct - b.fallbackPct);

export const tooCloseToCall = (a: LeaderboardEntry, b: LeaderboardEntry): boolean => Math.abs(a.scorePct - b.scorePct) < 1.96 * Math.hypot(a.stdErrorPct, b.stdErrorPct);
