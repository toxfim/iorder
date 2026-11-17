import { createLazyMessages } from './lazy-messages';

// Back-office prose of the shared screens (dashboard, recent actions, search, customers, staff,
// products) is staff-only: it is merged at the root of the catalog after a dynamic import, only
// for the staff area, so it never ships in the customer entry chunk.
export const ensureStaffCommonMessages = createLazyMessages(null, {
  uz: async () => (await import('@/features/staff-common/messages/uz')).staffCommonUz,
  ru: async () => (await import('@/features/staff-common/messages/ru')).staffCommonRu,
  en: async () => (await import('@/features/staff-common/messages/en')).staffCommonEn,
});
