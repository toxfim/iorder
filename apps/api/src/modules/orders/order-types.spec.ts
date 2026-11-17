import {
  AccountingMode,
  NotificationRecipientKind,
  NotificationStatus,
  OrderEventType as PrismaOrderEventType,
  OrderStatus as PrismaOrderStatus,
  PaymentMethod as PrismaPaymentMethod,
  PaymentStatus as PrismaPaymentStatus,
} from '../../generated/prisma/enums.js';
import { ORDER_STATUSES, PAYMENT_STATUSES } from '@iorder/shared';
import { ACCOUNTING_MODES, PAYMENT_METHODS } from '@iorder/shared/staff-orders';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_RECIPIENT_KINDS,
  NOTIFICATION_STATUSES,
  ORDER_EVENT_TYPES,
} from './order-types.js';

// The shared lists, the module lists and the Prisma enums describe one vocabulary. If one
// changes without the others, the database and the code disagree; this fails first.
describe('enums stay in step with the database', () => {
  const values = (e: Record<string, string>): string[] => Object.values(e).sort();

  it.each([
    ['order status', ORDER_STATUSES, PrismaOrderStatus],
    ['payment status', PAYMENT_STATUSES, PrismaPaymentStatus],
    ['accounting mode', ACCOUNTING_MODES, AccountingMode],
    ['payment method', PAYMENT_METHODS, PrismaPaymentMethod],
    ['order event type', ORDER_EVENT_TYPES, PrismaOrderEventType],
    ['notification recipient kind', NOTIFICATION_RECIPIENT_KINDS, NotificationRecipientKind],
    ['notification status', NOTIFICATION_STATUSES, NotificationStatus],
  ])('%s', (_name, list, prismaEnum) => {
    expect([...list].sort()).toEqual(values(prismaEnum));
  });
});
