import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { findMove, Position, san, START_FEN, uci } from '../src/chess/board.ts';
import { pick, seedOf } from '../src/chess/engine.ts';

function perft(p: Position, depth: number): number {
  const moves = p.moves();
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) {
    p.make(m);
    n += perft(p, depth - 1);
    p.unmake();
  }
  return n;
}

// The standard perft positions (chessprogramming.org/Perft_Results): every rule, castling through check, en passant
// pins and promotions included, must give exactly these counts.
const PERFT: [string, number[]][] = [
  [START_FEN, [20, 400, 8902, 197281]],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
];

describe('move generation', () => {
  for (const [fen, counts] of PERFT) {
    it(`perft ${fen}`, () => {
      const p = Position.fromFen(fen);
      counts.forEach((n, i) => expect(perft(p, i + 1)).toBe(n));
      expect(p.fen()).toBe(Position.fromFen(fen).fen()); // make/unmake leaves the position as it was
    });
  }

  it('agrees with chess.js on SAN, FEN and the end of random games', () => {
    for (let g = 0; g < 30; g++) {
      const p = Position.fromFen(START_FEN);
      const ref = new Chess();
      for (let ply = 0; ply < 300 && !ref.isGameOver(); ply++) {
        const legal = p.moves();
        expect(legal.map((m) => san(p, m, legal)).sort()).toEqual(ref.moves().sort());
        const m = pick(legal, seedOf(g, ply));
        ref.move(san(p, m, legal));
        p.make(m);
        expect(p.fen()).toBe(ref.fen());
      }
      expect(p.moves().length === 0).toBe(ref.isCheckmate() || ref.isStalemate());
      expect(p.insufficientMaterial()).toBe(ref.isInsufficientMaterial());
    }
  });
});

describe('position', () => {
  it('round-trips FEN', () => {
    for (const [fen] of PERFT) expect(Position.fromFen(fen).fen()).toBe(fen.replace(/ - - /, ' - - '));
  });

  it('refuses a broken FEN', () => {
    expect(() => Position.fromFen('8/8/8 w - - 0 1')).toThrow();
    expect(() => Position.fromFen('8/8/8/8/8/8/8/8 w - - 0 1')).toThrow(/king/);
  });

  it('finds moves written in UCI or SAN', () => {
    const p = Position.fromFen(START_FEN);
    expect(uci(findMove(p, 'e2e4')!)).toBe('e2e4');
    expect(uci(findMove(p, 'Nf3')!)).toBe('g1f3');
    expect(findMove(p, 'e5')).toBeUndefined();
  });

  it('knows insufficient material', () => {
    expect(Position.fromFen('8/8/4k3/8/8/3K4/8/8 w - - 0 1').insufficientMaterial()).toBe(true);
    expect(Position.fromFen('8/8/4k3/8/8/3KN3/8/8 w - - 0 1').insufficientMaterial()).toBe(true);
    expect(Position.fromFen('8/8/4kb2/8/8/3KB3/8/8 w - - 0 1').insufficientMaterial()).toBe(true); // same-colored bishops
    expect(Position.fromFen('8/8/4k1b1/8/8/3KB3/8/8 w - - 0 1').insufficientMaterial()).toBe(false);
    expect(Position.fromFen('8/8/4k3/8/8/3KNN2/8/8 w - - 0 1').insufficientMaterial()).toBe(false);
    expect(Position.fromFen('8/8/4k3/8/8/3KP3/8/8 w - - 0 1').insufficientMaterial()).toBe(false);
  });
});
