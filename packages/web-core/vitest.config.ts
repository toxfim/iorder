import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  // Tests run with the fake adapters allowed, like the apps' own test runs.
  define: { __FAKE_API__: 'true' },
  resolve: {
    alias: [{ find: '@core', replacement: fileURLToPath(new URL('./src', import.meta.url)) }],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    // Same budget as the apps: several suites share one machine.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
