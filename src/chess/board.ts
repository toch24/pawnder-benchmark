// 0x88 board with legal move generation, make/unmake, FEN, SAN and UCI. Perft-tested in tests/board.test.ts.
// Move generation order is deterministic, so a recorded game replays identically anywhere.

export const WHITE = 0;
export const BLACK = 8;
export type Color = typeof WHITE | typeof BLACK;

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const colorOf = (piece: number): Color => (piece & 8) as Color;
export const typeOf = (piece: number): number => piece & 7;
export const opposite = (c: Color): Color => (c ^ 8) as Color;

export const FLAG_CAPTURE = 1;
export const FLAG_EN_PASSANT = 2;
export const FLAG_DOUBLE_PUSH = 4;
export const FLAG_CASTLE = 8;
export const FLAG_PROMOTION = 16;

export interface Move {
  from: number;
  to: number;
  /** The moving piece, with its color. */
  piece: number;
  /** The captured piece, with its color, or 0. */
  captured: number;
  /** The piece type promoted to, or 0. */
  promotion: number;
  flags: number;
}

interface Undo {
  move: Move;
  castling: number;
  ep: number;
  halfmove: number;
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const CASTLE_WK = 1;
const CASTLE_WQ = 2;
const CASTLE_BK = 4;
const CASTLE_BQ = 8;

const KNIGHT_STEPS = [33, 31, 18, 14, -33, -31, -18, -14];
const KING_STEPS = [16, -16, 1, -1, 17, 15, -17, -15];
const DIAGONALS = [17, 15, -17, -15];
const ORTHOGONALS = [16, -16, 1, -1];
const PROMOTIONS = [QUEEN, ROOK, BISHOP, KNIGHT];

/** Castling rights a move from or to each square takes away. */
const CASTLE_MASK = new Uint8Array(128);
CASTLE_MASK[0x04] = CASTLE_WK | CASTLE_WQ;
CASTLE_MASK[0x07] = CASTLE_WK;
CASTLE_MASK[0x00] = CASTLE_WQ;
CASTLE_MASK[0x74] = CASTLE_BK | CASTLE_BQ;
CASTLE_MASK[0x77] = CASTLE_BK;
CASTLE_MASK[0x70] = CASTLE_BQ;

export const onBoard = (sq: number): boolean => (sq & 0x88) === 0;
export const fileOf = (sq: number): number => sq & 7;
export const rankOf = (sq: number): number => sq >> 4;
export const squareName = (sq: number): string => 'abcdefgh'[fileOf(sq)] + String(rankOf(sq) + 1);
export function parseSquare(name: string): number {
  const f = 'abcdefgh'.indexOf(name[0]);
  const r = Number(name[1]) - 1;
  if (name.length !== 2 || f < 0 || !(r >= 0 && r < 8)) throw new Error(`not a square: ${name}`);
  return r * 16 + f;
}

const LETTERS = ' pnbrqk';
export const PIECE_NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
/** The 64 on-board 0x88 indices, a1 to h8. */
export const SQUARES: number[] = Array.from({ length: 64 }, (_, i) => (i >> 3) * 16 + (i & 7));

export class Position {
  board = new Int8Array(128);
  turn: Color = WHITE;
  castling = 0;
  /** The en passant target square, or -1. */
  ep = -1;
  halfmove = 0;
  fullmove = 1;
  kings: [number, number] = [-1, -1];
  private undos: Undo[] = [];

  static fromFen(fen: string): Position {
    const p = new Position();
    const [placement, turn, castling, ep, halfmove, fullmove] = fen.trim().split(/\s+/);
    const rows = placement?.split('/') ?? [];
    if (rows.length !== 8) throw new Error(`bad FEN: ${fen}`);
    rows.forEach((row, i) => {
      let file = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) file += Number(ch);
        else {
          const type = LETTERS.indexOf(ch.toLowerCase());
          if (type < 1 || file > 7) throw new Error(`bad FEN: ${fen}`);
          const sq = (7 - i) * 16 + file;
          const color = ch === ch.toLowerCase() ? BLACK : WHITE;
          p.board[sq] = type | color;
          if (type === KING) p.kings[color >> 3] = sq;
          file += 1;
        }
      }
      if (file !== 8) throw new Error(`bad FEN: ${fen}`);
    });
    if (p.kings[0] < 0 || p.kings[1] < 0) throw new Error(`bad FEN (a king is missing): ${fen}`);
    p.turn = turn === 'b' ? BLACK : WHITE;
    for (const ch of castling ?? '-') p.castling |= ch === 'K' ? CASTLE_WK : ch === 'Q' ? CASTLE_WQ : ch === 'k' ? CASTLE_BK : ch === 'q' ? CASTLE_BQ : 0;
    p.ep = ep && ep !== '-' ? parseSquare(ep) : -1;
    p.halfmove = Number(halfmove ?? 0) || 0;
    p.fullmove = Number(fullmove ?? 1) || 1;
    return p;
  }

  clone(): Position {
    return Position.fromFen(this.fen());
  }

  /** The FEN; the en passant square only when a pawn could take there, as most tools write it. */
  fen(): string {
    return `${this.placement()} ${this.turn === WHITE ? 'w' : 'b'} ${this.castlingField()} ${this.epField()} ${this.halfmove} ${this.fullmove}`;
  }

  /** What makes positions the same for repetition: placement, side to move, castling and a usable en passant. */
  key(): string {
    return `${this.placement()} ${this.turn === WHITE ? 'w' : 'b'} ${this.castlingField()} ${this.epField()}`;
  }

  private placement(): string {
    const rows: string[] = [];
    for (let r = 7; r >= 0; r--) {
      let row = '';
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const piece = this.board[r * 16 + f];
        if (!piece) {
          empty += 1;
          continue;
        }
        if (empty) row += String(empty);
        empty = 0;
        const letter = LETTERS[typeOf(piece)];
        row += colorOf(piece) === WHITE ? letter.toUpperCase() : letter;
      }
      rows.push(empty ? row + String(empty) : row);
    }
    return rows.join('/');
  }

  private castlingField(): string {
    const s = (this.castling & CASTLE_WK ? 'K' : '') + (this.castling & CASTLE_WQ ? 'Q' : '') + (this.castling & CASTLE_BK ? 'k' : '') + (this.castling & CASTLE_BQ ? 'q' : '');
    return s || '-';
  }

  private epField(): string {
    if (this.ep < 0) return '-';
    const back = this.turn === WHITE ? -16 : 16;
    const pawn = PAWN | this.turn;
    const usable = [back - 1, back + 1].some((d) => onBoard(this.ep + d) && this.board[this.ep + d] === pawn);
    return usable ? squareName(this.ep) : '-';
  }

  attacked(sq: number, by: Color): boolean {
    return this.attackers(sq, by, true).length > 0;
  }

  /** Direct attackers only, no x-rays. */
  attackers(sq: number, by: Color, firstOnly = false): number[] {
    const b = this.board;
    const found: number[] = [];
    const pawnFrom = by === WHITE ? [-15, -17] : [15, 17];
    for (const d of pawnFrom) {
      const s = sq + d;
      if (onBoard(s) && b[s] === (PAWN | by)) {
        found.push(s);
        if (firstOnly) return found;
      }
    }
    for (const d of KNIGHT_STEPS) {
      const s = sq + d;
      if (onBoard(s) && b[s] === (KNIGHT | by)) {
        found.push(s);
        if (firstOnly) return found;
      }
    }
    for (const d of KING_STEPS) {
      const s = sq + d;
      if (onBoard(s) && b[s] === (KING | by)) {
        found.push(s);
        if (firstOnly) return found;
      }
    }
    for (const [dirs, slider] of [
      [DIAGONALS, BISHOP],
      [ORTHOGONALS, ROOK],
    ] as const) {
      for (const d of dirs) {
        for (let s = sq + d; onBoard(s); s += d) {
          const piece = b[s];
          if (!piece) continue;
          if (colorOf(piece) === by && (typeOf(piece) === slider || typeOf(piece) === QUEEN)) {
            found.push(s);
            if (firstOnly) return found;
          }
          break;
        }
      }
    }
    return found;
  }

  inCheck(color: Color = this.turn): boolean {
    return this.attacked(this.kings[color >> 3], opposite(color));
  }

  /** May leave the king in check. `capturesOnly` (captures and promotions) is for quiescence search. */
  pseudoMoves(capturesOnly = false): Move[] {
    const moves: Move[] = [];
    const b = this.board;
    const us = this.turn;
    const them = opposite(us);
    const add = (from: number, to: number, flags: number, captured = b[to]) => {
      const piece = b[from];
      if (typeOf(piece) === PAWN && (rankOf(to) === 7 || rankOf(to) === 0)) {
        for (const promo of PROMOTIONS) moves.push({ from, to, piece, captured, promotion: promo, flags: flags | FLAG_PROMOTION });
      } else moves.push({ from, to, piece, captured, promotion: 0, flags });
    };
    for (const from of SQUARES) {
      const piece = b[from];
      if (!piece || colorOf(piece) !== us) continue;
      const type = typeOf(piece);
      if (type === PAWN) {
        const fwd = us === WHITE ? 16 : -16;
        const one = from + fwd;
        if (onBoard(one) && !b[one] && (!capturesOnly || rankOf(one) === 7 || rankOf(one) === 0)) {
          add(from, one, 0);
          const two = one + fwd;
          if (!capturesOnly && rankOf(from) === (us === WHITE ? 1 : 6) && !b[two]) add(from, two, FLAG_DOUBLE_PUSH);
        }
        for (const d of [fwd - 1, fwd + 1]) {
          const to = from + d;
          if (!onBoard(to)) continue;
          if (b[to] && colorOf(b[to]) === them) add(from, to, FLAG_CAPTURE);
          else if (to === this.ep) add(from, to, FLAG_CAPTURE | FLAG_EN_PASSANT, PAWN | them);
        }
      } else if (type === KNIGHT || type === KING) {
        for (const d of type === KNIGHT ? KNIGHT_STEPS : KING_STEPS) {
          const to = from + d;
          if (!onBoard(to)) continue;
          if (!b[to]) {
            if (!capturesOnly) add(from, to, 0);
          } else if (colorOf(b[to]) === them) add(from, to, FLAG_CAPTURE);
        }
      } else {
        const dirs = type === BISHOP ? DIAGONALS : type === ROOK ? ORTHOGONALS : KING_STEPS;
        for (const d of dirs) {
          for (let to = from + d; onBoard(to); to += d) {
            if (!b[to]) {
              if (!capturesOnly) add(from, to, 0);
              continue;
            }
            if (colorOf(b[to]) === them) add(from, to, FLAG_CAPTURE);
            break;
          }
        }
      }
    }
    if (!capturesOnly) this.castlingMoves(moves);
    return moves;
  }

  private castlingMoves(moves: Move[]): void {
    const us = this.turn;
    const them = opposite(us);
    const king = us === WHITE ? 0x04 : 0x74;
    const [kSide, qSide] = us === WHITE ? [CASTLE_WK, CASTLE_WQ] : [CASTLE_BK, CASTLE_BQ];
    const b = this.board;
    if (this.kings[us >> 3] !== king || !(this.castling & (kSide | qSide)) || this.attacked(king, them)) return;
    const piece = KING | us;
    if (this.castling & kSide && b[king + 3] === (ROOK | us) && !b[king + 1] && !b[king + 2] && !this.attacked(king + 1, them) && !this.attacked(king + 2, them)) {
      moves.push({ from: king, to: king + 2, piece, captured: 0, promotion: 0, flags: FLAG_CASTLE });
    }
    if (this.castling & qSide && b[king - 4] === (ROOK | us) && !b[king - 1] && !b[king - 2] && !b[king - 3] && !this.attacked(king - 1, them) && !this.attacked(king - 2, them)) {
      moves.push({ from: king, to: king - 2, piece, captured: 0, promotion: 0, flags: FLAG_CASTLE });
    }
  }

  /** Always in the same order for the same position. */
  moves(): Move[] {
    return this.pseudoMoves().filter((m) => this.isLegal(m));
  }

  isLegal(m: Move): boolean {
    const us = this.turn;
    this.make(m);
    const ok = !this.attacked(this.kings[us >> 3], opposite(us));
    this.unmake();
    return ok;
  }

  make(m: Move): void {
    const b = this.board;
    const us = this.turn;
    this.undos.push({ move: m, castling: this.castling, ep: this.ep, halfmove: this.halfmove });
    b[m.to] = m.promotion ? m.promotion | us : m.piece;
    b[m.from] = 0;
    if (m.flags & FLAG_EN_PASSANT) b[m.to + (us === WHITE ? -16 : 16)] = 0;
    if (m.flags & FLAG_CASTLE) {
      if (m.to > m.from) {
        b[m.to - 1] = b[m.to + 1];
        b[m.to + 1] = 0;
      } else {
        b[m.to + 1] = b[m.to - 2];
        b[m.to - 2] = 0;
      }
    }
    if (typeOf(m.piece) === KING) this.kings[us >> 3] = m.to;
    this.castling &= ~(CASTLE_MASK[m.from] | CASTLE_MASK[m.to]);
    this.ep = m.flags & FLAG_DOUBLE_PUSH ? (m.from + m.to) >> 1 : -1;
    this.halfmove = typeOf(m.piece) === PAWN || m.captured ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove += 1;
    this.turn = opposite(us);
  }

  unmake(): void {
    const u = this.undos.pop();
    if (!u) throw new Error('no move to take back');
    const m = u.move;
    const b = this.board;
    const us = opposite(this.turn);
    this.turn = us;
    if (us === BLACK) this.fullmove -= 1;
    this.castling = u.castling;
    this.ep = u.ep;
    this.halfmove = u.halfmove;
    b[m.from] = m.piece;
    if (m.flags & FLAG_EN_PASSANT) {
      b[m.to] = 0;
      b[m.to + (us === WHITE ? -16 : 16)] = m.captured;
    } else b[m.to] = m.captured;
    if (m.flags & FLAG_CASTLE) {
      if (m.to > m.from) {
        b[m.to + 1] = b[m.to - 1];
        b[m.to - 1] = 0;
      } else {
        b[m.to - 2] = b[m.to + 1];
        b[m.to + 1] = 0;
      }
    }
    if (typeOf(m.piece) === KING) this.kings[us >> 3] = m.from;
  }

  /** Kings only, a single minor piece, or only bishops, all on one square color. */
  insufficientMaterial(): boolean {
    let knights = 0;
    let bishops = 0;
    const bishopShades = new Set<number>();
    for (const sq of SQUARES) {
      const t = typeOf(this.board[sq]);
      if (!t || t === KING) continue;
      if (t === KNIGHT) knights += 1;
      else if (t === BISHOP) {
        bishops += 1;
        bishopShades.add((fileOf(sq) + rankOf(sq)) & 1);
      } else return false;
    }
    if (knights + bishops <= 1) return true;
    return knights === 0 && bishopShades.size === 1;
  }
}

export const uci = (m: Move): string => squareName(m.from) + squareName(m.to) + (m.promotion ? LETTERS[m.promotion] : '');

/** SAN of `m`, which must not yet be played in `pos`. */
export function san(pos: Position, m: Move, legal: Move[] = pos.moves()): string {
  let s: string;
  const type = typeOf(m.piece);
  if (m.flags & FLAG_CASTLE) s = m.to > m.from ? 'O-O' : 'O-O-O';
  else if (type === PAWN) {
    s = m.captured ? `${'abcdefgh'[fileOf(m.from)]}x${squareName(m.to)}` : squareName(m.to);
    if (m.promotion) s += `=${LETTERS[m.promotion].toUpperCase()}`;
  } else {
    const rivals = legal.filter((o) => o.to === m.to && o.piece === m.piece && o.from !== m.from);
    let which = '';
    if (rivals.length) {
      if (!rivals.some((o) => fileOf(o.from) === fileOf(m.from))) which = 'abcdefgh'[fileOf(m.from)];
      else if (!rivals.some((o) => rankOf(o.from) === rankOf(m.from))) which = String(rankOf(m.from) + 1);
      else which = squareName(m.from);
    }
    s = LETTERS[type].toUpperCase() + which + (m.captured ? 'x' : '') + squareName(m.to);
  }
  pos.make(m);
  if (pos.inCheck()) s += pos.moves().length ? '+' : '#';
  pos.unmake();
  return s;
}

/** Accepts UCI (e2e4, e7e8q) or SAN (e4, Nxf3+, O-O). */
export function findMove(pos: Position, text: string, legal: Move[] = pos.moves()): Move | undefined {
  const t = text.trim();
  const byUci = legal.find((m) => uci(m) === t.toLowerCase());
  if (byUci) return byUci;
  const bare = (s: string) => s.replace(/[+#!?]/g, '').replace(/0/g, 'O');
  return legal.find((m) => bare(san(pos, m, legal)) === bare(t));
}
