// The scripted opponents: static evaluation plus a small alpha-beta search. Integer scores, fixed move order, seeded
// tie-breaks and no clocks keep it deterministic, so games replay move for move.
import { BISHOP, colorOf, FLAG_CAPTURE, FLAG_PROMOTION, KING, KNIGHT, PAWN, Position, QUEEN, ROOK, SQUARES, typeOf, uci, WHITE, fileOf, rankOf, type Move } from './board.ts';

export const VALUE = [0, 100, 320, 330, 500, 900, 0];

// Piece-square tables (Michniewski's simplified evaluation), from White's side, listed rank 8 first.
// prettier-ignore
const PST: Record<number, number[]> = {
  [PAWN]: [
    0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [KNIGHT]: [
    -50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  [BISHOP]: [
    -20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  [ROOK]: [
    0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0,
  ],
  [QUEEN]: [
    -20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  [KING]: [
    -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

/** Centralizing king table for the endgame. */
// prettier-ignore
const KING_ENDGAME = [
  -50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50,
];

export const MATE = 100_000;
const INF = 1_000_000;
/** Captures searched past the nominal depth, so a search does not stop in the middle of an exchange. */
const QUIESCENCE_PLIES = 6;
/** A draw scores -CONTEMPT for the side choosing: it plays on when level and seeks draws only when behind. */
export const CONTEMPT = 20;
/** Opponents pick randomly among moves within this many centipawns of their best, so games vary. */
export const VARIETY = 15;

/**
 * Mop-up bonus per step the weak king is from the centre, and per step the kings are closer. Each step must outweigh
 * VARIETY, or random picks among near-equal moves would wander off the mating plan.
 */
const MOP_UP_EDGE = 100;
const MOP_UP_CLOSE = 30;

/** Tables are listed rank 8 first from White's side; Black reads them mirrored. */
const tableIndex = (sq: number, c: number) => (c === 0 ? (7 - rankOf(sq)) * 8 + fileOf(sq) : rankOf(sq) * 8 + fileOf(sq));
/** Steps from `sq` to the nearest of the four centre squares (0 to 6). */
const fromCentre = (sq: number) => Math.max(3 - fileOf(sq), fileOf(sq) - 4) + Math.max(3 - rankOf(sq), rankOf(sq) - 4);

/**
 * Centipawns for the side to move: material plus piece-square tables, using the endgame king table once queens are
 * off (or nearly). Against a bare king (or lone minor) with no pawns, a mop-up term rewards driving it to the edge and
 * bringing the kings together; without it a shallow search can't find the mate.
 */
export function evaluate(pos: Position): number {
  let score = 0;
  // By color index (0 White, 1 Black).
  const material = [0, 0];
  const pawns = [0, 0];
  const queens = [0, 0];
  const rooks = [0, 0];
  const minors = [0, 0];
  for (const sq of SQUARES) {
    const piece = pos.board[sq];
    if (!piece) continue;
    const t = typeOf(piece);
    if (t === KING) continue;
    const c = colorOf(piece) >> 3;
    const v = VALUE[t] + PST[t][tableIndex(sq, c)];
    score += c === 0 ? v : -v;
    material[c] += VALUE[t];
    if (t === PAWN) pawns[c] += 1;
    else if (t === QUEEN) queens[c] += 1;
    else if (t === ROOK) rooks[c] += 1;
    else minors[c] += 1;
  }
  // The endgame, as Michniewski defines it: no queens, or every side with a queen has at most one minor piece besides.
  const endgame = [0, 1].every((c) => !queens[c] || (rooks[c] === 0 && minors[c] <= 1));
  const kingTable = endgame ? KING_ENDGAME : PST[KING];
  const [whiteKing, blackKing] = pos.kings;
  score += kingTable[tableIndex(whiteKing, 0)] - kingTable[tableIndex(blackKing, 1)];
  const lead = material[0] - material[1];
  const weak = lead > 0 ? 1 : 0;
  if (Math.abs(lead) >= 400 && pawns[weak] === 0 && material[weak] <= VALUE[BISHOP]) {
    const apart = Math.abs(fileOf(whiteKing) - fileOf(blackKing)) + Math.abs(rankOf(whiteKing) - rankOf(blackKing));
    const mopUp = MOP_UP_EDGE * fromCentre(pos.kings[weak]) + MOP_UP_CLOSE * (14 - apart);
    score += weak === 1 ? mopUp : -mopUp;
  }
  return pos.turn === WHITE ? score : -score;
}

export function material(pos: Position, color: number): number {
  let score = 0;
  for (const sq of SQUARES) {
    const piece = pos.board[sq];
    if (piece) score += colorOf(piece) === color ? VALUE[typeOf(piece)] : -VALUE[typeOf(piece)];
  }
  return score;
}

/** MVV-LVA, with a stable sort so the search is reproducible. */
function ordered(moves: Move[]): Move[] {
  const key = (m: Move) => (m.captured ? 10 * VALUE[typeOf(m.captured)] - VALUE[typeOf(m.piece)] + 10_000 : 0) + (m.promotion ? VALUE[m.promotion] : 0);
  return moves.map((m) => [key(m), m] as const).sort((a, b) => b[0] - a[0]).map(([, m]) => m);
}

function quiesce(pos: Position, alpha: number, beta: number, depth: number): number {
  const stand = evaluate(pos);
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;
  if (depth >= QUIESCENCE_PLIES) return alpha;
  for (const m of ordered(pos.pseudoMoves(true).filter((m) => m.flags & (FLAG_CAPTURE | FLAG_PROMOTION)))) {
    if (!pos.isLegal(m)) continue;
    pos.make(m);
    const v = -quiesce(pos, -beta, -alpha, depth + 1);
    pos.unmake();
    if (v >= beta) return beta;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

/** A draw from the point of view of the side to move `ply` plies below the root: -CONTEMPT for the root's side. */
const drawScore = (ply: number) => (ply % 2 === 0 ? -CONTEMPT : CONTEMPT);

function negamax(pos: Position, depth: number, alpha: number, beta: number, ply: number, seen: (key: string) => number): number {
  if (depth === 0) return quiesce(pos, alpha, beta, 0);
  // A repeat of a game position is scored as a draw; bestMoves checks ply 1 itself.
  if (ply >= 2 && seen(pos.key()) >= 1) return drawScore(ply);
  const moves = pos.moves();
  if (!moves.length) return pos.inCheck() ? -MATE + ply : drawScore(ply);
  let best = -INF;
  for (const m of ordered(moves)) {
    pos.make(m);
    const v = -negamax(pos, depth - 1, -beta, -alpha, ply + 1, seen);
    pos.unmake();
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

export interface SearchOptions {
  /** Occurrences of each Position.key so far. Returning to one scores as a draw, since either side could repeat it. */
  seen?: (key: string) => number;
  /** Also return moves within this many centipawns of the best (ignored when a mate is found). */
  margin?: number;
}

function afterMove(pos: Position, seen: (key: string) => number): 'mate' | 'draw' | null {
  if (!pos.moves().length) return pos.inCheck() ? 'mate' : 'draw';
  if (pos.insufficientMaterial() || pos.halfmove >= 100 || seen(pos.key()) >= 1) return 'draw';
  return null;
}

/**
 * The moves scoring within `margin` of the best at `depth` plies (plus quiescence). Game-ending moves are scored at
 * the root, where the history is known. Each root move is searched with its alpha just below best-so-far minus
 * `margin`, so every move that ends up within the margin has an exact score.
 */
export function bestMoves(pos: Position, depth: number, opts: SearchOptions = {}): { moves: Move[]; score: number } {
  const seen = opts.seen ?? (() => 0);
  const margin = opts.margin ?? 0;
  let best = -INF;
  const scored: [number, Move][] = [];
  for (const m of ordered(pos.moves())) {
    pos.make(m);
    const end = afterMove(pos, seen);
    const floor = best - margin - 1;
    const v = end === 'mate' ? MATE - 1 : end === 'draw' ? -CONTEMPT : depth <= 1 ? -quiesce(pos, -INF, -floor, 0) : -negamax(pos, depth - 1, -INF, -floor, 1, seen);
    pos.unmake();
    scored.push([v, m]);
    if (v > best) best = v;
  }
  // With a mate either way, only the quickest mate or the longest defence qualifies.
  const keep = Math.abs(best) >= MATE - 1000 ? best : best - margin;
  return { moves: scored.filter(([v]) => v >= keep).map(([, m]) => m), score: best };
}

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the joined parts. */
export function seedOf(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join(':')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}

/** Sorts by UCI first so the pick doesn't depend on generation order. */
export function pick(moves: Move[], seed: number): Move {
  const sorted = [...moves].sort((a, b) => (uci(a) < uci(b) ? -1 : uci(a) > uci(b) ? 1 : 0));
  return sorted[Math.floor(rng(seed)() * sorted.length)];
}

/** Weakest first. */
export const OPPONENTS = ['random', 'greedy', 'minimax'] as const;
export type OpponentId = (typeof OPPONENTS)[number];
export const isOpponentId = (v: unknown): v is OpponentId => OPPONENTS.includes(v as OpponentId);

export const OPPONENT_INFO: Record<OpponentId, string> = {
  random: 'a uniformly random legal move',
  greedy: 'one ply with captures played out: a move within 0.15 pawns of the best material and placement right after it',
  minimax: 'a 3-ply alpha-beta search with captures played out: a move within 0.15 pawns of its best',
};

/** `seed` picks among moves within VARIETY of the best; `seen` makes it avoid repetition when ahead, seek it when behind. */
export function opponentMove(id: OpponentId, pos: Position, seed: number, seen?: (key: string) => number): Move {
  if (id === 'random') return pick(pos.moves(), seed);
  return pick(bestMoves(pos, id === 'greedy' ? 1 : 3, { seen, margin: VARIETY }).moves, seed);
}
