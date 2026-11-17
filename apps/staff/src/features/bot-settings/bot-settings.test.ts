import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { servicesKey, type Services } from '@/app/services';
import { createFakeStaffNotificationsApi } from '@/features/staff-notifications/api/fake-staff-notifications';
import { createAppI18n } from '@/i18n';
import { ensureStaffSystemPagesMessages } from '@/i18n/staff-system-pages-messages';
import { createTestServices } from '@/test-utils/create-test-services';
import { withStaffCostMessages } from '@/test-utils/staff-cost-i18n';
import BotSettingsPage from './components/BotSettingsPage.vue';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
});

async function mountPage(
  identityId: string,
  botUsername: string | null,
  overrides: Partial<Services> = {},
): Promise<{ wrapper: VueWrapper; services: Services }> {
  const { services: base } = createTestServices({ identityId });
  await base.currentUser.ensureLoaded();
  const services: Services = { ...base, ...overrides };
  const i18n = withStaffCostMessages(createAppI18n());
  await ensureStaffSystemPagesMessages(i18n);
  const wrapper = mount(BotSettingsPage, {
    props: { botUsername },
    attachTo: document.body,
    global: { plugins: [i18n], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, services };
}

describe('bot settings page', () => {
  it('shows the configured bot username as a t.me link and never a token', async () => {
    const { wrapper } = await mountPage('manager', 'iOrder_uzbot');
    const link = wrapper.find('a[data-testid="bot-username"]');
    expect(link.attributes('href')).toBe('https://t.me/iOrder_uzbot');
    expect(link.text()).toContain('@iOrder_uzbot');
    expect(wrapper.text()).toContain('Token faqat serverda saqlanadi');
  });

  it('says so when this build has no bot username', async () => {
    const { wrapper } = await mountPage('manager', null);
    expect(wrapper.find('a[data-testid="bot-username"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="bot-username"]').text()).toBe('Bu ilovada sozlanmagan');
  });

  it('has no working-looking switches, inputs or save button: the rules are read-only', async () => {
    const { wrapper } = await mountPage('manager', 'iOrder_uzbot');
    expect(
      wrapper.findAll('input, textarea, select, [aria-pressed], [role="switch"]'),
    ).toHaveLength(0);
    expect(wrapper.findAll('button').map((b) => b.text())).not.toContain("O'zgarishlarni saqlash");
    expect(wrapper.find('[data-testid="bot-rules"]').findAll('li')).toHaveLength(2);
    expect(wrapper.find('[data-testid="bot-check-unavailable"]').exists()).toBe(true);
  });

  it("shows the manager's own bot connection and the connect button when it is off", async () => {
    const { wrapper } = await mountPage('manager', 'iOrder_uzbot', {
      staffNotificationsApi: createFakeStaffNotificationsApi({
        telegramLinked: true,
        botConnected: false,
      }),
    });
    const card = wrapper.find('[data-testid="own-bot-connection"]');
    expect(card.find('[data-testid="bot-state"]').text()).toBe('Ulanmagan');
    expect(card.findAll('button').length).toBeGreaterThan(0);
  });

  it('does not ask the notifications endpoint for an administrator (it refuses ADMIN)', async () => {
    const api = createFakeStaffNotificationsApi();
    const status = vi.spyOn(api, 'status');
    const { wrapper } = await mountPage('admin', 'iOrder_uzbot', { staffNotificationsApi: api });
    expect(status).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="bot-admin-note"]').exists()).toBe(true);
  });
});
