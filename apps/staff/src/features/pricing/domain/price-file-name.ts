import { businessParts } from '@core/lib/business-clock';

const two = (value: number): string => String(value).padStart(2, '0');

/**
 * The name of a downloaded price list file when the server sent none: `iorder-price-<date>.xlsx`
 * with the Tashkent calendar date (hard rule 9), so a file saved after midnight UTC+5 is dated
 * the day people see.
 */
export function fallbackPriceFileName(now: Date): string {
  const { year, month, day } = businessParts(now);
  return `iorder-price-${year}-${two(month)}-${two(day)}.xlsx`;
}
