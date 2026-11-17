import { idempotencyKeySchema } from '@iorder/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiConflictError,
  ApiResponseError,
  InvalidResponseError,
  NetworkError,
  PermissionDeniedError,
  RequestTimeoutError,
} from '@core/lib/api-errors';
import {
  SUBMIT_KEY_STORAGE_KEY,
  SUBMIT_KEY_TTL_MS,
  cartFingerprint,
  currentSubmitKey,
  forgetSubmitKey,
  outcomeIsUnknown,
} from './submit-key';

afterEach(() => {
  vi.restoreAllMocks();
  forgetSubmitKey();
});

describe('submit key', () => {
  it('is generated once, valid for the contract, and kept in sessionStorage', () => {
    const key = currentSubmitKey('cart-a');
    expect(idempotencyKeySchema.safeParse(key).success).toBe(true);
    expect(currentSubmitKey('cart-a')).toBe(key);
    const stored = JSON.parse(window.sessionStorage.getItem(SUBMIT_KEY_STORAGE_KEY) ?? '{}');
    expect(stored.key).toBe(key);
  });

  it('a page reload (a new module state, the same sessionStorage) keeps the key for the same cart', () => {
    const now = Date.now();
    window.sessionStorage.setItem(
      SUBMIT_KEY_STORAGE_KEY,
      JSON.stringify({ key: 'stored-before-reload', fingerprint: 'cart-a', issuedAt: now }),
    );
    expect(currentSubmitKey('cart-a', now + 1000)).toBe('stored-before-reload');
  });

  it('a changed cart gets a new key', () => {
    const first = currentSubmitKey('cart-a');
    expect(currentSubmitKey('cart-b')).not.toBe(first);
    expect(currentSubmitKey('cart-a')).not.toBe(first);
  });

  it('expires after 10 minutes', () => {
    const t0 = 1_000_000;
    const first = currentSubmitKey('cart-a', t0);
    expect(currentSubmitKey('cart-a', t0 + SUBMIT_KEY_TTL_MS - 1)).toBe(first);
    expect(currentSubmitKey('cart-a', t0 + SUBMIT_KEY_TTL_MS)).not.toBe(first);
  });

  it('ignores garbage in storage', () => {
    window.sessionStorage.setItem(SUBMIT_KEY_STORAGE_KEY, 'not-json');
    expect(idempotencyKeySchema.safeParse(currentSubmitKey('cart-a')).success).toBe(true);
  });

  it('forgetting it makes the next attempt a new one', () => {
    const first = currentSubmitKey('cart-a');
    forgetSubmitKey();
    expect(window.sessionStorage.getItem(SUBMIT_KEY_STORAGE_KEY)).toBeNull();
    expect(currentSubmitKey('cart-a')).not.toBe(first);
  });

  it('still works when sessionStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const key = currentSubmitKey('cart-a');
    expect(currentSubmitKey('cart-a')).toBe(key);
  });
});

describe('cartFingerprint', () => {
  it('ignores line order, but not content or comment', () => {
    const a = { productId: 'p1', quantity: '1' };
    const b = { productId: 'p2', quantity: '2' };
    expect(cartFingerprint([a, b])).toBe(cartFingerprint([b, a]));
    expect(cartFingerprint([a, b])).not.toBe(cartFingerprint([a, { ...b, quantity: '3' }]));
    expect(cartFingerprint([a], 'x')).not.toBe(cartFingerprint([a]));
  });
});

describe('outcomeIsUnknown', () => {
  it('is true when the request may have reached the server', () => {
    expect(outcomeIsUnknown(new NetworkError())).toBe(true);
    expect(outcomeIsUnknown(new RequestTimeoutError())).toBe(true);
    expect(outcomeIsUnknown(new InvalidResponseError('garbled'))).toBe(true);
    expect(outcomeIsUnknown(new ApiResponseError('boom', 500, 'INTERNAL_ERROR'))).toBe(true);
    expect(outcomeIsUnknown(new ApiResponseError('bad gateway', 502, 'Bad Gateway'))).toBe(true);
  });

  it('is false for any definite answer', () => {
    expect(outcomeIsUnknown(new ApiConflictError('x', 'CONFLICT', undefined, 'EMPTY_CART'))).toBe(
      false,
    );
    expect(outcomeIsUnknown(new PermissionDeniedError())).toBe(false);
    expect(outcomeIsUnknown(new ApiResponseError('x', 422, 'VALIDATION_FAILED'))).toBe(false);
    expect(outcomeIsUnknown(new Error('other'))).toBe(false);
  });
});
