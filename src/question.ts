// The per-move request: the position plus one `choice` question whose options are the legal moves (UCI keys), each
// described by facts the bench computes about the position after it.
import { colorOf, FLAG_CASTLE, FLAG_EN_PASSANT, KING, opposite, PAWN, PIECE_NAMES, Position, san, SQUARES, squareName, typeOf, uci, WHITE, type Color, type Move } from './chess/board.ts';
import type { Game } from './game.ts';

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface DecideRequest {
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface DecideResponse {
  answers: Record<string, ChoiceAnswer | undefined>;
  usage?: { input_tokens: number; output_tokens: number };
  costUsd?: number | null;
}

export const MOVE_QUESTION = 'move';

const colorName = (c: Color) => (c === WHITE ? 'White' : 'Black');
const pieceAt = (pos: Position, sq: number) => `${PIECE_NAMES[typeOf(pos.board[sq])]} on ${squareName(sq)}`;

export function boardRows(pos: Position): string[] {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = `${r + 1} `;
    for (let f = 0; f < 8; f++) {
      const piece = pos.board[r * 16 + f];
      const letter = ' pnbrqk'[typeOf(piece)];
      row += ` ${!piece ? '.' : colorOf(piece) === WHITE ? letter.toUpperCase() : letter}`;
    }
    rows.push(row);
  }
  rows.push('   a b c d e f g h');
  return rows;
}

const PAWNS = [0, 1, 3, 3, 5, 9, 0];

/** Legal captures of the piece on `sq`, en passant included, cheapest capturer first. */
function capturesOf(pos: Position, sq: number, legal: Move[]): Move[] {
  const behind = pos.turn === WHITE ? -16 : 16;
  const worth = (m: Move) => (typeOf(m.piece) === KING ? 100 : PAWNS[typeOf(m.piece)]);
  return legal.filter((m) => m.captured && (m.flags & FLAG_EN_PASSANT ? m.to + behind : m.to) === sq).sort((a, b) => worth(a) - worth(b) || b.promotion - a.promotion);
}

type MovesOf = (pos: Position) => Move[];
const legalMoves: MovesOf = (pos) => pos.moves();

/**
 * Static exchange on `sq`: what the side to move wins, in pawns, if both sides keep recapturing with their cheapest
 * legal piece (pins and checks count) and either may stop. `by` is the first capturer's square when the gain is > 0.
 */
function exchange(pos: Position, sq: number, movesOf: MovesOf = legalMoves, legal: Move[] = movesOf(pos)): { gain: number; by?: number } {
  const m = capturesOf(pos, sq, legal)[0];
  if (!m) return { gain: 0 };
  const won = PAWNS[typeOf(m.captured)] + (m.promotion ? PAWNS[m.promotion] - PAWNS[PAWN] : 0);
  pos.make(m);
  const lost = exchange(pos, m.to, movesOf).gain;
  pos.unmake();
  return won - lost > 0 ? { gain: won - lost, by: m.from } : { gain: 0 };
}

/** `side`'s moves as if the checks from `checkers` weren't there; the other side gets its legal moves. */
const ignoringChecks =
  (side: Color, checkers: number[]): MovesOf =>
  (pos) =>
    pos.turn !== side || !checkers.length
      ? pos.moves()
      : pos.pseudoMoves().filter((m) => {
          pos.make(m);
          const ok = pos.attackers(pos.kings[side >> 3], opposite(side)).every((s) => checkers.includes(s));
          pos.unmake();
          return ok;
        });

function withTurn<T>(pos: Position, color: Color, f: () => T): T {
  const { turn, ep } = pos;
  pos.turn = color;
  pos.ep = -1;
  try {
    return f();
  } finally {
    pos.turn = turn;
    pos.ep = ep;
  }
}

/** `seen` counts earlier occurrences of a Position.key; `reachesCap` marks the last move before the move cap. */
export function describeMove(pos: Position, m: Move, legal: Move[], seen: (key: string) => number = () => 0, reachesCap = false): string {
  const us = pos.turn;
  const them = opposite(us);
  const facts: string[] = [];
  const what = m.flags & FLAG_CASTLE ? `castles ${m.to > m.from ? 'kingside' : 'queenside'}` : `${PIECE_NAMES[typeOf(m.piece)]} ${squareName(m.from)}→${squareName(m.to)}`;
  facts.push(what);
  if (m.captured) facts.push(`captures a ${PIECE_NAMES[typeOf(m.captured)]}${m.flags & FLAG_EN_PASSANT ? ' en passant' : ''}`);
  if (m.promotion) facts.push(`promotes to a ${PIECE_NAMES[m.promotion]}`);
  const notation = san(pos, m, legal);
  pos.make(m);
  try {
    const replies = pos.moves();
    if (!replies.length) {
      facts.push(pos.inCheck() ? 'CHECKMATE: wins the game' : 'STALEMATE: the game is a draw');
      return `${notation}: ${facts.join('; ')}`;
    }
    // Same order as Game.termination.
    const before = seen(pos.key());
    const draw = pos.insufficientMaterial()
      ? 'DRAW: neither side has enough material left to mate'
      : pos.halfmove >= 100
        ? 'DRAW by the fifty-move rule'
        : before >= 2
          ? 'DRAW by threefold repetition'
          : reachesCap
            ? 'DRAW: the move cap is reached'
            : null;
    if (draw) {
      facts.push(draw);
      return `${notation}: ${facts.join('; ')}`;
    }
    if (before === 1) facts.push('repeats an earlier position (a third time is a draw)');
    if (pos.inCheck()) facts.push('gives check');
    const own = (sq: number) => pos.board[sq] && colorOf(pos.board[sq]) === us && typeOf(pos.board[sq]) !== KING;
    const enemy = (sq: number) => pos.board[sq] && colorOf(pos.board[sq]) === them && typeOf(pos.board[sq]) !== KING;
    if (own(m.to)) {
      const landed = exchange(pos, m.to, legalMoves, replies);
      if (landed.by !== undefined) facts.push(`UNSAFE: the ${pieceAt(pos, m.to)} can be taken by the ${pieceAt(pos, landed.by)} (loses ${landed.gain} in the trades there)`);
    }
    const hanging = SQUARES.filter((sq) => sq !== m.to && own(sq) && pos.attackers(sq, them, true).length && exchange(pos, sq, legalMoves, replies).gain > 0);
    if (hanging.length) facts.push(`leaves hanging: ${hanging.map((sq) => `the ${pieceAt(pos, sq)}`).join(', ')}`);
    // Pieces it could win if it moved again. If the move gives check, the defender would have to answer the check
    // first, so its recaptures in this hypothetical are judged as if the check weren't there.
    const movesOf = ignoringChecks(them, pos.attackers(pos.kings[them >> 3], us));
    const threats = withTurn(pos, us, () => SQUARES.filter((sq) => enemy(sq) && pos.attackers(sq, us, true).length && exchange(pos, sq, movesOf).gain > 0));
    if (threats.length) facts.push(`then attacks: ${threats.map((sq) => `the ${pieceAt(pos, sq)}`).join(', ')}`);
    if (allowsMateInOne(pos, replies)) facts.push('ALLOWS MATE IN ONE');
    if (m.captured || m.promotion) {
      const lead = materialLead(pos, us);
      facts.push(`material after: ${lead > 0 ? '+' : ''}${lead}`);
    }
  } finally {
    pos.unmake();
  }
  return `${notation}: ${facts.join('; ')}`;
}

function allowsMateInOne(pos: Position, replies: Move[]): boolean {
  for (const r of replies) {
    pos.make(r);
    const mate = pos.inCheck() && pos.moves().length === 0;
    pos.unmake();
    if (mate) return true;
  }
  return false;
}

function materialLead(pos: Position, color: Color): number {
  let lead = 0;
  for (const sq of SQUARES) {
    const piece = pos.board[sq];
    if (piece) lead += (colorOf(piece) === color ? 1 : -1) * PAWNS[typeOf(piece)];
  }
  return lead;
}

export function buildRequest(game: Game, opponent = 'a computer opponent'): DecideRequest {
  const pos = game.pos;
  const us = pos.turn;
  const legal = pos.moves();
  const criteria: Record<string, string> = {};
  const seen = (key: string) => game.occurrences(key);
  const movesLeft = game.maxPlies - game.plies.length;
  for (const m of [...legal].sort((a, b) => (uci(a) < uci(b) ? -1 : 1))) criteria[uci(m)] = describeMove(pos, m, legal, seen, movesLeft === 1);
  const history = game.san.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(' ');
  return {
    state: {
      fen: pos.fen(),
      you: colorName(us),
      moveNumber: pos.fullmove,
      inCheck: pos.inCheck(),
      lastMove: game.san.at(-1) ?? null,
      moves: history,
      board: boardRows(pos),
      materialLead: materialLead(pos, us),
      movesLeftBeforeCap: movesLeft,
      opening: game.setup.opening.name,
    },
    questions: {
      [MOVE_QUESTION]: {
        type: 'choice',
        instructions:
          `You are playing chess as ${colorName(us)} against ${opponent}. Choose your next move. ` +
          'Each option is a legal move (its key is the move in UCI notation), described by its SAN and facts about the position right after it. ' +
          'Checkmate wins; stalemate, threefold repetition, the fifty-move rule and insufficient material are draws, and so is the move cap: ' +
          `the game is drawn after ${movesLeft} more ${movesLeft === 1 ? 'move' : 'moves'}, both sides' moves counted (movesLeftBeforeCap). Answer with one option key.`,
        criteria,
      },
    },
  };
}
