import { CONFLICT_REASONS, ERROR_CODES, type ConflictReason } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiResponseError,
  ApiValidationError,
  InvalidResponseError,
  NetworkError,
  PermissionDeniedError,
  RequestTimeoutError,
} from '@core/lib/api-errors';
import { coreEn as en } from '@core/i18n/messages/en';
import { coreRu as ru } from '@core/i18n/messages/ru';
import { coreUz as uz } from '@core/i18n/messages/uz';
import {
  CONFLICT_REASON_MESSAGES,
  describePricingError,
  type PricingOperation,
} from './price-errors';

const conflict = (details?: unknown, reason?: ConflictReason) =>
  new ApiConflictError('x', 'CONFLICT', details, reason);

function lookup(key: string, catalog: unknown = uz): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    return typeof node === 'object' && node !== null
      ? (node as Record<string, unknown>)[part]
      : undefined;
  }, catalog);
}

it('the reason table covers exactly the shared CONFLICT_REASONS', () => {
  expect(Object.keys(CONFLICT_REASON_MESSAGES).sort()).toEqual([...CONFLICT_REASONS].sort());
});

describe('describePricingError', () => {
  const EXPECTED_KEYS: Record<ConflictReason, string> = {
    DRAFT_ALREADY_OPEN: 'apiErrors.draftAlreadyOpen',
    DRAFT_NOT_OPEN: 'apiErrors.draftNotOpen',
    VERSION_NOT_DRAFT: 'apiErrors.versionNotDraft',
    INVALID_VERSION_TRANSITION: 'apiErrors.invalidTransition',
    EMPTY_DRAFT: 'apiErrors.emptyDraft',
    NO_PUBLISHED_VERSION: 'apiErrors.noPublishedVersion',
    ANOTHER_VERSION_PUBLISHED: 'apiErrors.anotherPublished',
    INACTIVE_PRODUCT: 'apiErrors.inactiveProducts',
    INACTIVE_PRODUCT_IN_DRAFT: 'apiErrors.inactiveInDraft',
    DUPLICATE_PRODUCT_CODE: 'apiErrors.productCodeExists',
    REMOVAL_REQUEST_NOT_PENDING: 'apiErrors.removalRequestNotPending',
    ORDER_CHANGED: 'apiErrors.orderChanged',
    ILLEGAL_ORDER_TRANSITION: 'apiErrors.illegalOrderTransition',
    ORDER_NOT_EDITABLE: 'apiErrors.orderNotEditable',
    PAYMENT_METHOD_NOT_CHANGEABLE: 'apiErrors.paymentMethodNotChangeable',
    PAYMENT_PLAN_NOT_CHANGEABLE: 'apiErrors.paymentPlanNotChangeable',
    DEFERRED_PRICE_UNAVAILABLE: 'apiErrors.deferredPriceUnavailable',
    PAYMENT_PLAN_WINDOW_ENDED: 'apiErrors.paymentPlanWindowEnded',
    CART_TOTAL_CHANGED: 'apiErrors.cartTotalChanged',
    CURRENCY_CONVERSION_UNAVAILABLE: 'apiErrors.currencyConversionUnavailable',
    EMPTY_CART: 'apiErrors.emptyCart',
    PRODUCT_NOT_ORDERABLE: 'apiErrors.productNotOrderable',
    STOCK_LIMIT_EXCEEDED: 'apiErrors.stockLimitExceeded',
    IDEMPOTENCY_KEY_REUSED: 'apiErrors.idempotencyKeyReused',
    ORDERING_ORGANIZATION_INACTIVE: 'apiErrors.orderingOrganizationInactive',
    CONTACT_REQUIRED: 'apiErrors.contactRequired',
    PLACER_NOT_MEMBER: 'apiErrors.placerNotMember',
    LAST_ADMIN: 'apiErrors.lastAdmin',
    TELEGRAM_ID_REQUIRED: 'apiErrors.telegramIdRequired',
    ORGANIZATION_NOT_LINKED: 'apiErrors.organizationNotLinked',
    ORGANIZATION_ALREADY_LINKED: 'apiErrors.organizationAlreadyLinked',
    PERSON_ORGANIZATION: 'apiErrors.personOrganization',
    ORGANIZATION_ARCHIVED: 'apiErrors.organizationArchived',
    BOT_NOT_CONFIGURED: 'apiErrors.botNotConfigured',
    UNIT_CODE_DUPLICATE: 'apiErrors.unitCodeDuplicate',
    UNIT_CODE_NOT_REQUIRED: 'apiErrors.unitCodeNotRequired',
    UNIT_CODES_NOT_EDITABLE: 'apiErrors.unitCodesNotEditable',
    GOODS_RETURN_NOT_PENDING: 'apiErrors.goodsReturnNotPending',
    UNIT_CODES_INCOMPLETE: 'apiErrors.unitCodesIncomplete',
    ALLOCATION_CHANGED: 'apiErrors.allocationChanged',
    STOCK_INSUFFICIENT: 'apiErrors.stockInsufficient',
    SUPPLY_PARTY_CONFLICT: 'apiErrors.supplyPartyConflict',
    SUPPLY_PARTY_CHANGED: 'apiErrors.supplyPartyChanged',
    SUPPLY_NOT_AVAILABLE: 'apiErrors.supplyNotAvailable',
    ALLOCATION_NOT_CHANGEABLE: 'apiErrors.allocationNotChangeable',
    DUPLICATE_CATEGORY_NAME: 'apiErrors.duplicateCategoryName',
    CATEGORY_ARCHIVED: 'apiErrors.categoryArchived',
    PAYMENT_VOIDED: 'apiErrors.paymentVoided',
    PRICE_LIST_CHANGED: 'apiErrors.priceListChanged',
    EMPTY_PRICE_LIST: 'apiErrors.emptyPriceList',
    SHEET_SYNC_QUEUE_UNAVAILABLE: 'apiErrors.sheetSyncQueueUnavailable',
    DUPLICATE_BRAND_NAME: 'apiErrors.duplicateBrandName',
    PRODUCT_IMAGE_DUPLICATE: 'apiErrors.productImageDuplicate',
    PRIMARY_IMAGE_EXISTS: 'apiErrors.primaryImageExists',
    RESERVED_PRODUCT_CODE_PREFIX: 'apiErrors.reservedProductCodePrefix',
    NOT_GENERATED_CODE: 'apiErrors.notGeneratedCode',
    TARGET_IS_GENERATED: 'apiErrors.targetIsGenerated',
    PRODUCT_ALREADY_MERGED: 'apiErrors.productAlreadyMerged',
    STAFF_ORDERING_DISABLED: 'apiErrors.staffOrderingDisabled',
  };

  it.each(CONFLICT_REASONS)(
    '409 reason %s has its own message in all three languages',
    (reason) => {
      const described = describePricingError('publish', conflict(undefined, reason));
      expect(described.key).toBe(EXPECTED_KEYS[reason]);
      for (const catalog of [uz, ru, en]) {
        expect(typeof lookup(described.key, catalog)).toBe('string');
      }
    },
  );

  it('the message depends on the reason only, never on the operation', () => {
    const operations: PricingOperation[] = [
      'load',
      'publish',
      'history',
      'createProduct',
      'updateProduct',
      'rate',
      'removal',
      'stock',
      'order',
    ];
    for (const reason of CONFLICT_REASONS) {
      const keys = new Set(
        operations.map((op) => describePricingError(op, conflict(undefined, reason)).key),
      );
      expect([...keys]).toEqual([EXPECTED_KEYS[reason]]);
    }
  });

  it('counts the products named in details for the inactive-product reasons', () => {
    expect(
      describePricingError('publish', conflict({ productIds: ['a', 'b'] }, 'INACTIVE_PRODUCT')),
    ).toEqual({ key: 'apiErrors.inactiveProducts', params: { count: 2 } });
    expect(
      describePricingError('publish', conflict({ productIds: ['a'] }, 'INACTIVE_PRODUCT_IN_DRAFT')),
    ).toEqual({ key: 'apiErrors.inactiveInDraft', params: { count: 1 } });
  });

  it('a stock refusal about one product says how many can be ordered, in all three languages', () => {
    const one = {
      lines: [{ productId: '019a0000-0000-7000-8000-000000000001', orderableStock: 45 }],
    };
    expect(describePricingError('order', conflict(one, 'STOCK_LIMIT_EXCEEDED'))).toEqual({
      key: 'apiErrors.stockLimitExceededOne',
      params: { count: 45 },
    });
    for (const catalog of [uz, ru, en]) {
      expect(lookup('apiErrors.stockLimitExceededOne', catalog)).toContain('{count}');
    }
    // Out of stock: a figure of zero, its own sentence.
    const none = { lines: [{ ...one.lines[0], orderableStock: 0 }] };
    expect(describePricingError('order', conflict(none, 'STOCK_LIMIT_EXCEEDED'))).toEqual({
      key: 'apiErrors.stockLimitExceededNone',
    });
    for (const catalog of [uz, ru, en]) {
      expect(typeof lookup('apiErrors.stockLimitExceededNone', catalog)).toBe('string');
    }
    // Several products (a refused order), or details this client cannot read: the general sentence.
    const two = {
      lines: [
        ...one.lines,
        { productId: '019a0000-0000-7000-8000-000000000002', orderableStock: 3 },
      ],
    };
    for (const details of [two, undefined, { lines: [{ productId: 'x', orderableStock: -1 }] }]) {
      expect(describePricingError('order', conflict(details, 'STOCK_LIMIT_EXCEEDED'))).toEqual({
        key: 'apiErrors.stockLimitExceeded',
      });
    }
  });

  it('falls back to a generic conflict message without a reason, even when details look familiar', () => {
    expect(describePricingError('publish', conflict()).key).toBe('apiErrors.conflict');
    expect(describePricingError('createProduct', conflict({ productIds: ['a'] })).key).toBe(
      'apiErrors.conflict',
    );
  });

  it('maps 404, 422, 401/403, network and contract failures', () => {
    expect(
      describePricingError(
        'publish',
        new ApiNotFoundError('x', 'NOT_FOUND', { productIds: ['p'] }),
      ),
    ).toEqual({ key: 'apiErrors.unknownProducts', params: { count: 1 } });
    expect(describePricingError('load', new ApiNotFoundError('x', 'NOT_FOUND')).key).toBe(
      'apiErrors.notFound',
    );
    expect(
      describePricingError('publish', new ApiValidationError('x', 'VALIDATION_FAILED', [])).key,
    ).toBe('apiErrors.validation');
    expect(describePricingError('load', new PermissionDeniedError()).key).toBe('apiErrors.denied');
    expect(describePricingError('load', new NetworkError()).key).toBe('apiErrors.network');
    expect(describePricingError('publish', new RequestTimeoutError()).key).toBe(
      'apiErrors.timeout',
    );
    expect(describePricingError('load', new InvalidResponseError('x')).key).toBe(
      'apiErrors.invalidResponse',
    );
    expect(describePricingError('load', new ApiResponseError('x', 500, 'INTERNAL_ERROR')).key).toBe(
      'apiErrors.generic',
    );
    expect(describePricingError('load', new Error('boom')).key).toBe('apiErrors.generic');
  });

  it('only ever returns keys that exist in the Uzbek catalog', () => {
    const operations: PricingOperation[] = [
      'load',
      'publish',
      'history',
      'createProduct',
      'updateProduct',
      'rate',
      'removal',
      'stock',
      'order',
    ];
    const errors: unknown[] = [
      conflict(),
      conflict({ productIds: ['a'] }),
      new ApiNotFoundError('x', 'NOT_FOUND'),
      new ApiNotFoundError('x', 'NOT_FOUND', { productIds: ['a'] }),
      new ApiValidationError('x', 'VALIDATION_FAILED', []),
      new PermissionDeniedError(),
      new NetworkError(),
      new RequestTimeoutError(),
      new InvalidResponseError('x'),
      new Error('x'),
    ];
    for (const operation of operations) {
      for (const error of errors) {
        const { key } = describePricingError(operation, error);
        expect({ key, text: typeof lookup(key) }).toEqual({ key, text: 'string' });
      }
    }
  });

  it('knows every shared error code the api can return', () => {
    // Guards against a new code being added to the contract without a decision here.
    expect(ERROR_CODES).toEqual([
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'INTERNAL_ERROR',
    ]);
  });
});
