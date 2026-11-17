import { createLazyMessages } from './lazy-messages';

// The organizations screens' prose (group ids, who added the bot, activation) is staff-only: it
// lives with the feature and is merged under `organizations` after a dynamic import, only for
// the staff area.
export const ensureStaffOrganizationsMessages = createLazyMessages('organizations', {
  uz: async () => (await import('@/features/staff-organizations/messages/uz')).staffOrganizationsUz,
  ru: async () => (await import('@/features/staff-organizations/messages/ru')).staffOrganizationsRu,
  en: async () => (await import('@/features/staff-organizations/messages/en')).staffOrganizationsEn,
});
