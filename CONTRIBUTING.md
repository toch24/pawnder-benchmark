# Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm run typecheck` and `npm test`.

A change that alters the games (the rules, the openings, the opponents or the question a model gets) makes
`tests/bench-version.test.ts` fail. Bump `BENCH_VERSION` in [`src/leaderboard.ts`](src/leaderboard.ts), record the new
fingerprint the test prints, and re-run the committed results (`npm run leaderboard`,
`npm run versus -- --players all`): CI replays the games behind both (`npm run verify`), so stale results fail it.
