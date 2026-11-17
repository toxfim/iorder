import { staffUsersEn } from './en';
import { staffUsersRu } from './ru';
import { staffUsersUz } from './uz';

/** All three languages at once. Tests only: the app loads one language at a time (see i18n). */
export const staffUsersMessages = {
  uz: staffUsersUz,
  ru: staffUsersRu,
  en: staffUsersEn,
} as const;
