import { CONFLICT_REASONS } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiResponseError,
  ApiValidationError,
  NetworkError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { coreMessages } from '@core/i18n';
import { en } from '@/i18n/messages/en';
import { ru } from '@/i18n/messages/ru';
import { uz } from '@/i18n/messages/uz';
import { staffOrdersMessages } from '../messages';
import { describeOrderError } from './order-errors';

function lookup(key: string, catalog: unknown): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    return typeof node === 'object' && node !== null
      ? (node as Record<string, unknown>)[part]
      : undefined;
  }, catalog);
}

// `orders.*` comes from the lazy staff-orders catalog, everything else from the eager one.
const catalogs = [
  { ...coreMessages.uz, ...uz, orders: staffOrdersMessages.uz },
  { ...coreMessages.ru, ...ru, orders: staffOrdersMessages.ru },
  { ...coreMessages.en, ...en, orders: staffOrdersMessages.en },
];

describe('describeOrderError', () => {
  it('answers a stale row version with its own message and asks for a reload', () => {
    const error = new ApiConflictError('x', 'CONFLICT', {}, 'ORDER_CHANGED');
    expect(describeOrderError(error)).toEqual({ key: 'orders.errors.changed', reload: true });
  });

  it('maps every other conflict reason through the shared reason table, never the server text', () => {
    for (const reason of CONFLICT_REASONS) {
      if (reason === 'ORDER_CHANGED') continue;
      const described = describeOrderError(
        new ApiConflictError('English text from the server', 'CONFLICT', {}, reason),
      );
      // The picking reasons have the scanner screen's words (orders.picking.*).
      expect(described.key).toMatch(/^(apiErrors|orders\.picking)\./);
      for (const catalog of catalogs) {
        expect(typeof lookup(described.key, catalog)).toBe('string');
      }
    }
  });

  it('reloads after a conflict that says the order moved on, but not after the others', () => {
    const reloads = (reason: (typeof CONFLICT_REASONS)[number]) =>
      describeOrderError(new ApiConflictError('x', 'CONFLICT', {}, reason)).reload;
    expect(reloads('ILLEGAL_ORDER_TRANSITION')).toBe(true);
    expect(reloads('ORDER_NOT_EDITABLE')).toBe(true);
    expect(reloads('PAYMENT_METHOD_NOT_CHANGEABLE')).toBe(true);
    expect(reloads('EMPTY_CART')).toBe(false);
    // a conflict without a (known) reason is generic and does not reload
    expect(describeOrderError(new ApiConflictError('x', 'CONFLICT'))).toEqual({
      key: 'apiErrors.conflict',
      reload: false,
    });
  });

  it('maps the other failures to their own messages', () => {
    expect(describeOrderError(new ApiNotFoundError('x', 'NOT_FOUND'))).toEqual({
      key: 'orders.errors.gone',
      reload: true,
    });
    expect(describeOrderError(new ApiValidationError('x', 'VALIDATION_FAILED', []))).toEqual({
      key: 'orders.errors.invalid',
      reload: false,
    });
    expect(describeOrderError(new PermissionDeniedError())).toEqual({
      key: 'apiErrors.denied',
      reload: false,
    });
    expect(describeOrderError(new NetworkError()).key).toBe('apiErrors.network');
    expect(describeOrderError(new ApiResponseError('x', 500, 'INTERNAL')).key).toBe(
      'apiErrors.generic',
    );
  });

  it('has the order messages in all three languages', () => {
    for (const key of ['orders.errors.changed', 'orders.errors.gone', 'orders.errors.invalid']) {
      for (const catalog of catalogs) expect(typeof lookup(key, catalog)).toBe('string');
    }
  });
});
