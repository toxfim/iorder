/**
 * Reason codes of a rejected sheet row that have a translated label (`staffCost.sync.rejectReason`).
 * The shared contract types `reason` as a plain string: the api stores the short validation
 * message of the row (see sheets-sync `toRejectedRows`), so both the machine codes and those
 * messages are recognised here. Anything else gets the neutral `UNKNOWN` label.
 */
export const REJECT_REASON_CODES = [
  'NOT_A_NUMBER',
  'MISSING_PRODUCT_CODE',
  'INVALID_PRODUCT_CODE',
  'INVALID_DATE',
  'DATE_OUT_OF_WINDOW',
  'INVALID_TEXT_LENGTH',
] as const;

export type RejectReasonCode = (typeof REJECT_REASON_CODES)[number] | 'UNKNOWN';

const BY_MESSAGE: ReadonlyMap<string, RejectReasonCode> = new Map([
  ['Not a valid non-negative number', 'NOT_A_NUMBER'],
  ['Not a valid product code', 'INVALID_PRODUCT_CODE'],
  ['Expected a date written DD.MM.YYYY', 'INVALID_DATE'],
  ['Date is outside the plausible delivery window', 'DATE_OUT_OF_WINDOW'],
]);

export function rejectReasonCode(reason: string): RejectReasonCode {
  const known = REJECT_REASON_CODES.find((code) => code === reason);
  if (known) return known;
  const byMessage = BY_MESSAGE.get(reason);
  if (byMessage) return byMessage;
  // "Expected text of 1-200 characters": the limit is part of the message.
  return /^Expected text of \d+-\d+ characters$/.test(reason) ? 'INVALID_TEXT_LENGTH' : 'UNKNOWN';
}
