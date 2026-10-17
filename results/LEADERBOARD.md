# Chess benchmark: gauntlet

Every player against the scripted opponents. Score % is the chess score against each opponent, (wins + ½ draws) / games, averaged over the opponents; ± is the 95% margin of error. Fallback % is the share of the model's moves the bench made for it (late, failed or invalid answers).

24 games per opponent, 300-move cap, 30 s per move, bench version 1, 2026-10-17T07:44:33.881Z.

| # | Player | Kind | Score % | vs random | vs greedy | vs minimax | W / D / L % | Fallback % | Latency | $/game | Games |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| – | Minimax (3 ply) | rules | 78.5 ± 6.9 | 100.0 | 93.8 | 41.7 | 72 / 13 / 15 | 0.0 | 7 ms | – | 72 |
| – | Greedy (1 ply) | rules | 48.6 ± 7.1 | 100.0 | 45.8 | 0.0 | 46 / 6 / 49 | 0.0 | 0 ms | – | 72 |
| 1 | mercury-decide | decision | 42.4 ± 6.3 | 100.0 | 27.1 | 0.0 | 39 / 7 / 54 | 0.0 | 643 ms | $0.0015 | 72 |
| 2 | gpt-6-luna-decisions | decision | 38.9 ± 6.1 | 97.9 | 18.8 | 0.0 | 36 / 6 / 58 | 4.0 | 423 ms | $0.0056 | 72 |
| 3 | pplx-decider-v1-2 | decision | 38.2 ± 5.7 | 100.0 | 12.5 | 2.1 | 36 / 4 / 60 | 2.7 | 451 ms | $0.0009 | 72 |
| 4 | drex-v2-0 | decision | 37.5 ± 6.1 | 97.9 | 14.6 | 0.0 | 36 / 3 / 61 | 0.0 | 364 ms | $0.0029 | 72 |
| 5 | jev-1.14v | decision | 36.8 ± 5.9 | 95.8 | 14.6 | 0.0 | 33 / 7 / 60 | 0.0 | 215 ms | $0.0029 | 72 |
| – | Fact reader | rules | 35.4 ± 5.1 | 100.0 | 6.3 | 0.0 | 35 / 1 / 64 | 0.0 | 0 ms | – | 72 |
| 6 | d1-ultra | decision | 34.7 ± 5.1 | 95.8 | 6.3 | 2.1 | 31 / 8 / 61 | 6.6 | 286 ms | $0.0018 | 72 |
| 7 | clef | decision | 31.3 ± 4.9 | 91.7 | 0.0 | 2.1 | 28 / 7 / 65 | 0.2 | 433 ms | $0.0025 | 72 |
| 8 | kev-4b | decision | 30.6 ± 4.7 | 91.7 | 0.0 | 0.0 | 28 / 6 / 67 | 0.0 | 591 ms | $0.0018 | 72 |
| 9 | span-02 | decision | 29.9 ± 4.9 | 89.6 | 0.0 | 0.0 | 26 / 7 / 67 | 0.0 | 336 ms | $0.0004 | 72 |
| 10 | microsoft-decision-1 | decision | 29.2 ± 4.9 | 87.5 | 0.0 | 0.0 | 25 / 8 / 67 | 2.9 | 329 ms | $0.0013 | 72 |
| – | Random mover | rules | 17.4 ± 4.9 | 52.1 | 0.0 | 0.0 | 4 / 26 / 69 | 0.0 | 0 ms | – | 72 |

- classify-1 skipped: HTTP 400: ScaleDown state must be a string or an object with only text, document, and document_mime_type, including text or document
- tev1-4b-experimental skipped: tev1-4b-experimental failed 5 calls in a row (last: HTTP 400: Tev1 needs between 2 and 20 options per question; question "move" has 32); its games were stopped so random fallback moves don't count as its play
- solar-decide skipped: solar-decide failed 5 calls in a row (last: HTTP 422: HTTP 422: {"error":{"type":"validation_failed","message":"question move: 34 candidates exceed the 26 single-to); its games were stopped so random fallback moves don't count as its play
