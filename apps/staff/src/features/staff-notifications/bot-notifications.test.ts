import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { servicesKey } from '@/app/services';
import { createTestServices } from '@/test-utils/create-test-services';
import { ApiConflictError } from '@core/lib/api-errors';
import { coreUz } from '@core/i18n/messages/uz';
import { uz } from '@/i18n/messages/uz';
import { createFakeStaffNotificationsApi } from './api/fake-staff-notifications';
import type { StaffNotificationsApi } from './api/staff-notifications-api';
import BotNotificationsReminder from './components/BotNotificationsReminder.vue';
import reminderSource from './components/BotNotificationsReminder.vue?raw';
import {
  createBotNotificationsReminder,
  receivesBotNotifications,
} from './composables/bot-notifications';

const openTelegramLink = vi.hoisted(() => vi.fn());
vi.mock('@core/telegram/open-telegram-link', () => ({ openTelegramLink }));

afterEach(() => {
  openTelegramLink.mockReset();
});

describe('who gets bot messages ([C] 2026-10-25)', () => {
  it('everybody on the staff but a pure administrator', () => {
    expect(receivesBotNotifications(['ADMIN'])).toBe(false);
    expect(receivesBotNotifications(['ADMIN', 'MANAGER'])).toBe(true);
    for (const role of ['MANAGER', 'ACCOUNTANT', 'WAREHOUSE_MANAGER', 'DRIVER'] as const) {
      expect(receivesBotNotifications([role])).toBe(true);
    }
    expect(receivesBotNotifications([])).toBe(false);
  });
});

describe('the reminder store', () => {
  it('opens a fresh link and remembers that the person still has to press Start', async () => {
    const opened: string[] = [];
    const reminder = createBotNotificationsReminder(createFakeStaffNotificationsApi(), (url) =>
      opened.push(url),
    );
    await reminder.refresh();
    expect(reminder.status.value).toEqual({ telegramLinked: false, botConnected: false });
    await reminder.connect();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^https:\/\/t\.me\/.+\?start=staff_/);
    expect(reminder.linkOpened.value).toBe(true);
    await reminder.refresh();
    expect(reminder.status.value?.botConnected).toBe(true);
    expect(reminder.linkOpened.value).toBe(false);
  });

  it('keeps the error of a failed link and opens nothing', async () => {
    const failing: StaffNotificationsApi = {
      markedOrders: () => Promise.resolve({ items: [] }),
      status: () => Promise.resolve({ telegramLinked: false, botConnected: false }),
      createLink: () =>
        Promise.reject(new ApiConflictError('x', 'CONFLICT', undefined, 'BOT_NOT_CONFIGURED')),
    };
    const opened: string[] = [];
    const reminder = createBotNotificationsReminder(failing, (url) => opened.push(url));
    await reminder.connect();
    expect(opened).toEqual([]);
    expect(reminder.connectError.value).toBeInstanceOf(ApiConflictError);
    expect(reminder.connecting.value).toBe(false);
  });
});

async function mountFor(identityId: string, api: StaffNotificationsApi) {
  const { services } = createTestServices({ identityId });
  await services.currentUser.ensureLoaded();
  const wrapper = mount(BotNotificationsReminder, {
    global: { provide: { [servicesKey as symbol]: { ...services, staffNotificationsApi: api } } },
  });
  await flushPromises();
  return wrapper;
}

describe('the reminder in the staff shell', () => {
  it('asks a warehouse manager without Telegram to connect, then hides after Start', async () => {
    const api = createFakeStaffNotificationsApi();
    const wrapper = await mountFor('warehouse', api);
    const reminder = wrapper.get('[data-testid="bot-reminder"]');
    expect(reminder.text()).toContain(uz.botNotifications.title);
    expect(reminder.text()).toContain(uz.botNotifications.notLinked);

    await reminder.get('button').trigger('click');
    await flushPromises();
    expect(openTelegramLink).toHaveBeenCalledWith(api.links[0]);
    expect(wrapper.text()).toContain(uz.botNotifications.pressStart);

    // Back from Telegram: the window gets the focus and the status is read again.
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(wrapper.find('[data-testid="bot-reminder"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('says the bot is not connected when the Telegram id is already linked', async () => {
    const api = createFakeStaffNotificationsApi({ telegramLinked: true, botConnected: false });
    const wrapper = await mountFor('driver', api);
    expect(wrapper.text()).toContain(uz.botNotifications.notConnected);
    wrapper.unmount();
  });

  it('renders its instruction as the body text, which wraps on narrow screens', async () => {
    const api = createFakeStaffNotificationsApi({ telegramLinked: true, botConnected: false });
    const wrapper = await mountFor('driver', api);
    expect(wrapper.get('.reminder__body').text()).toBe(uz.botNotifications.notConnected);
    // The bar stays one line on wide screens; on phones the text takes a second line, never hidden.
    expect(reminderSource).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.reminder__body \{[^}]*white-space: normal/,
    );
    expect(reminderSource).not.toMatch(/clip-path/);
    wrapper.unmount();
  });

  it('shows the api error when no bot is configured', async () => {
    const api: StaffNotificationsApi = {
      markedOrders: () => Promise.resolve({ items: [] }),
      status: () => Promise.resolve({ telegramLinked: false, botConnected: false }),
      createLink: () =>
        Promise.reject(new ApiConflictError('x', 'CONFLICT', undefined, 'BOT_NOT_CONFIGURED')),
    };
    const wrapper = await mountFor('manager', api);
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe(coreUz.apiErrors.botNotConfigured);
    wrapper.unmount();
  });

  it('shows nothing to a connected person or to an administrator, who is not even asked', async () => {
    const connected = await mountFor(
      'accountant',
      createFakeStaffNotificationsApi({ telegramLinked: true, botConnected: true }),
    );
    expect(connected.find('[data-testid="bot-reminder"]').exists()).toBe(false);
    connected.unmount();

    const status = vi.fn(() => Promise.resolve({ telegramLinked: false, botConnected: false }));
    const admin = await mountFor('admin', {
      status,
      createLink: vi.fn(),
      markedOrders: vi.fn(),
    });
    expect(admin.find('[data-testid="bot-reminder"]').exists()).toBe(false);
    expect(status).not.toHaveBeenCalled();
    admin.unmount();
  });
});
