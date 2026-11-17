import { wholeQuantityStringSchema } from '@iorder/shared';
import { normalizeQuantity } from './quantity';

/**
 * Turns what the person typed into a request quantity, or null when it is not a valid positive
 * whole quantity: the cart endpoint refuses fractions. The limits are the contract's own schema,
 * not a copy of them.
 */
export function parseQuantityInput(text: string): string | null {
  const parsed = wholeQuantityStringSchema.safeParse(text.trim());
  return parsed.success ? normalizeQuantity(parsed.data) : null;
}
