import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests use a real PostgreSQL (TEST_DATABASE_URL), never a mock.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ['test/**/*.int-spec.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    // Tests share one database, so they must not run in parallel.
    fileParallelism: false,
    // Order flows walk several steps through a real database; 5 s is too tight on a busy machine.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
