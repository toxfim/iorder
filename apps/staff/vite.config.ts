import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const STAFF_COST_MODULE =
  /[\\/]features[\\/]staff-cost[\\/]|[\\/]dist[\\/](?:contracts[\\/])?(?:cost|staff-catalog|sheet-sync-runs|brands|manual-products|staff-cost)\.js$/;
// Pure pricing helpers (input parsing, names, row filter, messages): no cost names, no Vue.
const PRICING_DOMAIN_MODULE = /[\\/]features[\\/]pricing[\\/]domain[\\/]/;
// The back-office orders UI and the staff order contracts (accounting vocabulary, staff routes).
const STAFF_ORDERS_MODULE =
  /[\\/]features[\\/]staff-orders[\\/]|[\\/]dist[\\/](?:contracts[\\/])?(?:staff-orders|staff-users)\.js$/;

// The organizations screens (group chat ids and who added the bot are staff-only data).
const STAFF_ORGANIZATIONS_MODULE = /[\\/]features[\\/]staff-organizations[\\/]/;

// Staff accounts (logins, Telegram links) and the block dialog with its group-removal status.
const STAFF_USERS_MODULE = /[\\/]features[\\/]staff-users[\\/]/;

// The staff sign-in code: the only place that may contain the Telegram Login Widget URL (the
// customer Mini App never loads a Telegram script; check-bundle enforces both).
// The bot notification and own-profile contracts share the staff-auth entry.
const STAFF_AUTH_MODULE =
  /[\\/]features[\\/]staff-auth[\\/]|[\\/]dist[\\/](?:contracts[\\/])?(?:staff-auth|staff-notifications|staff-profile)\.js$/;

// Back-office prose of the shared screens (dashboard, recent actions, customers, staff...).
const STAFF_COMMON_MODULE = /[\\/]features[\\/]staff-common[\\/]/;

// One config for dev, build and tests (vitest/config re-exports Vite's defineConfig).
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // Fake adapters are allowed when serving (dev server and tests) or when explicitly flagged.
  // VITE_USE_REAL_API=true turns the serve-time default off, so the dev server talks to the real
  // api; VITE_USE_FAKE_API=true wins over it.
  // A compile-time define, not a runtime env read: Vite only folds `import.meta.env.DEV`, and an
  // unset VITE_* variable would stay a runtime check that keeps the fake code in the bundle.
  const fakeApi =
    env.VITE_USE_FAKE_API === 'true' || (command === 'serve' && env.VITE_USE_REAL_API !== 'true');

  return {
    plugins: [vue()],
    define: { __FAKE_API__: JSON.stringify(fakeApi) },
    // theme-init.js, the favicons and the logos are shared with the customer app.
    publicDir: fileURLToPath(new URL('../../packages/web-core/public', import.meta.url)),
    resolve: {
      alias: [
        // Without fakes the module is replaced by a stub: the bundler would otherwise still emit
        // the (unreferenced) fake chunk even though the branch importing it is dead code.
        ...(fakeApi
          ? []
          : [
              {
                find: '@/app/fake-services',
                replacement: fileURLToPath(
                  new URL('./src/app/fake-services.stub.ts', import.meta.url),
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
          // Hard rule 7: the modules that know cost names (the staff-cost UI and the shared cost
          // contracts) go into ONE chunk with "staff" in its file name, the only kind that
          // scripts/check-bundle.mjs lets contain them. Only the matched modules: pulling their
          // dependencies in (the default) would drag Vue itself in and make the entry load it.
          codeSplitting: {
            includeDependenciesRecursively: false,
            groups: [
              { name: 'staff-finance', test: STAFF_COST_MODULE },
              // Pure price helpers that both the price pages and staff-finance use. Left to the
              // default they land in a page chunk that also imports staff-finance, and two chunks
              // importing each other read a binding before it exists (blank app, 2026-10-28).
              { name: 'pricing-domain', test: PRICING_DOMAIN_MODULE },
              { name: 'staff-orders', test: STAFF_ORDERS_MODULE },
              { name: 'staff-organizations', test: STAFF_ORGANIZATIONS_MODULE },
              { name: 'staff-users', test: STAFF_USERS_MODULE },
              { name: 'staff-common', test: STAFF_COMMON_MODULE },
              {
                name: 'website-auth',
                // The Login Widget lives in the shared kit (packages/web-core/src/telegram).
                test: /[\\/]web-core[\\/]src[\\/]telegram[\\/](telegram-widget|components[\\/]TelegramLoginWidget)/,
              },
              { name: 'staff-auth', test: STAFF_AUTH_MODULE },
            ],
          },
        },
      },
    },
    server: {
      port: 5173,
      // IPv4 on purpose: the Telegram Login Widget accepts the domain 127.0.0.1 (set in
      // BotFather) but never "localhost", and Vite otherwise listens on ::1 only.
      host: '127.0.0.1',
      // The real api has root paths that collide with the SPA's own (/staff/...). The web app
      // therefore calls it under /api (VITE_API_BASE_URL=/api) and the prefix is stripped here,
      // exactly as the production reverse proxy must do.
      proxy: {
        // A regex key: the plain '/api' key would also match '/apifoo'.
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
      // Several agents run suites at the same time on one machine; the default 5 s makes
      // lazy-route and source-scanning tests flaky under that load (they pass when run alone).
      testTimeout: 20_000,
      hookTimeout: 30_000,
    },
  };
});
