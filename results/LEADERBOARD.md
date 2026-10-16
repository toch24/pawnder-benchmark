# Chess benchmark: gauntlet

Every player against the scripted opponents. Score % is the chess score against each opponent, (wins + ½ draws) / games, averaged over the opponents; ± is the 95% margin of error. Fallback % is the share of the model's moves the bench made for it (late, failed or invalid answers).

24 games per opponent, 300-move cap, 30 s per move, bench version 1, 2026-10-16T20:40:43.441Z.

| # | Player | Kind | Score % | vs random | vs greedy | vs minimax | W / D / L % | Fallback % | Latency | $/game | Games |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| – | Minimax (3 ply) | rules | 78.5 ± 6.9 | 100.0 | 93.8 | 41.7 | 72 / 13 / 15 | 0.0 | 7 ms | – | 72 |
| – | Greedy (1 ply) | rules | 48.6 ± 7.1 | 100.0 | 45.8 | 0.0 | 46 / 6 / 49 | 0.0 | 0 ms | – | 72 |
| – | Fact reader | rules | 35.4 ± 5.1 | 100.0 | 6.3 | 0.0 | 35 / 1 / 64 | 0.0 | 0 ms | – | 72 |
| – | Random mover | rules | 17.4 ± 4.9 | 52.1 | 0.0 | 0.0 | 4 / 26 / 69 | 0.0 | 0 ms | – | 72 |

