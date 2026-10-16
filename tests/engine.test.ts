import { describe, expect, it } from 'vitest';
import { Position, START_FEN, uci } from '../src/chess/board.ts';
import { bestMoves, CONTEMPT, evaluate, opponentMove, OPPONENTS, pick, rng, seedOf, VARIETY } from '../src/chess/engine.ts';

describe('engine', () => {
  it('scores the start position as level', () => {
    expect(evaluate(Position.fromFen(START_FEN))).toBe(0);
  });

  it('every opponent but random takes a mate in one', () => {
    // Scholar's mate: Qxf7#.
    const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    for (const id of ['greedy', 'minimax'] as const) expect(uci(opponentMove(id, Position.fromFen(fen), 1))).toBe('h5f7');
  });

  it('takes a hanging queen but not a poisoned pawn', () => {
    expect(uci(opponentMove('greedy', Position.fromFen('4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1'), 1))).toBe('d2d5');
    // The queen is defended by a pawn, but the queen for the rook still wins.
    expect(uci(opponentMove('minimax', Position.fromFen('4k3/8/4p3/3q4/8/8/3R4/4K3 w - - 0 1'), 1))).toBe('d2d5');
    // A pawn guarded by a pawn, attacked by the queen: greedy plays out the capture and sees the queen lost.
    const poisoned = Position.fromFen('4k3/8/2p5/3p4/8/8/8/3QK3 w - - 0 1');
    expect(uci(opponentMove('greedy', poisoned, 1))).not.toBe('d1d5');
    expect(uci(opponentMove('minimax', poisoned, 1))).not.toBe('d1d5');
  });

  it('lists every move tied for best', () => {
    const { moves, score } = bestMoves(Position.fromFen(START_FEN), 1);
    expect(moves.length).toBeGreaterThan(0);
    expect(score).toBeGreaterThan(0);
  });

  it('is reproducible: the same seed gives the same move, different seeds can differ', () => {
    const pos = Position.fromFen(START_FEN);
    for (const id of OPPONENTS) expect(uci(opponentMove(id, pos, 7))).toBe(uci(opponentMove(id, pos, 7)));
    const picks = new Set(Array.from({ length: 20 }, (_, s) => uci(opponentMove('random', pos, seedOf(s)))));
    expect(picks.size).toBeGreaterThan(1);
    expect(uci(pick(pos.moves(), 3))).toBe(uci(pick([...pos.moves()].reverse(), 3)));
  });

  it('has a seeded generator in [0, 1)', () => {
    const r = rng(42);
    const xs = Array.from({ length: 1000 }, r);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(rng(42)()).toBe(xs[0]);
  });
});

/** The position key after `move` in `pos`, without changing `pos`. */
function keyAfter(pos: Position, ...moves: string[]): string {
  const p = Position.fromFen(pos.fen());
  for (const text of moves) p.make(p.moves().find((m) => uci(m) === text)!);
  return p.key();
}

describe('draws and repetition', () => {
  const queenUp = (turn: 'w' | 'b') => Position.fromFen(`4k3/8/8/8/8/8/3Q4/4K3 ${turn} - - 0 1`);

  it('avoids going back to an earlier position when ahead', () => {
    const pos = queenUp('w');
    const first = uci(opponentMove('minimax', pos, 1));
    const key = keyAfter(pos, first);
    expect(bestMoves(pos, 3, { seen: (k) => (k === key ? 1 : 0) }).moves.map(uci)).not.toContain(first);
  });

  it('sees the reply that would repeat a position, and avoids allowing it', () => {
    const pos = queenUp('w');
    const first = uci(opponentMove('minimax', pos, 1));
    const reply = (() => {
      const p = Position.fromFen(pos.fen());
      p.make(p.moves().find((m) => uci(m) === first)!);
      return uci(p.moves()[0]);
    })();
    const key = keyAfter(pos, first, reply);
    expect(bestMoves(pos, 3, { seen: (k) => (k === key ? 1 : 0) }).moves.map(uci)).not.toContain(first);
  });

  it('heads for a repetition when behind, valuing the draw at -CONTEMPT', () => {
    const pos = queenUp('b');
    const target = uci(pos.moves()[0]);
    const key = keyAfter(pos, target);
    const { moves, score } = bestMoves(pos, 3, { seen: (k) => (k === key ? 1 : 0) });
    expect(moves.map(uci)).toEqual([target]);
    expect(score).toBe(-CONTEMPT);
  });

  it('pays the stronger side for driving a bare king to the edge', () => {
    const edge = evaluate(Position.fromFen('k7/8/8/8/8/8/8/4K2Q w - - 0 1'));
    const centre = evaluate(Position.fromFen('8/8/8/3k4/8/8/8/4K2Q w - - 0 1'));
    expect(edge).toBeGreaterThan(centre + 300);
  });

  it('mates a bare king with a queen or a rook inside the fifty-move rule', () => {
    for (const fen of ['8/8/8/4k3/8/8/8/K6Q w - - 0 1', '8/8/8/4k3/8/8/8/K6R w - - 0 1']) {
      for (const seed of [1, 2]) {
        const p = Position.fromFen(fen);
        const seen = new Map<string, number>([[p.key(), 1]]);
        let end = 'none';
        for (let ply = 0; ply < 200 && end === 'none'; ply++) {
          if (!p.moves().length) end = p.inCheck() ? 'mate' : 'stalemate';
          else if (p.halfmove >= 100) end = 'fifty-move';
          else if ((seen.get(p.key()) ?? 0) >= 3) end = 'threefold';
          else {
            // The defender plays the same search, trying to survive (and to repeat).
            p.make(opponentMove('minimax', p, seedOf(seed, ply), (k) => seen.get(k) ?? 0));
            seen.set(p.key(), (seen.get(p.key()) ?? 0) + 1);
          }
        }
        expect(end, `${fen} seed ${seed}`).toBe('mate');
      }
    }
  });
});

describe('variety', () => {
  it('picks among the moves within the margin of the best', () => {
    const start = Position.fromFen(START_FEN);
    expect(bestMoves(start, 3, { margin: VARIETY }).moves.length).toBeGreaterThan(1);
    const picks = new Set(Array.from({ length: 12 }, (_, s) => uci(opponentMove('minimax', start, seedOf(s)))));
    expect(picks.size).toBeGreaterThan(1);
  });

  it('never trades a mate for variety', () => {
    const scholar = Position.fromFen('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
    expect(bestMoves(scholar, 3, { margin: 500 }).moves.map(uci)).toEqual(['h5f7']);
  });
});
