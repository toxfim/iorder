import { staffCommonEn } from './en';
import { staffCommonRu } from './ru';
import { staffCommonUz } from './uz';

/** All three languages at once. Tests only: the app loads one language at a time (see i18n). */
export const staffCommonMessages = {
  uz: staffCommonUz,
  ru: staffCommonRu,
  en: staffCommonEn,
} as const;
