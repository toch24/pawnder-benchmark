# Chess benchmark: versus

Every pair of players plays the same games: each opening once from each side. Rating is a Bradley–Terry fit of all games on the Elo scale (the pool averages 1500; 200 points apart ≈ the stronger scores 76%), ± its 95% margin. Ratings only compare players within this pool.

24 games per pair, 300-move cap, 30 s per move, bench version 1, 2026-10-16T20:41:27.605Z.

| # | Player | Kind | Rating | Score % | W / D / L % | Fallback % | Latency | $/game | Games |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Minimax (3 ply) | rules | 2065 ± 102 | 97.9 | 97 / 1 / 1 | 0.0 | 9 ms | – | 72 |
| 2 | Greedy (1 ply) | rules | 1683 ± 79 | 65.3 | 64 / 3 / 33 | 0.0 | 0 ms | – | 72 |
| 3 | Fact reader | rules | 1382 ± 77 | 36.8 | 36 / 1 / 63 | 0.0 | 0 ms | – | 72 |
| 4 | Random mover | rules | 870 ± 61 | 0.0 | 0 / 0 / 100 | 0.0 | 0 ms | – | 72 |

## Head to head

Row player's score against the column player, in percent.

|  | Minimax (3 ply) | Greedy (1 ply) | Fact reader | Random mover |
| --- | --- | --- | --- | --- |
| Minimax (3 ply) | – | 93.8 | 100.0 | 100.0 |
| Greedy (1 ply) | 6.3 | – | 89.6 | 100.0 |
| Fact reader | 0.0 | 10.4 | – | 100.0 |
| Random mover | 0.0 | 0.0 | 0.0 | – |

