import { createLazyMessages } from './lazy-messages';

// The back-office order vocabulary (accounting step, skip marker, delivery contact, notification
// markers, role queues) is staff-only: it lives with the staff-orders UI and is merged under
// `orders` after a dynamic import, only for the staff area.
export const ensureStaffOrdersMessages = createLazyMessages('orders', {
  uz: async () => (await import('@/features/staff-orders/messages/uz')).staffOrdersUz,
  ru: async () => (await import('@/features/staff-orders/messages/ru')).staffOrdersRu,
  en: async () => (await import('@/features/staff-orders/messages/en')).staffOrdersEn,
});
