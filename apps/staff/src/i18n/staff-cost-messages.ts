import { createLazyMessages } from './lazy-messages';

// Hard rule 7: cost vocabulary (cost, supplier, purchase method...) is staff-only, so its labels
// are not part of the eager catalogs. They live next to the staff-cost UI (the staff-finance
// chunk) and are merged here after a dynamic import, per locale, only for the staff area.
export const ensureStaffCostMessages = createLazyMessages('staffCost', {
  uz: async () => (await import('@/features/staff-cost/messages/uz')).staffCostUz,
  ru: async () => (await import('@/features/staff-cost/messages/ru')).staffCostRu,
  en: async () => (await import('@/features/staff-cost/messages/en')).staffCostEn,
});
