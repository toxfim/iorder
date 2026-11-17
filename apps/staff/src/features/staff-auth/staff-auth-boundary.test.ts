import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listFrontendFiles, repoRelative } from '@core/test-utils/frontend-sources';

// Source scans that keep the staff sign-in code (and Telegram's widget script) away from the
// customer Mini App and out of the eager entry. check-bundle.mjs checks the same on the build.
// Paths are relative to the repository root: the widget itself lives in the shared kit.

const APP = 'apps/staff/src/';
const CUSTOMER = 'apps/customer/src/';
const CORE = 'packages/web-core/src/';

const files = listFrontendFiles(
  (name) => /\.(ts|vue)$/.test(name) && !/\.test\.ts$/.test(name),
).map((path) => ({ path: repoRelative(path), text: readFileSync(path, 'utf8') }));
const matching = (pattern: RegExp): string[] =>
  files.filter((file) => pattern.test(file.text)).map((file) => file.path);

describe('the Telegram Login Widget script', () => {
  it('is named in exactly one source file', () => {
    expect(matching(/telegram\.org\/js/)).toEqual([`${CORE}telegram/telegram-widget.ts`]);
  });

  it('is shared by browser sign-in screens and gated by bot configuration', () => {
    expect(matching(/mountTelegramWidget/)).toEqual([
      `${CORE}telegram/components/TelegramLoginWidget.vue`,
      `${CORE}telegram/telegram-widget.ts`,
    ]);
    expect(matching(/TelegramLoginWidget\.vue/)).toEqual([
      `${APP}features/auth/components/LoginPage.vue`,
      `${APP}features/staff-auth/components/TelegramLoginWidget.vue`,
      `${CUSTOMER}features/customer-app/components/CustomerCredentials.vue`,
      `${CUSTOMER}features/customer-app/components/CustomerLogin.vue`,
    ]);
    const page = files.find((file) => file.path === `${APP}features/auth/components/LoginPage.vue`);
    expect(page?.text).toMatch(/TELEGRAM_BOT_USERNAME/);
    expect(page?.text).toMatch(/v-if="widgetBot !== null"/);
  });

  it('keeps staff auth out of customer code and loads the widget only in browser sign-in components', () => {
    const customer = files.filter((file) => file.path.startsWith(CUSTOMER));
    expect(customer.length).toBeGreaterThan(10);
    expect(
      customer.filter((file) => /staff-auth|telegram-widget|LoginPage/.test(file.text)),
    ).toEqual([]);
    for (const name of ['CustomerLogin', 'CustomerCredentials']) {
      const component = files.find((file) => file.path.endsWith(`/components/${name}.vue`));
      expect(component?.text).toMatch(
        /defineAsyncComponent\(\s*\(\) => import\('@core\/telegram\/components\/TelegramLoginWidget.vue'\)/,
      );
      expect(component?.text).toContain('v-if="TELEGRAM_BOT_USERNAME"');
    }
  });
});

describe('the real services are loaded lazily', () => {
  it('is imported only through a dynamic import', () => {
    const importers = files.filter((file) => /create-real-services/.test(file.text));
    expect(importers.map((file) => file.path)).toEqual([`${APP}app/create-services.ts`]);
    expect(importers[0]?.text).toMatch(/await import\('@\/app\/create-real-services'\)/);
    expect(importers[0]?.text).not.toMatch(/^import .*create-real-services/m);
  });

  // The token is kept by ONE module, the shared store (@core/lib/session-token-store); nothing in
  // the staff sign-in code reads or writes browser storage or a cookie itself.
  it('keeps tokens out of storage other than the session store', () => {
    const direct = files.filter(
      (file) =>
        /localStorage[.[]|sessionStorage[.[]|document\.cookie|readStorage|writeStorage/.test(
          file.text,
        ) &&
        file.path.startsWith(`${APP}features/staff-auth/`) &&
        !file.path.endsWith('.test.ts'),
    );
    expect(direct).toEqual([]);
  });
});
