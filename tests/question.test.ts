import { describe, expect, it } from 'vitest';
import { Position, uci } from '../src/chess/board.ts';
import { Game, setupFor } from '../src/game.ts';
import { chooseFromFacts } from '../src/players.ts';
import { buildRequest, describeMove, MOVE_QUESTION } from '../src/question.ts';

const facts = (fen: string, move: string) => {
  const pos = Position.fromFen(fen);
  const legal = pos.moves();
  return describeMove(pos, legal.find((m) => uci(m) === move)!, legal);
};

describe('the move question', () => {
  it('offers exactly the legal moves, keyed by UCI', () => {
    for (const i of [0, 1, 6, 17]) {
      const game = new Game(setupFor(i));
      if (!game.modelToMove) continue;
      const q = buildRequest(game).questions[MOVE_QUESTION];
      expect(Object.keys(q.criteria).sort()).toEqual(game.pos.moves().map(uci).sort());
      expect(q.type).toBe('choice');
    }
  });

  it('describes the position for the side to move', () => {
    const game = new Game(setupFor(0));
    const { state } = buildRequest(game);
    expect(state.you).toBe('White');
    expect(state.moves).toBe('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5');
    expect(state.fen).toBe(game.pos.fen());
  });

  it('marks mate, stalemate, checks and captures', () => {
    expect(facts('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'h5f7')).toMatch(/^Qxf7#: queen h5→f7; captures a pawn; CHECKMATE/);
    expect(facts('7k/8/6Q1/8/8/8/8/K7 w - - 0 1', 'g6f7')).toMatch(/STALEMATE/);
    expect(facts('4k3/8/8/8/8/8/8/R3K3 w Q - 0 1', 'a1a8')).toMatch(/gives check/);
    expect(facts('4k3/8/8/8/8/8/8/R3K3 w Q - 0 1', 'e1c1')).toMatch(/^O-O-O: castles queenside/);
  });

  it('marks pieces left to be taken and mates allowed', () => {
    // The knight steps where a pawn takes it.
    expect(facts('4k3/8/8/3p4/8/2N5/8/4K3 w - - 0 1', 'c3e4')).toMatch(/UNSAFE: the knight on e4 can be taken by the pawn on d5/);
    // A defended piece attacked only by something worth more is safe.
    expect(facts('4k3/8/8/2q5/8/2P5/4N3/4K3 w - - 0 1', 'e2d4')).not.toMatch(/UNSAFE/);
    // A back-rank mate is coming unless White makes room for the king.
    expect(facts('3r2k1/8/8/8/N7/8/5PPP/6K1 w - - 0 1', 'a4b6')).toMatch(/ALLOWS MATE IN ONE/);
    expect(facts('3r2k1/8/8/8/N7/8/5PPP/6K1 w - - 0 1', 'h2h3')).not.toMatch(/ALLOWS MATE/);
  });

  it('counts only captures that can legally be made, at conventional values', () => {
    // The knight on e5 is pinned to its king by the rook: it can't take the queen.
    expect(facts('4k3/8/8/4n3/8/8/4R3/3QK3 w - - 0 1', 'd1d3')).not.toMatch(/UNSAFE/);
    // A defended bishop taken by a knight is an even trade (3 for 3), not a loss; the same goes the other way round.
    expect(facts('4k3/8/2n5/8/3P1B2/8/8/4K3 w - - 0 1', 'f4e5')).not.toMatch(/UNSAFE/);
    expect(facts('4k3/2b5/8/8/3P4/5N2/8/4K3 w - - 0 1', 'f3e5')).not.toMatch(/UNSAFE/);
    // Defended only by the king, which can't take back where a rook also covers: the knight is lost.
    expect(facts('3rk3/8/8/8/1b6/8/3N3P/4K3 w - - 0 1', 'h2h3')).toMatch(/leaves hanging: the knight on d2/);
    // A pawn pushed two squares next to an enemy pawn can be taken en passant.
    expect(facts('4k3/8/8/8/4p3/8/3P4/4K3 w - - 0 1', 'd2d4')).toMatch(/UNSAFE: the pawn on d4 can be taken by the pawn on e4 \(loses 1/);
    // Attacked twice and defended once: the trades lose the rook.
    expect(facts('3rk3/3r4/8/8/8/8/8/R3K3 w - - 0 1', 'a1d1')).toMatch(/UNSAFE: the rook on d1 can be taken by the rook on d7 \(loses 5/);
    // Knight against bishop is level.
    expect(facts('4k3/8/8/3b4/8/2n5/8/1N2K3 w - - 0 1', 'b1c3')).toMatch(/^Nxc3: knight b1→c3; captures a knight; .*material after: 0$/);
  });

  it('names what a move attacks, a check included, without counting the check against the defence', () => {
    // A knight fork: check, and the rook on a8 to take next.
    expect(facts('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7')).toMatch(/gives check; then attacks: the rook on a8$/);
    // After Bb5+ the pawn on d5 stays defended twice: no threat.
    expect(facts('rn1qkb1r/ppp1pppp/5n2/3p4/3P4/2N1P3/PPP2PPP/R1BQKBNR w KQkq - 0 1', 'f1b5')).toBe('Bb5+: bishop f1→b5; gives check');
  });

  it('says how many moves are left before the move cap, and which move reaches it', () => {
    const game = new Game(setupFor(0), 2);
    const { state, questions } = buildRequest(game);
    expect(state.movesLeftBeforeCap).toBe(2);
    expect(questions[MOVE_QUESTION].instructions).toContain('drawn after 2 more moves');
    expect(questions[MOVE_QUESTION].criteria.d2d3).not.toMatch(/DRAW/);
    game.play(game.pos.moves().find((m) => uci(m) === 'd2d3')!);
    const last = buildRequest(game).questions[MOVE_QUESTION];
    expect(last.instructions).toContain('drawn after 1 more move,');
    expect(last.criteria.d7d6).toMatch(/DRAW: the move cap is reached$/);
  });

  it('warns about repetitions and says when a move draws', () => {
    const game = new Game(setupFor(0)); // Italian Game, the model is White
    const play = (...moves: string[]) => moves.forEach((m) => game.play(game.pos.moves().find((x) => uci(x) === m)!));
    const criteria = () => buildRequest(game).questions[MOVE_QUESTION].criteria;
    expect(criteria().f3g5).not.toMatch(/repeats/);
    play('f3g5', 'g8f6', 'g5f3', 'f6g8'); // back where the opening left off
    expect(criteria().f3g5).toMatch(/repeats an earlier position/);
    play('f3g5', 'g8f6', 'g5f3');
    expect(criteria().f6g8).toMatch(/^Ng8: knight f6→g8; DRAW by threefold repetition$/);
    expect(facts('4k3/8/8/8/8/2p5/4N3/4K3 w - - 0 1', 'e2c3')).toMatch(/captures a pawn; DRAW: neither side has enough material left to mate$/);
    expect(facts('4k3/8/8/8/8/8/8/R3K3 w - - 99 80', 'a1a2')).toMatch(/DRAW by the fifty-move rule$/);
  });

  it('can be answered from the facts alone', () => {
    const q = { type: 'choice' as const, instructions: '', criteria: { a: 'a: UNSAFE', b: 'b: captures a pawn', c: 'c: CHECKMATE: wins the game' } };
    expect(chooseFromFacts(q)).toBe('c');
    expect(chooseFromFacts({ ...q, criteria: { a: 'a: UNSAFE; captures a rook', b: 'b: captures a pawn' } })).toBe('b');
    // Ahead it keeps away from draws and repetitions; well behind, it takes the draw.
    const drawish = { ...q, criteria: { a: 'a: repeats an earlier position (a third time is a draw)', b: 'b: DRAW by threefold repetition', c: 'c: rook a1→a2' } };
    expect(chooseFromFacts(drawish, { materialLead: 3 })).toBe('c');
    expect(chooseFromFacts(drawish, { materialLead: -5 })).toBe('b');
  });
});
