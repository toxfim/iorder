import { createLazyMessages } from './lazy-messages';

// The staff accounts page and the block dialog (logins, group removal reasons) are staff-only:
// the prose lives with the feature and is merged under `staffUsers` after a dynamic import, only
// for the staff area.
export const ensureStaffUsersMessages = createLazyMessages('staffUsers', {
  uz: async () => (await import('@/features/staff-users/messages/uz')).staffUsersUz,
  ru: async () => (await import('@/features/staff-users/messages/ru')).staffUsersRu,
  en: async () => (await import('@/features/staff-users/messages/en')).staffUsersEn,
});
