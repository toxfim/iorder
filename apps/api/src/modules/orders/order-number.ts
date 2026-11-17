/**
 * Human-readable order number: prefix + a sequential number from the database sequence
 * `order_number_seq`. OPEN PRODUCT QUESTION (data-model section 5, question 5): the real format
 * (daily counter? prefix?) is not decided. Both constants are the only places to change; the
 * sequence start is in the migration `orders_core` and a test keeps the two in step.
 */
export const ORDER_NUMBER_PREFIX = 'IO-';
export const ORDER_NUMBER_START = 10001;

export function formatOrderNumber(sequenceValue: bigint | number): string {
  const value = BigInt(sequenceValue);
  if (value < BigInt(ORDER_NUMBER_START)) {
    throw new RangeError(`Order sequence value ${value} is below the start ${ORDER_NUMBER_START}`);
  }
  return `${ORDER_NUMBER_PREFIX}${value}`;
}
