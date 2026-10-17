# Chess benchmark: gauntlet

Every player against the scripted opponents. Score % is the chess score against each opponent, (wins + ½ draws) / games, averaged over the opponents; ± is the 95% margin of error. Fallback % is the share of the model's moves the bench made for it (late, failed or invalid answers).

24 games per opponent, 300-move cap, 30 s per move, bench version 1, 2026-10-17T20:30:19.695Z.

| # | Player | Kind | Score % | vs random | vs greedy | vs minimax | W / D / L % | Fallback % | Latency | $/game | Games |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| – | Minimax (3 ply) | rules | 78.5 ± 6.9 | 100.0 | 93.8 | 41.7 | 72 / 13 / 15 | 0.0 | 8 ms | – | 72 |
| – | Greedy (1 ply) | rules | 48.6 ± 7.1 | 100.0 | 45.8 | 0.0 | 46 / 6 / 49 | 0.0 | 0 ms | – | 72 |
| 1 | mercury-decide | decision | 43.8 ± 6.7 | 100.0 | 31.3 | 0.0 | 42 / 4 / 54 | 0.0 | 350 ms | $0.0014 | 72 |
| 2 | jev-1.14v | decision | 41.0 ± 6.5 | 97.9 | 25.0 | 0.0 | 38 / 7 / 56 | 0.0 | 214 ms | $0.0030 | 72 |
| 3 | gpt-6-luna-decisions | decision | 38.9 ± 6.1 | 97.9 | 18.8 | 0.0 | 36 / 6 / 58 | 4.0 | 315 ms | $0.0056 | 72 |
| 4 | pplx-decider-v1-2 | decision | 37.5 ± 5.7 | 100.0 | 12.5 | 0.0 | 36 / 3 / 61 | 0.0 | 399 ms | $0.0009 | 72 |
| 5 | drex-v2-0 | decision | 37.5 ± 6.1 | 97.9 | 14.6 | 0.0 | 36 / 3 / 61 | 0.0 | 411 ms | $0.0029 | 72 |
| – | Fact reader | rules | 35.4 ± 5.1 | 100.0 | 6.3 | 0.0 | 35 / 1 / 64 | 0.0 | 0 ms | – | 72 |
| 6 | span-02 | decision | 32.0 ± 5.3 | 91.7 | 4.2 | 0.0 | 29 / 6 / 65 | 0.0 | 356 ms | $0.0004 | 72 |
| 7 | kev-4b | decision | 31.3 ± 4.7 | 93.8 | 0.0 | 0.0 | 29 / 4 / 67 | 0.0 | 623 ms | $0.0017 | 72 |
| 8 | clef | decision | 31.3 ± 4.9 | 91.7 | 0.0 | 2.1 | 28 / 7 / 65 | 0.5 | 357 ms | $0.0025 | 72 |
| 9 | microsoft-decision-1 | decision | 27.1 ± 5.7 | 77.1 | 4.2 | 0.0 | 19 / 15 / 65 | 2.5 | 327 ms | $0.0013 | 72 |
| – | Random mover | rules | 17.4 ± 4.9 | 52.1 | 0.0 | 0.0 | 4 / 26 / 69 | 0.0 | 0 ms | – | 72 |

