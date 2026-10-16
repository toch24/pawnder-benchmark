import { BLACK, findMove, Position, san, START_FEN, uci, WHITE, type Color, type Move } from './chess/board.ts';
import { material, opponentMove, seedOf, type OpponentId } from './chess/engine.ts';
import { RULES } from './leaderboard.ts';

/** Game N starts after opening ⌊N/2⌋ (mod the list), the model White in even games: 24 games cover each from both sides. */
export const OPENINGS: { name: string; moves: string[] }[] = [
  { name: 'Italian Game', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'] },
  { name: 'Ruy Lopez', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'] },
  { name: 'Sicilian Defence', moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6'] },
  { name: 'French Defence', moves: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6'] },
  { name: 'Caro-Kann Defence', moves: ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5'] },
  { name: 'Scandinavian Defence', moves: ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5'] },
  { name: "Queen's Gambit Declined", moves: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6'] },
  { name: 'Slav Defence', moves: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6'] },
  { name: "King's Indian Defence", moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6'] },
  { name: 'Nimzo-Indian Defence', moves: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'] },
  { name: 'London System', moves: ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4', 'e6'] },
  { name: 'English Opening', moves: ['c4', 'e5', 'Nc3', 'Nf6', 'Nf3', 'Nc6'] },
];

export interface GameSetup {
  index: number;
  opening: (typeof OPENINGS)[number];
  model: Color;
}

export function setupFor(index: number): GameSetup {
  if (!Number.isInteger(index) || index < 0) throw new Error(`no game ${index}`);
  return { index, opening: OPENINGS[Math.floor(index / 2) % OPENINGS.length], model: index % 2 === 0 ? WHITE : BLACK };
}

/** Seeds every random choice in a game (opponent tie-breaks, fallback moves), so games replay exactly. */
export const moveSeed = (setup: GameSetup, ply: number, who: string): number => seedOf(setup.index, ply, who);

export type Termination = 'checkmate' | 'stalemate' | 'insufficient-material' | 'fifty-move' | 'threefold-repetition' | 'move-cap';
export type Outcome = 'win' | 'draw' | 'loss';

export class Game {
  readonly pos = Position.fromFen(START_FEN);
  readonly san: string[] = [];
  /** After the opening only, in UCI; `san` includes the opening. */
  readonly plies: string[] = [];
  private seen = new Map<string, number>();
  readonly setup: GameSetup;
  readonly maxPlies: number;

  constructor(setup: GameSetup, maxPlies: number = RULES.maxPlies) {
    this.setup = setup;
    this.maxPlies = maxPlies;
    this.count();
    for (const text of setup.opening.moves) {
      const m = findMove(this.pos, text);
      if (!m) throw new Error(`${setup.opening.name}: ${text} is not legal`);
      this.play(m, false);
    }
  }

  private count(): void {
    const key = this.pos.key();
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
  }

  play(m: Move, counts = true): void {
    this.san.push(san(this.pos, m));
    if (counts) this.plies.push(uci(m));
    this.pos.make(m);
    this.count();
  }

  occurrences(key: string): number {
    return this.seen.get(key) ?? 0;
  }

  get modelToMove(): boolean {
    return this.pos.turn === this.setup.model;
  }

  termination(maxPlies: number = this.maxPlies): Termination | null {
    const p = this.pos;
    if (!p.moves().length) return p.inCheck() ? 'checkmate' : 'stalemate';
    if (p.insufficientMaterial()) return 'insufficient-material';
    if (p.halfmove >= 100) return 'fifty-move';
    if ((this.seen.get(p.key()) ?? 0) >= 3) return 'threefold-repetition';
    if (this.plies.length >= maxPlies) return 'move-cap';
    return null;
  }

  outcome(t: Termination): Outcome {
    if (t !== 'checkmate') return 'draw';
    return this.pos.turn === this.setup.model ? 'loss' : 'win';
  }

  materialLead(): number {
    return material(this.pos, this.setup.model) / 100;
  }
}

export const ruleMove = (game: Game, id: OpponentId, who: string = id): Move =>
  opponentMove(id, game.pos, moveSeed(game.setup, game.plies.length, who), (key) => game.occurrences(key));

export const scriptedMove = (game: Game, id: OpponentId): Move => ruleMove(game, id);

export const fallbackMove = (game: Game): Move => ruleMove(game, 'random', 'fallback');

export interface PlayedGame {
  game: Game;
  termination: Termination;
  outcome: Outcome;
}

/** The one game loop shared by both modes and the verifiers, so a replay ends exactly as the game did. */
export async function playSides(setup: GameSetup, maxPlies: number, moveFor: (game: Game) => Promise<Move> | Move): Promise<PlayedGame> {
  const game = new Game(setup, maxPlies);
  for (;;) {
    const termination = game.termination();
    if (termination) return { game, termination, outcome: game.outcome(termination) };
    // Yield to the event loop: a game between built-in players never awaits I/O, and would otherwise starve the
    // network replies and timers of parallel games until it ends.
    await new Promise<void>((resolve) => setImmediate(resolve));
    game.play(await moveFor(game));
  }
}

export const playGame = (setup: GameSetup, opponent: OpponentId, maxPlies: number, modelMove: (game: Game) => Promise<Move> | Move): Promise<PlayedGame> =>
  playSides(setup, maxPlies, (game) => (game.modelToMove ? modelMove(game) : scriptedMove(game, opponent)));
