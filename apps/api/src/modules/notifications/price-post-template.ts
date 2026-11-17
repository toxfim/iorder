// The caption and button of the price list file posted to the organization groups ([C]
// 2026-10-28, wording 2026-10-29). Groups read UZ (a group has no language of its own yet).

export const PRICE_POST_BUTTON_TEXT = 'Buyurtma berish';

const ORDER_HINT = 'Buyurtma berish uchun tugmani bosishingiz mumkin';

/**
 * "Sana: 28.10.2026", when a USD rate is set "Kurs: 11 960 UZS", and when the post carries a
 * button the line that points to it. The date and rate are the values written in the file, so
 * the caption and the file never disagree.
 */
export function priceListPostCaption(
  file: { dateLabel: string; rateLabel: string | null },
  withButton: boolean,
): string {
  const lines = [`Sana: ${file.dateLabel}`];
  if (file.rateLabel !== null) lines.push(`Kurs: ${file.rateLabel} UZS`);
  if (withButton) lines.push(ORDER_HINT);
  return lines.join('\n');
}
