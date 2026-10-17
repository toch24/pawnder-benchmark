# Chess benchmark

Decision models are fast and accurate. So who makes better decisions at chess?

## How it works

- Every move, the model gets one multiple-choice question: the legal moves, each described with facts (captures,
  checks, unsafe squares, hanging pieces, mates).
- It picks one. A wrong, failed, or late (>30 s) answer becomes a random legal move and counts as a **fallback**.
- **Versus** (the official comparison): models play each other and get an Elo-scale rating.
- **Gauntlet**: a model plays scripted opponents (`random`, `greedy`, `minimax`) for a fixed, absolute score.
- Games are deterministic and recorded, so every result replays to the same numbers.

## Results

- [`results/VERSUS.md`](results/VERSUS.md): ratings and head-to-head scores
- [`results/LEADERBOARD.md`](results/LEADERBOARD.md): gauntlet scores

## Installation

Requires Node ≥ 22.18.

```bash
npm install
cp .env.example .env   # add OPENROUTER_API_KEY
```

## Usage

```bash
npm run versus -- systemone:jev-latest ollama:llama3.1:8b   # two models, 24 games
npm run bench -- systemone:jev-latest                       # one model vs the scripted opponents
npm run models -- --check                                   # list players, check each one answers
```

Runs write to `runs/<a>-vs-<b>/`. Use `--resume` to continue a stopped run.

### Models

Models are named `provider:model`:

| provider    | example                        | how the question is sent                                         | needs                    |
| ----------- | ------------------------------ | ---------------------------------------------------------------- | ------------------------ |
| `systemone` | `systemone:jev-latest`         | as-is to OpenRouter's [System One API][s1]                       | `OPENROUTER_API_KEY`     |
| `ollama`    | `ollama:llama3.1:8b`           | as a chat prompt; the reply is read as an option key or SAN move | Ollama running           |
| `lmstudio`  | `lmstudio:qwen2.5-7b-instruct` | as a chat prompt; the reply is read as an option key or SAN move | LM Studio server running |

[s1]: https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request

Built-in baselines: `random`, `facts`, `greedy`, `minimax`.

Give models short ids in `players.json`, or set `MODELS=a,b` in `.env` to play them by default.

### Commands

| command                           | does                                                      |
| --------------------------------- | --------------------------------------------------------- |
| `npm run versus -- <a> <b> …`     | round robin between players                               |
| `npm run versus -- --players all` | every model vs every model → `results/VERSUS.md`          |
| `npm run bench -- <player>`       | one player vs the scripted opponents                      |
| `npm run leaderboard`             | every player vs every opponent → `results/LEADERBOARD.md` |
| `npm run models`                  | list available players                                    |
| `npm run verify`                  | replay committed games and check they match the results   |

Common flags: `--games`, `--parallel`, `--timeout` (ms per move).

## Using your own server

Any HTTP endpoint that speaks this protocol can play:

```bash
npm run versus -- --endpoint mine=http://localhost:8787 greedy minimax
```

Each move, the bench POSTs (System One gets the same request; Ollama and LM Studio get it as a chat prompt):

```json
{
  "state": { "fen": "…", "you": "White", "moves": "1. e4 e5 2. Nf3 Nc6", "board": ["…"], "materialLead": 0 },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "You are playing chess as White…",
      "criteria": {
        "d2d4": "d4: pawn d2→d4; UNSAFE: the pawn on d4 can be taken by the pawn on e5 (loses 1 in the trades there)",
        "e1g1": "O-O: castles kingside"
      }
    }
  }
}
```

and expects:

```json
{ "answers": { "move": { "type": "choice", "choice": "d2d4" } } }
```

The option keys are the legal moves in UCI.

## Project structure

```
src/
  chess/board.ts    chess rules: legal moves, FEN, SAN, UCI
  chess/engine.ts   evaluation, search, scripted opponents
  game.ts           openings, draw rules, game loop
  question.ts       the question a model gets each move
  players.ts        baselines, HTTP endpoints, players.json
  providers.ts      provider:model → System One, Ollama, LM Studio
  run.ts            asking for a move: timeouts, fallbacks
  versus.ts         versus games, ratings, PGN
  leaderboard.ts    scoring, ranking, BENCH_VERSION
  recording.ts      game recordings and replay
  report.ts         LEADERBOARD.md output
  cli.ts            shared CLI helpers
scripts/            bench, versus, models, verify
tests/              unit tests
results/            committed leaderboard, versus results, recorded games
```

## Contributing

Issues and PRs welcome. Run `npm run typecheck` and `npm test` first.

If you change the rules, openings, opponents, or question, `tests/bench-version.test.ts` fails. Bump `BENCH_VERSION` in
`src/leaderboard.ts` and re-run the committed results. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements

Built on the design of [jevman-benchmark](https://github.com/opper-ai/jevman-benchmark) (AGPL-3.0), which benchmarks
models on Pac-Man. Parts of the code are adapted from it.
