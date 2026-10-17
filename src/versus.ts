import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { uci, WHITE, type Move } from './chess/board.ts';
import { rng } from './chess/engine.ts';
import { fallbackMove, playSides, setupFor, type Game, type PlayedGame, type Termination } from './game.ts';
import { BENCH_VERSION, RULES, type BenchRules, type ModelKind } from './leaderboard.ts';
import { BASELINES, type Player } from './players.ts';
import { buildRequest, MOVE_QUESTION, type DecideRequest } from './question.ts';
import type { Turn } from './recording.ts';
import { askPlayer, type PlayOptions } from './run.ts';

export interface SideResult {
  player: string;
  points: number;
  moves: number;
  fallbacks: number;
  invalid: number;
  timeouts: number;
  answered: number;
  latencyMsSum: number;
  cost: number;
  turns: Turn[];
}

export interface MatchGame {
  game: number;
  opening: string;
  white: SideResult;
  black: SideResult;
  result: '1-0' | '0-1' | '1/2-1/2';
  termination: Termination;
  plies: number;
  /** Opening included. */
  san: string[];
  /** After the opening only. */
  uci: string[];
}

export const VERSUS_OPPONENT = 'another AI model';

function side(player: string, points: number, turns: Turn[]): SideResult {
  const answered = turns.filter((t) => typeof t.latencyMs === 'number');
  return {
    player,
    points,
    moves: turns.length,
    fallbacks: turns.filter((t) => t.source === 'fallback').length,
    invalid: turns.filter((t) => t.reason === 'invalid').length,
    timeouts: turns.filter((t) => t.reason === 'timeout').length,
    answered: answered.length,
    latencyMsSum: answered.reduce((a, t) => a + t.latencyMs!, 0),
    cost: turns.reduce((a, t) => a + (typeof t.costUsd === 'number' ? t.costUsd : 0), 0),
    turns,
  };
}

/** `a` plays the setup's model side. */
function matchGame(index: number, a: string, b: string, played: PlayedGame, turnsA: Turn[], turnsB: Turn[]): MatchGame {
  const { game, termination, outcome } = played;
  const pointsA = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;
  const sideA = side(a, pointsA, turnsA);
  const sideB = side(b, 1 - pointsA, turnsB);
  const aWhite = game.setup.model === WHITE;
  const white = aWhite ? sideA : sideB;
  return {
    game: index,
    opening: game.setup.opening.name,
    white,
    black: aWhite ? sideB : sideA,
    result: white.points === 1 ? '1-0' : white.points === 0 ? '0-1' : '1/2-1/2',
    termination,
    plies: game.plies.length,
    san: [...game.san],
    uci: [...game.plies],
  };
}

/** `a` has White in even games. */
export async function playMatch(a: Player, b: Player, index: number, opts: PlayOptions = {}): Promise<MatchGame> {
  const rules = opts.rules ?? RULES;
  const timeoutMs = opts.timeoutMs ?? rules.moveTimeoutMs;
  const setup = setupFor(index);
  const turnsA: Turn[] = [];
  const turnsB: Turn[] = [];
  const played = await playSides(setup, rules.maxPlies, (g) =>
    g.modelToMove ? askPlayer(a, g, timeoutMs, turnsA, VERSUS_OPPONENT) : askPlayer(b, g, timeoutMs, turnsB, VERSUS_OPPONENT),
  );
  return matchGame(index, a.id, b.id, played, turnsA, turnsB);
}

export const pairings = <T>(players: T[]): [T, T][] => players.flatMap((a, i) => players.slice(i + 1).map((b) => [a, b] as [T, T]));

const ELO_MEAN = 1500;

/**
 * Bradley–Terry strengths (a draw is half a win each way) on the Elo scale, averaging 1500. One virtual draw per pair
 * keeps a player who never scored finite and shrinks thin evidence toward the mean.
 */
export function fitRatings(games: MatchGame[], ids: string[]): Record<string, number> {
  const k = ids.length;
  const at = new Map(ids.map((id, i) => [id, i]));
  const points = Array.from({ length: k }, () => new Array<number>(k).fill(0.5));
  const played = Array.from({ length: k }, () => new Array<number>(k).fill(1));
  for (let i = 0; i < k; i++) {
    points[i][i] = 0;
    played[i][i] = 0;
  }
  for (const g of games) {
    const w = at.get(g.white.player);
    const b = at.get(g.black.player);
    if (w === undefined || b === undefined) continue;
    points[w][b] += g.white.points;
    points[b][w] += g.black.points;
    played[w][b] += 1;
    played[b][w] += 1;
  }
  const wins = points.map((row) => row.reduce((a, x) => a + x, 0));
  let p = new Array<number>(k).fill(1);
  // Hunter's minorization-maximization, renormalized to a geometric mean of 1; 500 steps settle any small pool.
  for (let iter = 0; iter < 500; iter++) {
    const next = p.map((pi, i) => wins[i] / p.reduce((a, pj, j) => (j === i ? a : a + played[i][j] / (pi + pj)), 0));
    const logMean = next.reduce((a, x) => a + Math.log(x), 0) / k;
    p = next.map((x) => x / Math.exp(logMean));
  }
  return Object.fromEntries(ids.map((id, i) => [id, k === 1 ? ELO_MEAN : ELO_MEAN + 400 * Math.log10(p[i])]));
}

/** 95% margins from a seeded bootstrap over the games, so a report is reproducible. */
export function ratingsWithMargin(games: MatchGame[], ids: string[], resamples = 200): Record<string, { rating: number; margin: number }> {
  const base = fitRatings(games, ids);
  const draw = rng(12345);
  const samples: Record<string, number[]> = Object.fromEntries(ids.map((id) => [id, []]));
  for (let s = 0; s < resamples && games.length; s++) {
    const resampled = games.map(() => games[Math.floor(draw() * games.length)]);
    const r = fitRatings(resampled, ids);
    for (const id of ids) samples[id].push(r[id]);
  }
  const sd = (xs: number[]) => {
    const m = xs.reduce((a, x) => a + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
  };
  return Object.fromEntries(ids.map((id) => [id, { rating: Math.round(base[id]), margin: samples[id].length ? Math.round(1.96 * sd(samples[id])) : 0 }]));
}

export interface VersusEntry {
  player: string;
  name: string;
  kind: ModelKind;
  rating: number;
  margin: number;
  games: number;
  scorePct: number;
  winPct: number;
  drawPct: number;
  lossPct: number;
  fallbackPct: number;
  invalidPct: number;
  meanLatencyMs: number | null;
  costPerGame: number;
}

export interface Versus {
  generatedAt: string;
  benchVersion: number;
  /** False while running or after an early stop: the numbers cover only finished pairs. */
  complete: boolean;
  players: string[];
  settings: { gamesPerPair: number; maxPlies: number; moveTimeoutMs: number };
  entries: VersusEntry[];
  /** Row player's score against the column player, in percent. */
  headToHead: Record<string, Record<string, { scorePct: number; games: number }>>;
  skipped: { player: string; reason: string }[];
}

const pct = (part: number, whole: number) => (whole ? Math.round((1000 * part) / whole) / 10 : 0);

export function summarizeVersus(players: Pick<Player, 'id' | 'name' | 'kind'>[], games: MatchGame[]): Pick<Versus, 'entries' | 'headToHead'> {
  const ids = players.map((p) => p.id);
  const ratings = ratingsWithMargin(games, ids);
  const sidesOf = (id: string) => games.flatMap((g) => [g.white, g.black].filter((s) => s.player === id));
  const entries = players.map((p): VersusEntry => {
    const sides = sidesOf(p.id);
    const sum = (f: (s: SideResult) => number) => sides.reduce((a, s) => a + f(s), 0);
    const answered = sum((s) => s.answered);
    return {
      player: p.id,
      name: p.name,
      kind: p.kind,
      ...ratings[p.id],
      games: sides.length,
      scorePct: pct(sum((s) => s.points), sides.length),
      winPct: pct(sides.filter((s) => s.points === 1).length, sides.length),
      drawPct: pct(sides.filter((s) => s.points === 0.5).length, sides.length),
      lossPct: pct(sides.filter((s) => s.points === 0).length, sides.length),
      fallbackPct: pct(sum((s) => s.fallbacks), sum((s) => s.moves)),
      invalidPct: pct(sum((s) => s.invalid), sum((s) => s.moves)),
      meanLatencyMs: answered ? Math.round(sum((s) => s.latencyMsSum) / answered) : null,
      costPerGame: sides.length ? Math.round((sum((s) => s.cost) / sides.length) * 1e5) / 1e5 : 0,
    };
  });
  const headToHead: Versus['headToHead'] = {};
  for (const a of ids) {
    headToHead[a] = {};
    for (const b of ids) {
      if (a === b) continue;
      const mine = games.flatMap((g) => (g.white.player === a && g.black.player === b ? [g.white] : g.black.player === a && g.white.player === b ? [g.black] : []));
      if (mine.length) headToHead[a][b] = { scorePct: pct(mine.reduce((x, s) => x + s.points, 0), mine.length), games: mine.length };
    }
  }
  return { entries: [...entries].sort((x, y) => y.rating - x.rating || y.scorePct - x.scorePct), headToHead };
}

export function renderVersusMarkdown(v: Versus): string {
  const out = ['# Chess benchmark: versus', ''];
  out.push(
    'Every pair of players plays the same games: each opening once from each side. Rating is a Bradley–Terry fit of all games on the Elo scale ' +
      '(the pool averages 1500; 200 points apart ≈ the stronger scores 76%), ± its 95% margin. Ratings only compare players within this pool.',
    '',
    `${v.settings.gamesPerPair} games per pair, ${v.settings.maxPlies}-move cap, ${v.settings.moveTimeoutMs / 1000} s per move, bench version ${v.benchVersion}, ${v.generatedAt}.`,
    '',
  );
  if (!v.complete) out.push('**Incomplete:** these numbers cover only the pairs that finished; resume the run with `--resume` to play the rest.', '');
  const head = ['#', 'Player', 'Kind', 'Rating', 'Score %', 'W / D / L %', 'Fallback %', 'Latency', '$/game', 'Games'];
  const rows = [head, head.map(() => '---')];
  v.entries.forEach((e, i) =>
    rows.push([
      String(i + 1),
      e.name,
      e.kind,
      `${e.rating} ± ${e.margin}`,
      e.scorePct.toFixed(1),
      `${e.winPct.toFixed(0)} / ${e.drawPct.toFixed(0)} / ${e.lossPct.toFixed(0)}`,
      e.fallbackPct.toFixed(1),
      e.meanLatencyMs === null ? '–' : `${e.meanLatencyMs} ms`,
      e.costPerGame ? `$${e.costPerGame.toFixed(4)}` : '–',
      String(e.games),
    ]),
  );
  out.push(rows.map((r) => `| ${r.join(' | ')} |`).join('\n'), '');
  out.push('## Head to head', '', "Row player's score against the column player, in percent.", '');
  const ids = v.entries.map((e) => e.player);
  const grid = [['', ...v.entries.map((e) => e.name)], ['---', ...ids.map(() => '---')]];
  for (const a of v.entries) grid.push([a.name, ...ids.map((b) => (b === a.player ? '–' : (v.headToHead[a.player]?.[b]?.scorePct.toFixed(1) ?? '')))]);
  out.push(grid.map((r) => `| ${r.join(' | ')} |`).join('\n'), '');
  return `${out.join('\n')}\n`;
}

export function toPgn(games: MatchGame[], names: Record<string, string>): string {
  const quote = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return games
    .map((g) => {
      const tags = [
        ['Event', 'Chess benchmark versus'],
        ['Round', String(g.game + 1)],
        ['White', names[g.white.player] ?? g.white.player],
        ['Black', names[g.black.player] ?? g.black.player],
        ['Result', g.result],
        ['Opening', g.opening],
        ['Termination', g.termination],
      ];
      const tokens = g.san.flatMap((s, i) => (i % 2 === 0 ? [`${i / 2 + 1}.`, s] : [s]));
      tokens.push(g.result);
      const lines: string[] = [];
      let line = '';
      for (const t of tokens) {
        if (line && line.length + 1 + t.length > 79) {
          lines.push(line);
          line = t;
        } else line = line ? `${line} ${t}` : t;
      }
      lines.push(line);
      return `${tags.map(([k, v]) => `[${k} "${quote(v)}"]`).join('\n')}\n\n${lines.join('\n')}\n`;
    })
    .join('\n');
}

export interface PairRecording {
  version: 1;
  benchVersion: number;
  settings: Versus['settings'];
  players: [string, string];
  games: { game: number; plies: string[]; turns: { white: Turn[]; black: Turn[] } }[];
}

export const pairFile = (a: string, b: string): string => `${a}-vs-${b}.json.gz`;

export function pairRecording(a: string, b: string, games: MatchGame[], settings: Versus['settings']): PairRecording {
  return {
    version: 1,
    benchVersion: BENCH_VERSION,
    settings,
    players: [a, b],
    games: games.map((g) => ({ game: g.game, plies: g.uci, turns: { white: g.white.turns, black: g.black.turns } })),
  };
}

export function writePair(dir: string, rec: PairRecording): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, pairFile(...rec.players)), gzipSync(JSON.stringify(rec)));
}

export function clearPairs(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/\.json\.gz$/.test(f)) rmSync(join(dir, f));
}

export function readPair(dir: string, a: string, b: string): PairRecording | null {
  try {
    return JSON.parse(gunzipSync(readFileSync(join(dir, pairFile(a, b))), { maxOutputLength: 64 << 20 }).toString('utf8')) as PairRecording;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

const NO_REQUEST: DecideRequest = { state: {}, questions: {} };

/**
 * Every move must be legal, every fallback must be the bench's fallback move, and every baseline move must be what
 * its rule plays; a model's own moves can only be checked for legality. Throws with the reason on a mismatch.
 */
export async function replayPair(rec: PairRecording, rules: BenchRules = RULES): Promise<MatchGame[]> {
  if (rec?.version !== 1) throw new Error('not a version 1 pair recording');
  if (rec.benchVersion !== BENCH_VERSION) throw new Error(`recorded on bench version ${rec.benchVersion}, the current one is ${BENCH_VERSION}`);
  const [a, b] = rec.players;
  if (!Array.isArray(rec.games) || rec.games.length !== rec.settings?.gamesPerPair) throw new Error(`${rec.games?.length} games recorded, ${rec.settings?.gamesPerPair} expected`);
  const baseline = (id: string) => BASELINES.find((p) => p.id === id);
  const out: MatchGame[] = [];
  for (const [i, g] of rec.games.entries()) {
    if (g.game !== i) throw new Error(`game ${i + 1} is numbered ${g.game + 1}`);
    if (!Array.isArray(g.plies) || g.plies.length > rules.maxPlies) throw new Error(`game ${i + 1}: bad moves`);
    const setup = setupFor(i);
    const turnsA: Turn[] = [];
    const turnsB: Turn[] = [];
    const counters = { white: 0, black: 0 };
    let played: PlayedGame;
    try {
      played = await playSides(setup, rules.maxPlies, async (game: Game): Promise<Move> => {
        const at = game.plies.length;
        const color = game.pos.turn === WHITE ? 'white' : 'black';
        const turn = g.turns?.[color]?.[counters[color]++];
        const text = g.plies[at];
        if (text === undefined || !turn) throw new Error(`the recording stops at move ${at + 1}, before the game is over`);
        const move = game.pos.moves().find((m) => uci(m) === text);
        if (!move) throw new Error(`move ${at + 1}, ${text}, is not legal`);
        const id = game.modelToMove ? a : b;
        const rule = baseline(id);
        let expected: string | undefined;
        if (turn.source === 'fallback') expected = uci(fallbackMove(game));
        else if (rule) {
          // Only the fact reader reads the request; the other baselines read the position.
          const request = id === 'facts' ? buildRequest(game, VERSUS_OPPONENT) : NO_REQUEST;
          expected = (await rule.decide(request, game, AbortSignal.timeout(60_000))).answers[MOVE_QUESTION]?.choice;
        }
        if (expected !== undefined && expected !== text) throw new Error(`move ${at + 1} is ${text}, but ${turn.source === 'fallback' ? 'the fallback' : id} plays ${expected}`);
        (game.modelToMove ? turnsA : turnsB).push(turn);
        return move;
      });
    } catch (err) {
      throw new Error(`game ${i + 1}: ${(err as Error).message}`);
    }
    if (played.game.plies.length !== g.plies.length) throw new Error(`game ${i + 1}: the game ends at move ${played.game.plies.length}, the recording has ${g.plies.length}`);
    if (counters.white !== g.turns.white.length || counters.black !== g.turns.black.length) throw new Error(`game ${i + 1}: more turns recorded than moves played`);
    out.push(matchGame(i, a, b, played, turnsA, turnsB));
  }
  return out;
}
