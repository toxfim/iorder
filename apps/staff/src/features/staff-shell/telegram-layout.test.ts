import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncTelegramChrome } from '@/features/preferences/telegram-chrome';
import { startMiniApp } from '@core/telegram/mini-app-bridge';
import { listFrontendFiles, REPO_ROOT, repoRelative } from '@core/test-utils/frontend-sources';

// The staff app inside Telegram on a phone. jsdom has no layout and evaluates neither env() nor
// media queries, so the rules that keep the bars clear of Telegram's controls are checked in the
// source, and what is sent to Telegram is checked through the bridge.

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');
/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!found) throw new Error(`No rule "${selector}"`);
  return found[1] ?? '';
}

describe('safe areas (Telegram controls, notch, home indicator)', () => {
  const base = read('packages/web-core/src/styles/base.css');

  it('are one pair of variables fed by the browser AND by Telegram', () => {
    const root = rule(base, ':root');
    for (const side of ['top', 'bottom']) {
      const value = new RegExp(`--safe-${side}:\\s*max\\(([^;]*)\\);`).exec(root)?.[1] ?? '';
      expect(value).toContain(`env(safe-area-inset-${side}, 0px)`);
      // Telegram's webview reports its insets only through events (mini-app-bridge).
      expect(value).toContain(`var(--tg-safe-${side}, 0px)`);
      expect(value).toContain(`var(--tg-content-safe-${side}, 0px)`);
    }
  });

  it('the top bar grows by the top inset and keeps its tools below it, on desktop and phone', () => {
    const shell = read('apps/staff/src/features/staff-shell/components/StaffShell.vue');
    const desktop = rule(shell, '.topbar');
    expect(desktop).toContain('position: sticky');
    expect(desktop).toContain('min-height: calc(var(--topbar-h) + var(--safe-top, 0px))');
    expect(desktop).toContain('padding: var(--safe-top, 0px) 32px 0');
    const phone = shell.slice(shell.indexOf('@media (max-width: 880px)'));
    const bar = rule(phone, '.topbar');
    expect(bar).toContain('min-height: calc(56px + var(--safe-top, 0px))');
    expect(bar).toContain('padding: calc(8px + var(--safe-top, 0px)) 16px 8px');
  });

  it('the work area ends above the bottom inset', () => {
    const shell = read('apps/staff/src/features/staff-shell/components/StaffShell.vue');
    expect(rule(shell, '.shell__main')).toContain(
      'calc(var(--page-pad-bottom) + var(--safe-bottom, 0px))',
    );
  });

  it('full-height layers keep their first and last row clear: drawer, menu, dialog, search, toast', () => {
    const drawer = read('apps/staff/src/components/ui/AppDrawer.vue');
    expect(rule(drawer, '.drawer__header')).toContain('calc(18px + var(--safe-top, 0px))');
    expect(rule(drawer, '.drawer__footer')).toContain('calc(16px + var(--safe-bottom, 0px))');
    expect(rule(drawer, '.drawer__body:last-child')).toContain(
      'calc(20px + var(--safe-bottom, 0px))',
    );
    const menu = read('apps/staff/src/features/staff-shell/components/SidebarContent.vue');
    expect(rule(menu, '.sidebar__user')).toContain('calc(20px + var(--safe-bottom, 0px))');
    const modal = read('packages/web-core/src/components/ui/AppModal.vue');
    expect(rule(modal, ':root[data-staff-app] .modal')).toContain(
      'padding: calc(16px + var(--safe-top, 0px)) 16px calc(16px + var(--safe-bottom, 0px))',
    );
    const palette = read('apps/staff/src/features/search/components/CommandPalette.vue');
    expect(rule(palette, '.cmd')).toContain('var(--safe-top, 0px)');
    expect(rule(palette, '.cmd')).toContain('var(--safe-bottom, 0px)');
    const toast = read('packages/web-core/src/components/ui/ToastHost.vue');
    expect(rule(toast, '.toast-region')).toContain('var(--safe-bottom, 0px)');
  });

  it('no staff screen reads env(safe-area-inset-*) itself (Telegram would be left out)', () => {
    const direct = listFrontendFiles(
      (name) => /\.(vue|css|ts)$/.test(name) && !/\.test\./.test(name),
    )
      .map(repoRelative)
      .filter((file) => file.startsWith('apps/staff/src/'))
      .filter((file) => read(file).includes('env(safe-area-inset'));
    expect(direct).toEqual([]);
  });
});

describe('Telegram header colours follow the app theme', () => {
  type ProxyWindow = { TelegramWebviewProxy?: { postEvent: (a: string, b: string) => void } };

  afterEach(() => {
    delete (window as unknown as ProxyWindow).TelegramWebviewProxy;
    document.documentElement.style.removeProperty('--w');
    document.documentElement.style.removeProperty('--page');
    startMiniApp(null);
  });

  it('sends the top bar colour as the header and the page colour as the background', () => {
    const postEvent = vi.fn<(eventType: string, eventData: string) => void>();
    (window as unknown as ProxyWindow).TelegramWebviewProxy = { postEvent };
    startMiniApp('8.0');
    postEvent.mockClear();
    document.documentElement.style.setProperty('--w', '#171a1f');
    document.documentElement.style.setProperty('--page', '#0f1115');

    syncTelegramChrome();

    expect(postEvent.mock.calls).toEqual([
      ['web_app_set_header_color', '{"color":"#171a1f"}'],
      ['web_app_set_background_color', '{"color":"#0f1115"}'],
      ['web_app_set_bottom_bar_color', '{"color":"#0f1115"}'],
    ]);
  });

  it('sends nothing outside Telegram', () => {
    const postEvent = vi.fn<(eventType: string, eventData: string) => void>();
    (window as unknown as ProxyWindow).TelegramWebviewProxy = { postEvent };
    document.documentElement.style.setProperty('--w', '#ffffff');
    document.documentElement.style.setProperty('--page', '#f6f7f9');
    // No launch happened: the bridge knows no client version.
    syncTelegramChrome();
    expect(postEvent).not.toHaveBeenCalled();
  });
});

describe('touch targets on the pages staff use on phones', () => {
  // The block every phone screen uses: a coarse pointer, or a webview that cannot hover (Telegram
  // on some phones reports no coarse pointer).
  const TOUCH = '@media (pointer: coarse), (hover: none)';
  const touchBlocks = (css: string): string =>
    css
      .split(TOUCH)
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf('\n}\n') + 1))
      .join('\n');

  const ORDERS = 'apps/staff/src/features/staff-orders/components';
  it.each([
    // Orders list.
    `${ORDERS}/OrdersPage.vue`,
    `${ORDERS}/OrdersStatusTabs.vue`,
    `${ORDERS}/QueueOrderCard.vue`,
    // Order page.
    `${ORDERS}/OrderDetailPage.vue`,
    `${ORDERS}/OrderActionsPanel.vue`,
    `${ORDERS}/OrderItems.vue`,
    `${ORDERS}/PaymentMethodChoice.vue`,
    // Warehouse and deliveries (their pages are lists of queue cards plus these panels).
    `${ORDERS}/PickingPanel.vue`,
    `${ORDERS}/DeliveryContactCard.vue`,
    // The shell around every page.
    'apps/staff/src/features/staff-shell/components/StaffShell.vue',
    'apps/staff/src/features/staff-shell/components/NotificationsBell.vue',
    'apps/staff/src/components/ui/AppDrawer.vue',
    'packages/web-core/src/components/ui/AppButton.vue',
    'packages/web-core/src/components/ui/AppDropdown.vue',
  ])('%s gives its own controls a 44px target on touch', (file) => {
    expect(touchBlocks(read(file))).toMatch(/(min-)?(height|width): (44|48)px/);
  });

  it('the top bar language and theme buttons are 44px wide, not the 34px desktop square', () => {
    const blocks = touchBlocks(read('packages/web-core/src/components/ui/AppDropdown.vue'));
    expect(rule(blocks, ':root[data-staff-app] .dd--compact .dd__trigger')).toContain(
      'min-width: 44px',
    );
  });

  it('the inline retry link of a queue card is a full target', () => {
    const blocks = touchBlocks(read(`${ORDERS}/QueueOrderCard.vue`));
    expect(blocks).toMatch(/\.btn,\s*\.link\s*\{\s*min-height: 44px/);
  });

  it('a scan slot is as tall as its input, so the 44px slot buttons stay inside the row', () => {
    const blocks = touchBlocks(read(`${ORDERS}/PickingPanel.vue`));
    expect(blocks).toMatch(/\.slot__value,\s*\.slot__missing\s*\{\s*height: 48px/);
    expect(rule(blocks, '.slot__input')).toContain('height: 48px');
  });
});
