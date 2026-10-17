# Chess benchmark: versus

Every pair of players plays the same games: each opening once from each side. Rating is a Bradley–Terry fit of all games on the Elo scale (the pool averages 1500; 200 points apart ≈ the stronger scores 76%), ± its 95% margin. Ratings only compare players within this pool.

24 games per pair, 300-move cap, 30 s per move, bench version 1, 2026-10-17T18:10:11.589Z.

| # | Player | Kind | Rating | Score % | W / D / L % | Fallback % | Latency | $/game | Games |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | pplx-decider-v1-2 | decision | 1635 ± 27 | 69.2 | 47 / 45 / 8 | 0.1 | 409 ms | $0.0014 | 216 |
| 2 | mercury-decide | decision | 1610 ± 27 | 65.7 | 43 / 45 / 12 | 0.4 | 379 ms | $0.0018 | 216 |
| 3 | drex-v2-0 | decision | 1578 ± 26 | 61.1 | 35 / 53 / 13 | 0.0 | 392 ms | $0.0031 | 216 |
| 4 | jev-1.14v | decision | 1567 ± 25 | 59.5 | 30 / 59 / 11 | 0.6 | 247 ms | $0.0028 | 216 |
| 5 | gpt-6-luna-decisions | decision | 1562 ± 26 | 58.8 | 33 / 51 / 16 | 1.2 | 305 ms | $0.0075 | 216 |
| 6 | d1-ultra | decision | 1554 ± 25 | 57.6 | 26 / 63 / 11 | 1.1 | 320 ms | $0.0020 | 216 |
| 7 | span-02 | decision | 1457 ± 26 | 43.1 | 12 / 63 / 26 | 0.1 | 358 ms | $0.0004 | 216 |
| 8 | clef | decision | 1449 ± 24 | 41.9 | 12 / 61 / 28 | 0.1 | 364 ms | $0.0026 | 216 |
| 9 | kev-4b | decision | 1317 ± 33 | 24.1 | 5 / 39 / 57 | 0.9 | 561 ms | $0.0015 | 216 |
| 10 | microsoft-decision-1 | decision | 1272 ± 30 | 19.0 | 2 / 33 / 64 | 1.7 | 314 ms | $0.0011 | 216 |

## Head to head

Row player's score against the column player, in percent.

|  | pplx-decider-v1-2 | mercury-decide | drex-v2-0 | jev-1.14v | gpt-6-luna-decisions | d1-ultra | span-02 | clef | kev-4b | microsoft-decision-1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pplx-decider-v1-2 | – | 56.3 | 58.3 | 43.8 | 62.5 | 56.3 | 72.9 | 79.2 | 95.8 | 97.9 |
| mercury-decide | 43.8 | – | 52.1 | 54.2 | 62.5 | 56.3 | 60.4 | 77.1 | 91.7 | 93.8 |
| drex-v2-0 | 41.7 | 47.9 | – | 52.1 | 54.2 | 45.8 | 66.7 | 68.8 | 83.3 | 89.6 |
| jev-1.14v | 56.3 | 45.8 | 47.9 | – | 47.9 | 47.9 | 68.8 | 58.3 | 81.3 | 81.3 |
| gpt-6-luna-decisions | 37.5 | 37.5 | 45.8 | 52.1 | – | 50.0 | 68.8 | 66.7 | 87.5 | 83.3 |
| d1-ultra | 43.8 | 43.8 | 54.2 | 52.1 | 50.0 | – | 60.4 | 56.3 | 72.9 | 85.4 |
| span-02 | 27.1 | 39.6 | 33.3 | 31.3 | 31.3 | 39.6 | – | 43.8 | 64.6 | 77.1 |
| clef | 20.8 | 22.9 | 31.3 | 41.7 | 33.3 | 43.8 | 56.3 | – | 62.5 | 64.6 |
| kev-4b | 4.2 | 8.3 | 16.7 | 18.8 | 12.5 | 27.1 | 35.4 | 37.5 | – | 56.3 |
| microsoft-decision-1 | 2.1 | 6.3 | 10.4 | 18.8 | 16.7 | 14.6 | 22.9 | 35.4 | 43.8 | – |

