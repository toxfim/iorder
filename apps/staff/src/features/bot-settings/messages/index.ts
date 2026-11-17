import { botSettingsEn } from './en';
import { botSettingsRu } from './ru';
import { botSettingsUz } from './uz';

/** All three languages at once. Tests only: the app loads one language at a time (see i18n). */
export const botSettingsMessages = {
  uz: botSettingsUz,
  ru: botSettingsRu,
  en: botSettingsEn,
} as const;
