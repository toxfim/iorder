import type { ComposerTranslation } from 'vue-i18n';
import type { DescribedError } from '@core/lib/price-errors';

/**
 * Translates a described error. A numeric `count` param also selects the plural form, so RU
 * (one/few/many) and EN (1 product / 2 products) read correctly; UZ messages have no plural.
 */
export function translateDescribed(t: ComposerTranslation, described: DescribedError): string {
  const named = { ...described.params };
  const count = described.params?.count;
  return typeof count === 'number' ? t(described.key, named, count) : t(described.key, named);
}
