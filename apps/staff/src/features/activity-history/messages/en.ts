import type { ActivityHistoryMessages } from './uz';

// First draft: needs a native-speaker review.
export const activityHistoryEn: ActivityHistoryMessages = {
  title: 'Activity history',
  subtitle: 'One audit log for orders, prices, staff and organizations.',
  info: {
    title: 'Every change has its own history',
    summary: '{count} records · with previous and new values',
    retention: 'Kept: forever',
    noDelete: 'Deleting is not allowed',
  },
  search: 'Order, staff member, organization or comment',
  filters: {
    group: 'History filters',
    object: 'Object',
    allObjects: 'All objects',
  },
  results: '{count} results',
  footer: '{shown} / {total} records · Newest → oldest',
  tableLabel: 'Activity history records',
  columns: {
    at: 'Date and time',
    actor: 'Author',
    object: 'Object',
    action: 'Action',
    change: 'Previous → new value',
  },
  time: '{time} · UTC+5',
  actor: {
    system: 'System',
    systemRole: 'Automatic',
    customer: 'Customer · {organization}',
  },
  objects: {
    ORDER: 'Order',
    PRICE_LIST: 'Price list',
    PAYMENT: 'Payment',
    STAFF: 'Staff member',
    ORGANIZATION: 'Organization',
  },
  actions: {
    ORDER_SUBMITTED: 'Order submitted',
    ORDER_APPROVED: 'Manager approved',
    ORDER_ACCOUNTING_CLEARED: 'Accounting approved',
    ORDER_RELEASED: 'Released from the warehouse',
    ORDER_DELIVERED: 'Delivered',
    ORDER_CANCELLED: 'Cancelled',
    PRICE_LIST_PUBLISHED: 'Prices published',
    PAYMENT_RECORDED: 'Payment recorded',
    STAFF_BLOCKED: 'Access suspended',
    STAFF_ROLE_GRANTED: 'Role granted',
    ORGANIZATION_ACTIVATED: 'Organization activated',
  },
  values: {
    none: '—',
    active: 'Active',
    inactive: 'Suspended',
    version: 'v{number}',
  },
  detail: {
    title: 'Event details · {action}',
    meta: '{date}, {time} · {actor}',
    object: 'Object',
    before: 'Previous value',
    after: 'New value',
    note: 'Comment',
    noNote: 'No comment.',
  },
  noMatch: 'No record matches the search',
  empty: {
    title: 'No records yet',
    description: 'The first action will appear here.',
  },
  unavailable: {
    title: 'Activity history is not available yet',
    description:
      'Every action is recorded on the server, but the page that shows it is not connected yet. Once it is, the records appear here.',
  },
};
