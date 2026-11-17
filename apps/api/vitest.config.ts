import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Vitest's default transformer (esbuild) drops decorator metadata, which breaks NestJS DI.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ['src/**/*.spec.ts'],
    // Suites also run while other processes load the machine; see apps/staff/vite.config.ts.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
