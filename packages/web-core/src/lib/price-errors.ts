import { stockLimitExceededDetailsSchema, type ConflictReason } from '@iorder/shared';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  InvalidResponseError,
  NetworkError,
  PermissionDeniedError,
  RequestTimeoutError,
} from '@core/lib/api-errors';

/** What the person was doing when the request failed (used for 404, which carries no reason). */
export type PricingOperation =
  | 'load'
  | 'publish'
  | 'history'
  | 'createProduct'
  | 'updateProduct'
  // Staff cost screens (features/staff-cost) reuse this mapping for their own calls.
  | 'rate'
  | 'removal'
  | 'stock'
  // Brands and the price list file (features/staff-brands, the Narxlar file actions).
  | 'brand'
  // Back-office orders (features/staff-orders) reuse it for their calls too.
  | 'order';

export interface DescribedError {
  /** vue-i18n key under `apiErrors`. */
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/**
 * One i18n message per shared CONFLICT_REASONS value. The Record type makes a new reason in the
 * contract a compile error here until it has a message.
 */
export const CONFLICT_REASON_MESSAGES: Readonly<Record<ConflictReason, string>> = {
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

// Their messages count the products named in `details.productIds`.
const COUNTED_REASONS: ReadonlySet<ConflictReason> = new Set([
  'INACTIVE_PRODUCT',
  'INACTIVE_PRODUCT_IN_DRAFT',
]);

/** Product ids the api names in `details.productIds` (inactive or unknown products). */
export function productIdsFromDetails(details: unknown): string[] {
  if (typeof details !== 'object' || details === null || !('productIds' in details)) return [];
  const ids: unknown = details.productIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * The figure the api names in a STOCK_LIMIT_EXCEEDED refusal about ONE product (a cart change), 0
 * when it is out of stock, or null: a refusal about several products (a submit) or a body this
 * client does not understand.
 */
export function stockLimitFromDetails(details: unknown): number | null {
  const parsed = stockLimitExceededDetailsSchema.safeParse(details);
  if (!parsed.success || parsed.data.lines.length !== 1) return null;
  return parsed.data.lines[0]?.orderableStock ?? null;
}

/**
 * Maps a typed api error to a message key. The api's English `message` is never shown: the
 * wording lives in i18n (UZ, RU, EN) and is chosen from the shared error code, the status, the
 * `details` and the operation, as the contract intends.
 */
export function describePricingError(operation: PricingOperation, error: unknown): DescribedError {
  if (error instanceof PermissionDeniedError) return { key: 'apiErrors.denied' };
  if (error instanceof RequestTimeoutError) return { key: 'apiErrors.timeout' };
  if (error instanceof NetworkError) return { key: 'apiErrors.network' };
  if (error instanceof InvalidResponseError) return { key: 'apiErrors.invalidResponse' };

  if (error instanceof ApiConflictError) {
    // Keyed by the server's machine-readable reason only; no guessing from the operation. A
    // missing or unknown reason (a newer server) gets the generic conflict message.
    const key = error.reason ? CONFLICT_REASON_MESSAGES[error.reason] : 'apiErrors.conflict';
    if (error.reason === 'STOCK_LIMIT_EXCEEDED') {
      // One product: the sentence says how many can be ordered, or that nothing is left. Several:
      // the cart lines say it.
      const count = stockLimitFromDetails(error.details);
      if (count === null) return { key };
      if (count === 0) return { key: 'apiErrors.stockLimitExceededNone' };
      return { key: 'apiErrors.stockLimitExceededOne', params: { count } };
    }
    const productIds = productIdsFromDetails(error.details);
    const count = productIds.length;
    return error.reason && COUNTED_REASONS.has(error.reason) && count > 0
      ? { key, params: { count } }
      : { key };
  }

  if (error instanceof ApiNotFoundError) {
    const productIds = productIdsFromDetails(error.details);
    if (productIds.length > 0) {
      return { key: 'apiErrors.unknownProducts', params: { count: productIds.length } };
    }
    return { key: operation === 'load' ? 'apiErrors.notFound' : 'apiErrors.gone' };
  }

  if (error instanceof ApiValidationError) return { key: 'apiErrors.validation' };
  return { key: 'apiErrors.generic' };
}
