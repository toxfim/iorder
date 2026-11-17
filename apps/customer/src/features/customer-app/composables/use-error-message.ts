import { useI18n } from 'vue-i18n';
import { describePricingError } from '@core/lib/price-errors';

/**
 * Turns a failed call into a sentence in the person's language. The server's English message is
 * never shown; the wording is chosen from the machine-readable reason and status.
 */
export function useErrorMessage(): (error: unknown) => string {
  const { t } = useI18n();
  return (error) => {
    const { key, params } = describePricingError('load', error);
    return t(key, params ?? {});
  };
}
