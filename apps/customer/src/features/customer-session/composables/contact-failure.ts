import { useI18n } from 'vue-i18n';
import { ApiRateLimitedError, ApiValidationError } from '@core/lib/api-errors';
import { useErrorMessage } from '@/features/customer-app/composables/use-error-message';

/**
 * Why saving the name and phone failed, already translated: a sentence at the field the server
 * named, or one general sentence when it named none.
 */
export interface ContactFailure {
  readonly general: string | null;
  readonly fields: { readonly fullName: string | null; readonly phone: string | null };
}

const NO_FIELDS = { fullName: null, phone: null } as const;

export function useContactFailure(): (caught: unknown) => ContactFailure {
  const { t } = useI18n();
  const describe = useErrorMessage();
  return (caught) => {
    if (caught instanceof ApiRateLimitedError) {
      return { general: t('customer.contact.errors.rateLimited'), fields: NO_FIELDS };
    }
    if (caught instanceof ApiValidationError) {
      // The server names the field; guessing "phone" for a bad name would send the person astray.
      const paths = caught.issues.map((issue) => issue.path);
      const fullName = paths.includes('fullName') ? t('customer.contact.errors.name') : null;
      const phone = paths.includes('phone') ? t('customer.contact.errors.phone') : null;
      if (fullName !== null || phone !== null)
        return { general: null, fields: { fullName, phone } };
    }
    return { general: describe(caught), fields: NO_FIELDS };
  };
}
