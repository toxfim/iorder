import { staffOrdersEn } from './en';
import { staffOrdersRu } from './ru';
import { staffOrdersUz } from './uz';

/** All three languages at once. Tests only: the app loads one language at a time (see i18n). */
export const staffOrdersMessages = {
  uz: staffOrdersUz,
  ru: staffOrdersRu,
  en: staffOrdersEn,
} as const;
