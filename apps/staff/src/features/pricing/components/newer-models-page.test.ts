import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { servicesKey, type Services } from '@/app/services';
import NewerModelsPage from '@/features/pricing/components/NewerModelsPage.vue';
import { uz } from '@/i18n/messages/uz';
import { createTestServices } from '@/test-utils/create-test-services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { coreUz } from '@core/i18n/messages/uz';
import type { FakeScenario } from '@core/lib/fake-scenario';

// "Yangi modellar" (owner 2026-11-09): the manager confirms or rejects the pairs the system
// proposed; the purchasing manager reads; a decided pair leaves the "awaiting" tab.

const wrappers: VueWrapper[] = [];
const T = uz.newerModels;

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  dismissToast();
});

async function mountPage(
  identity: string,
  options: { scenario?: FakeScenario; prepare?: (services: Services) => void } = {},
) {
  const test = createTestServices({ scenario: options.scenario ?? 'ready', identityId: identity });
  await test.services.currentUser.ensureLoaded();
  options.prepare?.(test.services);
  const wrapper = mount(NewerModelsPage, {
    attachTo: document.body,
    global: { provide: { [servicesKey as symbol]: test.services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return test;
}

const text = (el: Element | null | undefined): string =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const body = (): string => text(document.body);
const toastText = (): string => useToast().toast.value?.message ?? '';
const rows = (): HTMLElement[] => Array.from(document.body.querySelectorAll('tbody tr'));
const byTestId = (id: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const tab = (label: string): HTMLElement => {
  const found = Array.from(document.body.querySelectorAll<HTMLElement>('[role="tab"]')).find((el) =>
    text(el).includes(label),
  );
  if (!found) throw new Error(`No tab ${label}`);
  return found;
};
async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('Nothing to click');
  (el as HTMLElement).click();
  await flushPromises();
}

describe('the newer models page', () => {
  it('lists the proposals awaiting a decision with both products and the counts', async () => {
    await mountPage('manager');
    expect(body()).toContain(T.title);
    expect(body()).toContain(T.subtitle.replace('{count}', '1'));
    expect(rows()).toHaveLength(1);
    expect(text(rows()[0])).toContain('Apple iPhone 14 128GB');
    expect(text(rows()[0])).toContain('Apple iPhone 15 128GB');
    // The older model has no price any more: said on its side, never a reason to hide the pair.
    expect(text(rows()[0])).toContain(T.notPriced);
    expect(text(tab(T.tabs.PROPOSED))).toContain('1');
    expect(text(tab(T.tabs.REJECTED))).toContain('1');
    expect(text(tab(T.tabs.CONFIRMED))).toContain('0');
    expect(byTestId('find-proposals')).not.toBeNull();
  });

  it('confirming moves the pair to the confirmed tab, with who decided and when', async () => {
    const { services } = await mountPage('manager');
    await click(byTestId('confirm-pair'));
    expect(toastText()).toBe(
      T.confirmed
        .replace('{older}', 'Apple iPhone 14 128GB')
        .replace('{newer}', 'Apple iPhone 15 128GB'),
    );
    expect(body()).toContain(T.empty.PROPOSED.title);
    await click(tab(T.tabs.CONFIRMED));
    expect(rows()).toHaveLength(1);
    expect(text(byTestId('decided-line'))).toContain(
      services.currentUser.user.value?.displayName ?? '',
    );
    // A confirmed pair can still be rejected (a wrong click is corrected), not confirmed again.
    expect(byTestId('confirm-pair')).toBeNull();
    expect(byTestId('reject-pair')).not.toBeNull();
    const confirmed = await services.successionsApi.list('CONFIRMED');
    expect(confirmed.items.map((p) => p.status)).toEqual(['CONFIRMED']);
  });

  it('rejecting moves the pair to the rejected tab', async () => {
    const { services } = await mountPage('admin');
    await click(byTestId('reject-pair'));
    expect(body()).toContain(T.empty.PROPOSED.title);
    const rejected = await services.successionsApi.list('REJECTED');
    expect(rejected.items).toHaveLength(2);
  });

  it('"find proposals" reports when nothing new was found', async () => {
    await mountPage('manager');
    await click(byTestId('find-proposals'));
    expect(toastText()).toBe(T.foundNone);
  });

  it('the purchasing manager reads without the decision controls', async () => {
    await mountPage('purchasing');
    expect(rows()).toHaveLength(1);
    expect(byTestId('confirm-pair')).toBeNull();
    expect(byTestId('reject-pair')).toBeNull();
    expect(byTestId('find-proposals')).toBeNull();
    expect(body()).toContain(T.readOnly);
  });

  it('shows the error and the denied states', async () => {
    await mountPage('manager', { scenario: 'error' });
    expect(body()).toContain(coreUz.state.error.title);
    document.body.innerHTML = '';
    await mountPage('accountant');
    expect(body()).toContain(coreUz.state.denied.title);
  });
});
