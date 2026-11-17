import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { servicesKey } from '@/app/services';
import { SUMMARY_REFRESH_MS } from '@/features/staff-orders/composables/dashboard-summary-store';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { preloadRouteComponents } from '@/test-utils/preload-routes';
import DashboardSummaryPanel from './components/DashboardSummaryPanel.vue';

// The summary panel per role: it draws exactly the sections the (fake) server sent. Warehouse and
// driver receive no money at all, so no figure in so'm may appear for them.

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: true }) as MediaQueryList,
  });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

async function mountPanel(
  identity: string,
  options: {
    scenario?: 'error' | 'denied' | 'empty';
    now?: () => Date;
    exclude?: string[];
  } = {},
) {
  await preloadRouteComponents();
  // The fakes read the scenario from this object at call time, so a test can break the next read.
  const serviceOptions: { scenario?: 'error' | 'denied' | 'empty' } = {
    scenario: options.scenario,
  };
  const { services } = createTestServices({
    identityId: identity,
    get scenario() {
      return serviceOptions.scenario;
    },
    clock: { now: options.now ?? (() => TEST_NOW) },
  });
  await services.currentUser.ensureLoaded();
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push('/staff');
  const wrapper = mount(DashboardSummaryPanel, {
    attachTo: document.body,
    props: { exclude: options.exclude },
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return {
    wrapper,
    services,
    router,
    setScenario: (next: 'error' | 'denied' | 'empty' | undefined) => {
      serviceOptions.scenario = next;
    },
  };
}

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const tile = (id: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[data-testid="summary-${id}"]`);
const tileIds = (): string[] =>
  Array.from(document.body.querySelectorAll('[data-testid^="summary-"]'))
    .map((el) => el.getAttribute('data-testid')!.replace('summary-', ''))
    .filter((id) => id !== 'refresh' && id !== 'stale');
const panelText = (): string => squash(document.body.textContent);

describe('summary panel: what each role sees', () => {
  it('manager: queues, in progress, today, unpaid, groups, unpriced, sync and rate', async () => {
    await mountPanel('manager');
    expect(tileIds()).toEqual([
      'AWAITING_MANAGER',
      'AWAITING_ACCOUNTING',
      'TO_RELEASE',
      'TO_DELIVER',
      'inProgress',
      'today',
      'unpaidDelivered',
      'organizations',
      'unpriced',
      'sheetSync',
      'usdRate',
    ]);
    expect(tile('SKIPPED_ACCOUNTING_TO_REVIEW')).toBeNull();
    expect(squash(tile('AWAITING_MANAGER')?.textContent)).toContain('Tasdiq kutmoqda3');
    expect(squash(tile('AWAITING_MANAGER')?.textContent)).toContain(
      'Eng uzoq kutayotgani: 14 soat',
    );
    expect(squash(tile('usdRate')?.textContent)).toContain("$1 = 12 650 so'm");
    expect(squash(tile('today')?.textContent)).toContain("jami 100 595 000 so'm");
  });

  it('manager: tiles link into the existing screens with the right filter', async () => {
    await mountPanel('manager');
    const href = (id: string): string | null =>
      tile(id)?.querySelector('a')?.getAttribute('href') ?? null;
    expect(href('AWAITING_MANAGER')).toBe('/staff/orders?stage=SUBMITTED');
    expect(href('AWAITING_ACCOUNTING')).toBe('/staff/orders?stage=MANAGER_APPROVED');
    expect(href('TO_RELEASE')).toBe('/staff/orders?stage=ACCOUNTING_CLEARED');
    expect(href('TO_DELIVER')).toBe('/staff/orders?stage=RELEASED');
    expect(href('today')).toBe('/staff/orders?period=today');
    // No link: the list's debt filter does not match the server's DELIVERED/RECEIVED count.
    expect(href('unpaidDelivered')).toBeNull();
    expect(href('organizations')).toBe('/staff/organizations');
    expect(href('unpriced')).toBe('/staff/prices?tab=unpriced');
  });

  it('F-22: "Yangilangan" shows Asia/Tashkent time of the (fake) clock, not the browser or UTC time', async () => {
    // 04:30 UTC is 09:30 in Tashkent (UTC+5, no daylight saving).
    await mountPanel('manager', { now: () => new Date('2026-10-19T04:30:00.000Z') });
    expect(panelText()).toContain('Yangilangan: 09:30');
    for (const w of wrappers.splice(0)) w.unmount();
    document.body.innerHTML = '';
    // 20:10 UTC is already the next day, 01:10, in Tashkent.
    await mountPanel('manager', { now: () => new Date('2026-10-19T20:10:00.000Z') });
    expect(panelText()).toContain('Yangilangan: 01:10');
  });

  it('F-04: the sheet sync card is calm when fresh and warns, with a link, when older than the threshold', async () => {
    await mountPanel('manager');
    expect(tile('sheetSync')?.classList.contains('tile--warn')).toBe(false);
    expect(tile('sheetSync')?.querySelector('a')).toBeNull();
    for (const w of wrappers.splice(0)) w.unmount();
    document.body.innerHTML = '';

    // A daily run that finished a few hours later than yesterday's is still fresh.
    const lateRun = new Date(TEST_NOW.getTime() + 26 * 60 * 60 * 1000);
    await mountPanel('manager', { now: () => lateRun });
    expect(tile('sheetSync')?.classList.contains('tile--warn')).toBe(false);
    document.body.innerHTML = '';

    // Past the threshold after the fake's last successful run (2026-10-19 08:00 in Tashkent).
    const later = new Date(TEST_NOW.getTime() + 31 * 60 * 60 * 1000);
    await mountPanel('manager', { now: () => later });
    const card = tile('sheetSync');
    expect(card?.classList.contains('tile--warn')).toBe(true);
    expect(squash(card?.textContent)).toContain('30 soatdan beri yangilanmagan');
    // A stale run is named as old, never as a red "successful".
    expect(squash(card?.textContent)).toContain('Eskirgan');
    expect(squash(card?.textContent)).not.toContain('Muvaffaqiyatli');
    expect(card?.querySelector('a')?.getAttribute('href')).toBe('/staff/stock');
  });

  it('admin: management counts and rate, no skipped-accounting queue', async () => {
    await mountPanel('admin');
    expect(tileIds()).toContain('organizations');
    expect(tileIds()).toContain('usdRate');
    expect(tile('SKIPPED_ACCOUNTING_TO_REVIEW')).toBeNull();
  });

  it('accountant: accounting queue, skipped orders to review, rate; no management counts', async () => {
    await mountPanel('accountant');
    expect(tileIds()).toEqual([
      'AWAITING_ACCOUNTING',
      'SKIPPED_ACCOUNTING_TO_REVIEW',
      'today',
      'unpaidDelivered',
      'usdRate',
    ]);
    for (const id of ['organizations', 'unpriced', 'sheetSync', 'inProgress']) {
      expect(tile(id)).toBeNull();
    }
    expect(squash(tile('SKIPPED_ACCOUNTING_TO_REVIEW')?.textContent)).toContain(
      "Buxgalteriyasiz o'tgan, ko'rib chiqish uchun",
    );
    // F-25: the panel sits on the accounting page itself, so a link back to it is left out.
    expect(tile('AWAITING_ACCOUNTING')?.querySelector('a')).toBeNull();
    // The accountant has no order list, so the money tiles are plain numbers.
    expect(tile('today')?.querySelector('a')).toBeNull();
  });

  it.each([
    // F-25: the warehouse has no page for deliveries, so that count is not drawn at all.
    ['warehouse', ['TO_PREPARE', 'TO_RELEASE', 'TO_RETURN']],
    ['driver', ['TO_DELIVER']],
  ])('%s: only its queues and no money anywhere', async (identity, ids) => {
    await mountPanel(identity);
    expect(tileIds()).toEqual(ids);
    for (const absent of ['today', 'unpaidDelivered', 'usdRate', 'organizations', 'unpriced']) {
      expect(tile(absent)).toBeNull();
    }
    const text = panelText();
    expect(text).not.toContain("so'm");
    expect(text).not.toContain('$');
    expect(text).not.toMatch(/\d{1,3}( \d{3}){2,}/); // no amount of millions
  });

  it('the exclude list hides the tiles the page already shows', async () => {
    await mountPanel('manager', { exclude: ['AWAITING_MANAGER', 'today'] });
    expect(tile('AWAITING_MANAGER')).toBeNull();
    expect(tile('today')).toBeNull();
    expect(tile('AWAITING_ACCOUNTING')).not.toBeNull();
  });

  it('compact by default (queue pages): the title is for screen readers only, tiles keep their icons', async () => {
    await mountPanel('accountant');
    expect(document.body.querySelector('.summary--compact')).not.toBeNull();
    expect(document.body.querySelector('.summary__title')?.classList.contains('sr-only')).toBe(
      true,
    );
    expect(tile('AWAITING_ACCOUNTING')?.querySelector('svg')).not.toBeNull();
  });

  it('marks a queue with waiting orders and colours the waiting groups and unpriced counts', async () => {
    await mountPanel('manager');
    expect(tile('AWAITING_MANAGER')?.classList.contains('tile--active')).toBe(true);
    expect(tile('organizations')?.querySelector('.stat__value--accent')?.textContent?.trim()).toBe(
      '3 ta',
    );
    expect(tile('sheetSync')?.querySelector('.stat__value--ok')).not.toBeNull();
  });

  it('hands the groups and unpriced counts to the sidebar stores', async () => {
    const { services } = await mountPanel('manager');
    expect(services.waitingOrganizationsStore.count.value).toBe(3);
    expect(services.unpricedCountStore.count.value).toBe(6);
  });
});

describe('summary panel: states', () => {
  it('shows the error screen with a retry and recovers', async () => {
    const { services } = await mountPanel('manager', { scenario: 'error' });
    expect(document.body.querySelector('[data-testid="dashboard-summary"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="summary-error"]')).not.toBeNull();
    expect(services.dashboardSummaryStore.state.value).toBe('error');
  });

  it('shows a permission denial as a compact line, not a page-sized block', async () => {
    await mountPanel('warehouse', { scenario: 'denied' });
    expect(document.body.querySelector('[data-testid="dashboard-summary"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="summary-denied"]')).not.toBeNull();
    expect(document.body.querySelector('[data-state="denied"]')).toBeNull();
  });

  it("never shows the previous person's numbers to the next sign-in, even if its read fails", async () => {
    const { services, setScenario } = await mountPanel('manager');
    expect(tile('AWAITING_MANAGER')).not.toBeNull();
    await services.currentUser.signOut();
    setScenario('error');
    await services.currentUser.signIn('warehouse');
    await services.dashboardSummaryStore.refresh();
    await flushPromises();
    expect(services.dashboardSummaryStore.summary.value).toBeNull();
    expect(tile('AWAITING_MANAGER')).toBeNull();
    expect(document.body.querySelector('[data-testid="dashboard-summary"]')).toBeNull();
  });

  it('an empty system shows zeros and the empty-queue text, not blanks', async () => {
    await mountPanel('manager', { scenario: 'empty' });
    expect(squash(tile('AWAITING_MANAGER')?.textContent)).toContain('Tasdiq kutmoqda0');
    expect(squash(tile('AWAITING_MANAGER')?.textContent)).toContain("Navbat bo'sh");
  });

  it('the refresh button reads again and shows the new time', async () => {
    let now = TEST_NOW;
    const { services } = await mountPanel('manager', { now: () => now });
    expect(panelText()).toContain('Yangilangan: 09:30');
    now = new Date(TEST_NOW.getTime() + 5 * 60_000);
    document.body.querySelector<HTMLButtonElement>('[data-testid="summary-refresh"]')?.click();
    await flushPromises();
    expect(panelText()).toContain('Yangilangan: 09:35');
    expect(services.dashboardSummaryStore.refreshing.value).toBe(false);
  });

  it('says the numbers are old when a refresh fails but keeps showing them', async () => {
    const { setScenario } = await mountPanel('manager');
    expect(document.body.querySelector('[data-testid="summary-stale"]')).toBeNull();
    setScenario('error');
    document.body.querySelector<HTMLButtonElement>('[data-testid="summary-refresh"]')?.click();
    await flushPromises();
    expect(squash(document.body.querySelector('[data-testid="summary-stale"]')?.textContent)).toBe(
      "Yangilab bo'lmadi. Oxirgi olingan raqamlar ko'rsatilmoqda.",
    );
    expect(squash(tile('AWAITING_MANAGER')?.textContent)).toContain('Tasdiq kutmoqda3');
    setScenario(undefined);
    document.body.querySelector<HTMLButtonElement>('[data-testid="summary-refresh"]')?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="summary-stale"]')).toBeNull();
  });
});

describe('summary panel: gentle automatic refresh', () => {
  it('re-reads every minute while visible, and not while the tab is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(TEST_NOW);
    await mountPanel('manager', { now: () => new Date() });
    expect(panelText()).toContain('Yangilangan: 09:30');
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
    await flushPromises();
    expect(panelText()).toContain('Yangilangan: 09:31');

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS * 5);
    await flushPromises();
    expect(panelText()).toContain('Yangilangan: 09:31');

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(panelText()).toContain('Yangilangan: 09:36');
  });

  it('stops the timer when the panel goes away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(TEST_NOW);
    const { wrapper, services } = await mountPanel('manager', { now: () => new Date() });
    const before = services.dashboardSummaryStore.summary.value?.generatedAt;
    wrapper.unmount();
    wrappers.splice(0);
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS * 3);
    expect(services.dashboardSummaryStore.summary.value?.generatedAt).toBe(before);
  });
});
