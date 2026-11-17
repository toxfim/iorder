import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { servicesKey, type Services } from '@/app/services';
import { createRealServices } from '@/app/create-real-services';
import { createAppI18n } from '@/i18n';
import { ensureStaffSystemPagesMessages } from '@/i18n/staff-system-pages-messages';
import { createTestServices } from '@/test-utils/create-test-services';
import { withStaffCostMessages } from '@/test-utils/staff-cost-i18n';
import { unavailableActivityHistoryApi } from './api/activity-history-api';
import { createFakeActivityHistoryApi } from './api/fake-activity-history';
import ActivityHistoryPage from './components/ActivityHistoryPage.vue';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
});

async function mountPage(services: Services): Promise<VueWrapper> {
  const i18n = withStaffCostMessages(createAppI18n());
  await ensureStaffSystemPagesMessages(i18n);
  const wrapper = mount(ActivityHistoryPage, {
    attachTo: document.body,
    global: { plugins: [i18n], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

async function servicesFor(identityId: string): Promise<Services> {
  const { services } = createTestServices({ identityId });
  await services.currentUser.ensureLoaded();
  return services;
}

const rowTexts = (wrapper: VueWrapper): string[] =>
  wrapper.findAll('tbody tr').map((row) => row.text().replace(/\s+/g, ' '));

describe('activity history page', () => {
  it('fake API: shows the demo rows newest first, with the details of the first one', async () => {
    const wrapper = await mountPage(await servicesFor('manager'));
    const rows = rowTexts(wrapper);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toContain('20.10.2026');
    expect(rows[0]).toContain('Aziz Karimov');
    expect(rows[0]).toContain("Narxlar e'lon qilindi");
    expect(rows[0]).toContain('v12 → v13');
    // Order statuses use the staff stage names; a customer author is labelled with their group.
    expect(rows.find((r) => r.includes('IO-1048') && r.includes('Madina'))).toContain(
      'Mijoz · Artel Electronics',
    );
    expect(wrapper.find('[data-testid="history-info"]').text()).toContain('8 ta yozuv');
    const detail = wrapper.find('[data-testid="history-detail"]').text();
    expect(detail).toContain("narxlar e'lon qilindi");
    expect(detail).toContain('Yetkazib beruvchi narxi oshdi');
  });

  it('picks a row for the details and filters by search and object type', async () => {
    const wrapper = await mountPage(await servicesFor('admin'));
    const payment = wrapper
      .findAll('tbody tr')
      .find((row) => row.text().includes("To'lov kiritildi"));
    await payment?.find('button.dt__link').trigger('click');
    const detail = wrapper.find('[data-testid="history-detail"]').text();
    expect(detail).toContain('3 240 000');
    expect(detail).toContain('Naqd, kassaga');

    await wrapper.find('input[type="search"]').setValue('Korzinka');
    expect(rowTexts(wrapper)).toHaveLength(1);
    expect(wrapper.find('[data-testid="history-detail"]').text()).toContain('IO-1046');

    await wrapper.find('input[type="search"]').setValue('no such thing');
    expect(rowTexts(wrapper)).toHaveLength(0);
    expect(wrapper.text()).toContain('Qidiruvga mos yozuv topilmadi');
    expect(wrapper.find('[data-testid="history-detail"]').exists()).toBe(false);
  });

  it('offers no export, retention or delete controls (no backend behind them)', async () => {
    const wrapper = await mountPage(await servicesFor('manager'));
    const labels = wrapper.findAll('button').map((b) => b.text());
    expect(labels.some((l) => /eksport|saqlash siyosati|o'chirish/i.test(l))).toBe(false);
  });

  it('real build: the adapter answers "not available" and the page says so, with no rows', async () => {
    expect(await unavailableActivityHistoryApi.list()).toEqual({ available: false });
    const real = createRealServices({
      baseUrl: '/api',
      fetchImpl: () => Promise.reject(new Error('no network in this test')),
      readInitData: () => null,
    });
    expect(await real.activityHistoryApi.list()).toEqual({ available: false });

    const services = {
      ...(await servicesFor('manager')),
      activityHistoryApi: real.activityHistoryApi,
    };
    const wrapper = await mountPage(services);
    const state = wrapper.find('[data-testid="history-unavailable"]');
    expect(state.exists()).toBe(true);
    expect(state.text()).toContain('Faoliyat tarixi hali mavjud emas');
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.find('[data-testid="history-info"]').exists()).toBe(false);
  });

  it('the fake refuses roles other than admin and manager; the page shows the denied state', async () => {
    const api = createFakeActivityHistoryApi({ roles: () => ['ACCOUNTANT'] });
    await expect(api.list()).rejects.toThrow();
    const services = { ...(await servicesFor('accountant')), activityHistoryApi: api };
    const wrapper = await mountPage(services);
    expect(wrapper.find('[data-state="denied"]').exists()).toBe(true);
  });

  it('an empty history is an empty state, not the "not available" one', async () => {
    const api = createFakeActivityHistoryApi({ roles: () => ['MANAGER'], entries: [] });
    const services = { ...(await servicesFor('manager')), activityHistoryApi: api };
    const wrapper = await mountPage(services);
    expect(wrapper.find('[data-state="empty"]').text()).toContain("Hali yozuv yo'q");
    expect(wrapper.find('[data-testid="history-unavailable"]').exists()).toBe(false);
  });
});
