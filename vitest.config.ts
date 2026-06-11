import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // better-sqlite3 is a native module — keep tests in the main thread pool
    // default; no special config needed, but isolate test files for safety.
    isolate: true,
  },
});
