import { z } from 'zod';
import { isoInstantSchema } from './common.js';
import { route } from './routes.js';

// STAFF bot notifications (owner decision [C, 2026-10-25]): every staff member except an
// administrator gets a private bot message for the order updates that concern their role. The bot
// can only write to someone who started it, so a staff member connects the bot once from the
// staff app: a one-time `https://t.me/<bot>?start=<token>` link links their Telegram id too.

// Both routes: any staff role except ADMIN (a person who also holds another role may use them).
export const STAFF_NOTIFICATION_ROUTES = Object.freeze({
  /** Whether the bot reaches the signed-in staff member. */
  status: route('GET', '/staff/me/notifications'),
  /** A fresh one-time link that connects the bot. */
  createLink: route('POST', '/staff/me/notifications/link'),
});

/** How long a connect link works [P]. */
export const STAFF_NOTIFICATION_LINK_TTL_SECONDS = 600;

export const staffNotificationStatusResponseSchema = z.strictObject({
  /** A Telegram id is on the account. */
  telegramLinked: z.boolean(),
  /** The person started the bot and Telegram has not reported it blocked since. */
  botConnected: z.boolean(),
});
export type StaffNotificationStatusResponse = z.infer<typeof staffNotificationStatusResponseSchema>;

export const staffNotificationLinkResponseSchema = z.strictObject({
  /** `https://t.me/<bot>?start=<token>`; opening it and pressing Start connects the bot. */
  url: z.url().startsWith('https://t.me/'),
  expiresAt: isoInstantSchema,
});
export type StaffNotificationLinkResponse = z.infer<typeof staffNotificationLinkResponseSchema>;

/**
 * The `start` payload of a connect link: Telegram allows 1-64 characters of A-Z a-z 0-9 _ -.
 * The prefix keeps it apart from any other start payload the bot may get later.
 */
export const STAFF_LINK_START_PREFIX = 'staff_';
export const staffLinkStartPayloadSchema = z
  .string()
  .regex(/^staff_[A-Za-z0-9_-]{43}$/, 'not a staff connect payload');

/** The purchasing manager's in-app list ([C] 2026-10-31): the same news as their bot messages. */
export const MARKED_ORDER_NOTIFICATION_TYPES = [
  'ORDER_SUBMITTED',
  'ORDER_ITEMS_EDITED',
  'ORDER_CANCELLED',
] as const;
export const markedOrderNotificationSchema = z.strictObject({
  id: z.uuid(),
  type: z.enum(MARKED_ORDER_NOTIFICATION_TYPES),
  orderId: z.uuid(),
  orderNumber: z.string(),
  createdAt: isoInstantSchema,
  /** The order's marked goods only. */
  lines: z.array(
    z.strictObject({ productCode: z.string(), name: z.string(), quantity: z.string() }),
  ),
});
export type MarkedOrderNotification = z.infer<typeof markedOrderNotificationSchema>;
export const markedOrderNotificationListResponseSchema = z.strictObject({
  items: z.array(markedOrderNotificationSchema),
});
export type MarkedOrderNotificationListResponse = z.infer<
  typeof markedOrderNotificationListResponseSchema
>;

// Answered by the orders module, which owns the outbox rows. Apart from the staff order contracts:
// the shell's bell reads this, and those stay in the staff-orders feature.
export const MARKED_ORDER_NOTIFICATION_ROUTES = Object.freeze({
  list: route('GET', '/staff/orders/marked-notifications'),
});
