import { staffOrganizationsEn } from './en';
import { staffOrganizationsRu } from './ru';
import { staffOrganizationsUz } from './uz';

/** All three languages at once. Tests only: the app loads one language at a time (see i18n). */
export const staffOrganizationsMessages = {
  uz: staffOrganizationsUz,
  ru: staffOrganizationsRu,
  en: staffOrganizationsEn,
} as const;
