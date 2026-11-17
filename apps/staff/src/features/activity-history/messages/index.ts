import { activityHistoryEn } from './en';
import { activityHistoryRu } from './ru';
import { activityHistoryUz } from './uz';

/** All three languages at once. Tests only: the app loads one language at a time (see i18n). */
export const activityHistoryMessages = {
  uz: activityHistoryUz,
  ru: activityHistoryRu,
  en: activityHistoryEn,
} as const;
