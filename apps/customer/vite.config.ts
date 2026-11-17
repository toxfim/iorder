import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// One config for dev, build and tests (vitest/config re-exports Vite's defineConfig).
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // Same gate as the staff app: fakes when serving (dev server and tests) unless
  // VITE_USE_REAL_API=true, or in any build with VITE_USE_FAKE_API=true. A compile-time define, so
  // a production build drops the fake code (check-bundle verifies it).
  const fakeApi =
    env.VITE_USE_FAKE_API === 'true' || (command === 'serve' && env.VITE_USE_REAL_API !== 'true');

  return {
    plugins: [vue()],
    define: { __FAKE_API__: JSON.stringify(fakeApi) },
    // theme-init.js, the favicons and the logos are shared with the staff app.
    publicDir: fileURLToPath(new URL('../../packages/web-core/public', import.meta.url)),
    resolve: {
      alias: [
        // Without fakes the module is replaced by a stub, so its chunk is never emitted.
        ...(fakeApi
          ? []
          : [
              {
                find: '@/features/customer-app/fake-customer-services',
                replacement: fileURLToPath(
                  new URL(
                    './src/features/customer-app/fake-customer-services.stub.ts',
                    import.meta.url,
                  ),
                ),
              },
            ]),
        {
          find: '@core',
          replacement: fileURLToPath(new URL('../../packages/web-core/src', import.meta.url)),
        },
        { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      ],
      // The kit lives outside this package: one copy of each runtime, whichever folder imports it.
      dedupe: ['vue', 'vue-i18n', 'vue-router'],
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            includeDependenciesRecursively: false,
            groups: [
              {
                // The Login Widget (the only Telegram script check-bundle allows) stays in its own
                // lazy chunk: the Mini App never loads it.
                name: 'website-auth',
                test: /[\\/]web-core[\\/]src[\\/]telegram[\\/](telegram-widget|components[\\/]TelegramLoginWidget)/,
              },
            ],
          },
        },
      },
    },
    server: {
      // The staff app uses 5173.
      port: 5174,
      // IPv4 on purpose: the Telegram Login Widget accepts the domain 127.0.0.1 (set in
      // BotFather) but never "localhost", and Vite otherwise listens on ::1 only.
      host: '127.0.0.1',
      // Same /api prefix as the staff app; stripped here as the production reverse proxy must.
      proxy: {
        '^/api/': {
          target: env.VITE_DEV_API_PROXY_TARGET || 'http://127.0.0.1:3000',
          changeOrigin: false,
          rewrite: (path: string) => path.replace(/^\/api/, ''),
        },
      },
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.ts'],
      setupFiles: ['./src/test-setup.ts'],
      // Several suites share one machine; see apps/staff/vite.config.ts.
      testTimeout: 20_000,
      hookTimeout: 30_000,
    },
  };
});
