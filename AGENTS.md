# Agent notes

Read README.md and CONTRIBUTING.md first. Quirks they don't spell out:

- Check with `npm run typecheck && npm test`; add `npm run verify` if game logic or `results/` changed.
- No build step: Node ≥ 22.18 runs the `.ts` files directly. Don't add tsx, ts-node or a `dist/`.
- `tests/bench-version.test.ts` failing means the games changed. Don't just record the new fingerprint: ask first,
  since it means bumping `BENCH_VERSION` and regenerating all committed results.
- Never hand-edit `results/` (`verify` replays the games). Don't regenerate it unprompted: `npm run leaderboard` and
  `npm run versus -- --players all` are slow and spend paid OpenRouter calls.
