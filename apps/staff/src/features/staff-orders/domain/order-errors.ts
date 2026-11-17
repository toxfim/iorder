import type { ConflictReason } from '@iorder/shared';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { describePricingError, type DescribedError } from '@core/lib/price-errors';

export interface OrderErrorMessage extends DescribedError {
  /**
   * The order moved on (or is gone) since the person looked at it: the screen re-reads it so the
   * next click works on what the server has now.
   */
  readonly reload: boolean;
}

/** A line the release refused (409 UNIT_CODES_INCOMPLETE `details.items`). */
export interface IncompleteItem {
  readonly itemId: string;
  readonly productCode: string;
  readonly incompleteUnits: number;
}

/** Reads `details.items` of UNIT_CODES_INCOMPLETE; malformed entries are skipped. */
export function incompleteItems(details: unknown): IncompleteItem[] {
  if (typeof details !== 'object' || details === null || !('items' in details)) return [];
  const items: unknown = details.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown): IncompleteItem[] => {
    if (typeof item !== 'object' || item === null) return [];
    const { itemId, productCode, incompleteUnits } = item as Record<string, unknown>;
    return typeof itemId === 'string' &&
      typeof productCode === 'string' &&
      typeof incompleteUnits === 'number'
      ? [{ itemId, productCode, incompleteUnits }]
      : [];
  });
}

// The picking conflicts outside a scan (the scan screen has its own wording, picking-model.ts).
const PICKING_CONFLICT_KEYS: Partial<Record<ConflictReason, string>> = {
  UNIT_CODE_DUPLICATE: 'orders.picking.errors.duplicate',
  UNIT_CODE_NOT_REQUIRED: 'orders.picking.errors.notRequired',
  UNIT_CODES_NOT_EDITABLE: 'orders.picking.errors.notEditable',
};

// Catalog reasons an order call never raises; the generic conflict words if one ever arrives.
const FOREIGN_REASONS: ReadonlySet<ConflictReason> = new Set([
  'DUPLICATE_CATEGORY_NAME',
  'CATEGORY_ARCHIVED',
]);

/**
 * Maps a failed staff order call to an i18n message. A stale row version (409 reason
 * ORDER_CHANGED) gets its own message and a reload; every other conflict reason goes through the
 * shared reason table, never through the server's English text.
 */
export function describeOrderError(error: unknown): OrderErrorMessage {
  if (error instanceof ApiConflictError) {
    if (error.reason === 'ORDER_CHANGED') return { key: 'orders.errors.changed', reload: true };
    if (error.reason === 'UNIT_CODES_INCOMPLETE') {
      const products = incompleteItems(error.details)
        .map((item) => item.productCode)
        .join(', ');
      return products === ''
        ? { key: 'orders.picking.errors.incomplete', reload: false }
        : { key: 'orders.picking.errors.incompleteList', params: { products }, reload: false };
    }
    const pickingKey = error.reason ? PICKING_CONFLICT_KEYS[error.reason] : undefined;
    if (pickingKey) return { key: pickingKey, reload: true };
    if (error.reason && FOREIGN_REASONS.has(error.reason)) {
      return { key: 'apiErrors.conflict', reload: false };
    }
    const reload =
      error.reason === 'ILLEGAL_ORDER_TRANSITION' ||
      error.reason === 'ORDER_NOT_EDITABLE' ||
      error.reason === 'PAYMENT_METHOD_NOT_CHANGEABLE' ||
      error.reason === 'PAYMENT_PLAN_NOT_CHANGEABLE';
    return { ...describePricingError('order', error), reload };
  }
  if (error instanceof ApiNotFoundError) return { key: 'orders.errors.gone', reload: true };
  if (error instanceof ApiValidationError) return { key: 'orders.errors.invalid', reload: false };
  if (error instanceof PermissionDeniedError) return { key: 'apiErrors.denied', reload: false };
  return { ...describePricingError('order', error), reload: false };
}
