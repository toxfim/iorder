import { staffCostEn } from './en';
import { staffCostRu } from './ru';
import { staffCostUz } from './uz';

/** All three languages at once. Tests only: the app loads one language at a time (see i18n). */
export const staffCostMessages = { uz: staffCostUz, ru: staffCostRu, en: staffCostEn } as const;
