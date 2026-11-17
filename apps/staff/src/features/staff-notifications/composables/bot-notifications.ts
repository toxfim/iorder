import type { StaffRole } from '@iorder/shared';
import type { StaffNotificationStatusResponse } from '@iorder/shared/staff-auth';
import { ref, type Ref } from 'vue';
import { openTelegramLink } from '@core/telegram/open-telegram-link';
import type { StaffNotificationsApi } from '../api/staff-notifications-api';

/**
 * [C] 2026-10-25: everybody on the staff but an administrator gets bot messages. A person who
 * also holds another role gets that role's messages. UI only; the server checks the same.
 */
export function receivesBotNotifications(staffRoles: readonly StaffRole[]): boolean {
  return staffRoles.some((role) => role !== 'ADMIN');
}

export interface BotNotificationsReminder {
  /** Null until the first answer (and after a failed read: no reminder is better than a wrong one). */
  readonly status: Readonly<Ref<StaffNotificationStatusResponse | null>>;
  /** A connect link is being asked for. */
  readonly connecting: Readonly<Ref<boolean>>;
  /** The link was opened; the person still has to press Start in Telegram. */
  readonly linkOpened: Readonly<Ref<boolean>>;
  /** The last connect attempt failed: the error, for the message. */
  readonly connectError: Readonly<Ref<unknown>>;
  refresh: () => Promise<void>;
  connect: () => Promise<void>;
}

export function createBotNotificationsReminder(
  api: StaffNotificationsApi,
  open: (url: string) => void = (url) => void openTelegramLink(url),
): BotNotificationsReminder {
  const status = ref<StaffNotificationStatusResponse | null>(null);
  const connecting = ref(false);
  const linkOpened = ref(false);
  const connectError = ref<unknown>(null);

  async function refresh(): Promise<void> {
    try {
      status.value = await api.status();
      if (status.value.botConnected) linkOpened.value = false;
    } catch {
      // Not shown: the reminder is a convenience and the next focus tries again.
    }
  }

  async function connect(): Promise<void> {
    if (connecting.value) return;
    connecting.value = true;
    connectError.value = null;
    try {
      const link = await api.createLink();
      open(link.url);
      linkOpened.value = true;
    } catch (error) {
      connectError.value = error;
    } finally {
      connecting.value = false;
    }
  }

  return { status, connecting, linkOpened, connectError, refresh, connect };
}
