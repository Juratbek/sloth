import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.ts on purpose: that one mounts the monitor API, which starts the board
// watcher, and a test run must never tick the real board.
export default defineConfig({
  test: {
    // `.tsx` for the component tests, which name their own jsdom environment with a file pragma so the
    // server tests keep running in node.
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    // Every test gets its own ~/.sloth stand-in through SLOTH_CONFIG; modules cache the config, so isolate.
    isolate: true,
    pool: 'forks',
  },
});
