// Vocabulary of the orders module that is stored in the database. The lists live in
// `@iorder/shared/staff-orders` (the HTTP contracts use them too); a unit test compares them with the Prisma
// enums (orders.prisma) generated from the schema so they cannot drift.
//
// ORDER_EVENT_TYPES: DRIVER_ASSIGNED (reassigning a driver), ACCOUNTING_REVIEWED (the accountant's
// acknowledgement of a skipped order, Q14) and COMMENT_ADDED (a free comment) belong to the
// documented list but nothing writes them yet; they are kept so the later features need no enum
// migration. Today the release records its driver inside the STATUS_CHANGED payload.
export {
  NOTIFICATION_RECIPIENT_KINDS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  ORDER_EVENT_TYPES,
  type NotificationRecipientKind,
  type NotificationStatus,
  type NotificationType,
  type OrderEventType,
} from '@iorder/shared/staff-orders';
