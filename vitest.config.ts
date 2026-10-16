import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Some tests play or replay whole games, which can take a few seconds on a busy CI runner.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000 },
});
