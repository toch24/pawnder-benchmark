import { describe, expect, it } from 'vitest';
import { BLACK, findMove, WHITE } from '../src/chess/board.ts';
import { Game, moveSeed, OPENINGS, playGame, setupFor } from '../src/game.ts';
import { RULES } from '../src/leaderboard.ts';

describe('game setup', () => {
  it('covers every opening from both sides in 24 games', () => {
    const setups = Array.from({ length: 24 }, (_, i) => setupFor(i));
    for (const opening of OPENINGS) {
      const mine = setups.filter((s) => s.opening === opening);
      expect(mine.map((s) => s.model).sort()).toEqual([WHITE, BLACK]);
    }
    expect(RULES.minGames).toBe(2 * OPENINGS.length);
  });

  it('plays every opening legally', () => {
    for (let i = 0; i < 2 * OPENINGS.length; i++) {
      const game = new Game(setupFor(i));
      expect(game.san.length).toBe(setupFor(i).opening.moves.length);
      expect(game.plies).toEqual([]);
    }
  });

  it('derives the random choices from the game, the move and the side', () => {
    const setup = setupFor(5);
    expect(moveSeed(setup, 0, 'minimax')).toBe(moveSeed(setupFor(5), 0, 'minimax'));
    expect(moveSeed(setup, 0, 'minimax')).not.toBe(moveSeed(setupFor(6), 0, 'minimax'));
    expect(moveSeed(setup, 0, 'minimax')).not.toBe(moveSeed(setup, 1, 'minimax'));
    expect(moveSeed(setup, 0, 'minimax')).not.toBe(moveSeed(setup, 0, 'fallback'));
  });

  it('counts how often each position occurred', () => {
    const game = new Game(setupFor(0));
    expect(game.occurrences(game.pos.key())).toBe(1);
    const play = (...moves: string[]) => moves.forEach((m) => game.play(findMove(game.pos, m)!));
    play('Ng5', 'Nf6', 'Nf3', 'Ng8');
    expect(game.occurrences(game.pos.key())).toBe(2);
  });

  it('refuses a game number that is not one', () => {
    expect(() => setupFor(-1)).toThrow();
    expect(() => setupFor(1.5)).toThrow();
  });
});

describe('game end', () => {
  const play = (game: Game, ...moves: string[]) => moves.forEach((m) => game.play(findMove(game.pos, m)!));

  it('calls threefold repetition a draw', () => {
    const game = new Game(setupFor(0));
    play(game, 'Ng5', 'Nf6', 'Nf3', 'Ng8', 'Ng5', 'Nf6', 'Nf3');
    expect(game.termination(RULES.maxPlies)).toBe(null);
    play(game, 'Ng8');
    expect(game.termination(RULES.maxPlies)).toBe('threefold-repetition');
    expect(game.outcome('threefold-repetition')).toBe('draw');
  });

  it('caps the game after the opening', () => {
    const game = new Game(setupFor(0));
    play(game, 'Nc3', 'Nf6');
    expect(game.termination(2)).toBe('move-cap');
  });

  it('scores checkmate for the side that gave it', async () => {
    // The model (White in game 0) plays a random-ish game against random; whatever happens, a mate is scored right.
    const { game, termination, outcome } = await playGame(setupFor(0), 'random', RULES.maxPlies, (g) => g.pos.moves()[0]);
    if (termination === 'checkmate') expect(outcome).toBe(game.pos.turn === WHITE ? 'loss' : 'win');
    else expect(outcome).toBe('draw');
  });
});
