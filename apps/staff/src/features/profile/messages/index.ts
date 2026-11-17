import { staffProfileEn } from './en';
import { staffProfileRu } from './ru';
import { staffProfileUz } from './uz';

/** All three languages at once. Tests only: the app loads one language at a time (see i18n). */
export const staffProfileMessages = {
  uz: staffProfileUz,
  ru: staffProfileRu,
  en: staffProfileEn,
} as const;
