import { z } from 'zod';
import { LOCALES } from '../roles.js';

// Contracts shared by api and web (CLAUDE.md: one definition). Request schemas validate at the
// api boundary; response schemas are what the web can parse. Money is ALWAYS a decimal string.

/** A language code of the UI and of translations: UZ, RU or EN. */
export const languageCodeSchema = z.enum(LOCALES);

export const uuidSchema = z.uuid();

/** `^(0|[1-9]\d{0,N-1})(\.\d{1,F})?$`: no sign, exponent, separators or leading zeros. */
export function decimalPattern(maxIntegerDigits: number, maxFractionDigits: number): RegExp {
  return new RegExp(`^(0|[1-9]\\d{0,${maxIntegerDigits - 1}})(\\.\\d{1,${maxFractionDigits}})?$`);
}

/**
 * The ONE helper for decimal strings (money, rates, quantities). Extra fraction digits are
 * rejected, never rounded. `positive` additionally rejects zero.
 */
export function decimalStringSchema(options: {
  maxIntegerDigits: number;
  maxFractionDigits: number;
  positive?: boolean;
  message?: string;
}) {
  const pattern = decimalPattern(options.maxIntegerDigits, options.maxFractionDigits);
  const positive = options.positive ?? false;
  const message =
    options.message ??
    `Expected a ${positive ? 'positive' : 'non-negative'} decimal string with at most ${options.maxFractionDigits} fraction digits`;
  return z
    .string()
    .refine((value) => pattern.test(value) && (!positive || /[1-9]/.test(value)), message);
}

// Hard rule 1: money is never a float. Fits DECIMAL(18,2): at most 16 integer digits and 2
// fraction digits. Extra fraction digits are rejected, never rounded. No sign, exponent,
// separators or leading zeros.
export const PRICE_PATTERN = decimalPattern(16, 2);

/**
 * The organization's debt [P]: a difference in USD under half a cent is settled. USD is kept at six
 * decimals, so so'm amounts converted one by one can still end up a few millionths apart; and half a
 * cent is the point where a two-decimal display would show $0.00 anyway. Used by the allocation, the
 * balance, the customer's amount, the fake backends and, as a copy a test compares, the migration
 * `20261114090000_usd_organization_debt`.
 */
export const USD_SETTLED_UNDER = '0.005';

export const MONEY_STRING_MESSAGE =
  'Price must be a positive decimal string with at most 2 fraction digits';

/**
 * A positive price as a decimal STRING (JSON numbers are floats and are rejected), at most 2
 * fraction digits. Responses use the same shape (always 2 fraction digits).
 */
export const moneyStringSchema = decimalStringSchema({
  maxIntegerDigits: 16,
  maxFractionDigits: 2,
  positive: true,
  message: MONEY_STRING_MESSAGE,
});
export type MoneyString = z.infer<typeof moneyStringSchema>;

/**
 * How many WHOLE pieces of a product a customer may still order [C, 2026-11-09]: the stock that is
 * free after the holds of approved orders. A count of pieces, so a JSON integer.
 * - a number above zero: shown ("45 in stock") and the most that can be ordered;
 * - 0: the product is tracked and nothing is free (the sheet says zero, or approved orders hold
 *   everything). It is OUT OF STOCK: shown as such and it cannot be ordered at all;
 * - null: NO figure and NO cap. The stock is unknown (no stock aggregate) or not tracked (a
 *   staff-added product): the customer sees nothing and may order any quantity.
 * Indicative, never a reservation (hard rule 10).
 */
export const orderableStockSchema = z.int().nonnegative().nullable();

// Product code rule [C, 2026-10-20]: the product code is the sheet's product id («Товар_ID»), the
// company's ONE main key. It is stored AS ENTERED (trimmed) and displayed as entered, e.g.
// HONOR-X7C-6GB128GB-MidnightBlack. Uniqueness, lookup, search and the Sheet match IGNORE letter
// case: compare with productCodeKey(), never with ===.
//
// PROVISIONAL: the real id format is not confirmed (it may be numeric, or the HONOR-X7C-... style).
// The whole format lives in this ONE constant. The database repeats it in the CHECK
// products_product_code_format (SQL regex introduced in migration sku_as_entered_case_insensitive, renamed by rename_sku_to_product_code):
// change both together, with a new migration.
export const PRODUCT_CODE_RULE = {
  maxLength: 64,
  // Latin letters, digits and - . _ / ; the first character is a letter or digit.
  charset: 'A-Za-z0-9._/-',
  firstCharset: 'A-Za-z0-9',
} as const;
export const PRODUCT_CODE_MAX_LENGTH = PRODUCT_CODE_RULE.maxLength;
export const PRODUCT_CODE_PATTERN = new RegExp(
  `^[${PRODUCT_CODE_RULE.firstCharset}][${PRODUCT_CODE_RULE.charset}]{0,${PRODUCT_CODE_RULE.maxLength - 1}}$`,
);
export const PRODUCT_CODE_MESSAGE =
  'Product code must be 1-64 characters: Latin letters, digits and - . _ / , starting with a letter or digit';

/**
 * Trims plain spaces only (U+0020), exactly like the database `btrim`. Tabs, line breaks and
 * non-breaking spaces are NOT trimmed, so they stay in the value and are rejected by the pattern
 * instead of being silently accepted.
 */
export function normalizeProductCode(value: string): string {
  return value.replace(/^ +| +$/g, '');
}

/** The case-insensitive comparison key (equals the database column `products.product_code_key`). */
export function productCodeKey(value: string): string {
  return normalizeProductCode(value).toLowerCase();
}

/** Request boundary form of the rule: trim, then check characters and length. */
export const productCodeSchema = z
  .string()
  .transform(normalizeProductCode)
  .pipe(z.string().regex(PRODUCT_CODE_PATTERN, PRODUCT_CODE_MESSAGE));

/** ISO 8601 UTC instant, as produced by Date#toISOString. */
export const isoInstantSchema = z.iso.datetime();

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/**
 * Machine-readable codes the api returns (mapped in one place, `to-error-response.ts`).
 * - VALIDATION_FAILED: 422, `details` is a list of { path, message }
 * - UNAUTHENTICATED: 401   - FORBIDDEN: 403   - NOT_FOUND: 404   - CONFLICT: 409
 * - INTERNAL_ERROR: 500, never carries details
 * Framework-level errors (unknown route, malformed JSON) use the HTTP status name instead, and a
 * JSON body over the api limit is 413 PAYLOAD_TOO_LARGE, so the body schema keeps `code` a plain string and this list is for exhaustive client handling.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const validationIssueSchema = z.strictObject({
  path: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/**
 * Machine-readable reason of a 409 CONFLICT, so a client can react without parsing messages.
 * Present ONLY on CONFLICT bodies. `details` stays for payloads such as `productIds`.
 * Every value is raised by the services today; add a value only together with the code that
 * raises it.
 * - DRAFT_ALREADY_OPEN: creating a draft while another one is open (one open draft at most)
 * - DRAFT_NOT_OPEN: the draft was published meanwhile, so the draft the client addressed is gone
 *   (a DISCARDED draft no longer exists and answers 404 NOT_FOUND instead)
 * - VERSION_NOT_DRAFT: the version is archived (or otherwise never editable/publishable)
 * - INVALID_VERSION_TRANSITION: any other illegal version status change (defensive)
 * - EMPTY_DRAFT: publishing a draft without items
 * - NO_PUBLISHED_VERSION: `copyFromCurrent` while nothing is published
 * - ANOTHER_VERSION_PUBLISHED: lost a publish race at the database unique index
 * - INACTIVE_PRODUCT: pricing a product that is inactive (`details.productIds`)
 * - INACTIVE_PRODUCT_IN_DRAFT: publishing a draft that still contains inactive products
 *   (`details.productIds`)
 * - REMOVAL_REQUEST_NOT_PENDING: confirming/dismissing a supply removal request that was already
 *   decided (or auto-dismissed because the line reappeared)
 * - DUPLICATE_PRODUCT_CODE: a product with that product code (ignoring letter case) already exists
 * - ORDER_CHANGED: the order was changed by someone else between reading it and acting on it
 *   (a concurrent approval, edit or cancel won; `details.currentStatus`)
 * - ILLEGAL_ORDER_TRANSITION: the status change does not exist in the order lifecycle from the
 *   order's current status (`details.from`, `details.to`)
 * - ORDER_NOT_EDITABLE: items can be edited only while the order is SUBMITTED
 * - PAYMENT_PLAN_NOT_CHANGEABLE: the payment plan can be changed only while the order is SUBMITTED
 * - DEFERRED_PRICE_UNAVAILABLE: plan DEFERRED asked for, but a product has no deferred price
 *   (`details.productIds`)
 * - PAYMENT_PLAN_WINDOW_ENDED: the customer's time to change the plan after submitting is over
 * - CART_TOTAL_CHANGED: a price or rate moved after the cart was read; no order was created
 *   (`details.currentTotalAmount`)
 * - CURRENCY_CONVERSION_UNAVAILABLE: no USD rate is known, so an order's debt or an amount to pay
 *   cannot be worked out. Refused rather than guessed; the wording never names the rate
 * - EMPTY_CART: submitting a cart without items
 * - PRODUCT_NOT_ORDERABLE: a product is inactive, missing or not in the published price list
 *   (`details.productIds`)
 * - STOCK_LIMIT_EXCEEDED: a customer asked for more pieces than can be ordered now, when setting a
 *   cart quantity or submitting (`details.lines`: the product and its current `orderableStock`,
 *   see `stockLimitExceededDetailsSchema`). Nothing was changed
 * - IDEMPOTENCY_KEY_REUSED: the key was already used by another person of the organization
 * - ORDERING_ORGANIZATION_INACTIVE: the organization is INACTIVE and cannot place orders
 * - CONTACT_REQUIRED: submitting an order before the customer has entered their name and phone
 * - LAST_ADMIN: the action would leave the system without an ACTIVE administrator (also listed in
 *   MEMBERSHIP_CONFLICT_REASONS; the staff screens show it)
 * - TELEGRAM_ID_REQUIRED: a person with no Telegram id must keep a staff role (also listed in
 *   MEMBERSHIP_CONFLICT_REASONS)
 * - ORGANIZATION_NOT_LINKED: a staff-created organization has no Telegram chat yet, so staff cannot
 *   activate it (its invite does); also in MEMBERSHIP_CONFLICT_REASONS
 * - ORGANIZATION_ALREADY_LINKED: a new invite link or a type change was asked for an organization
 *   that already has its chat; also in MEMBERSHIP_CONFLICT_REASONS
 * - PERSON_ORGANIZATION: a PERSON organization keeps its bound person as the only shop owner, so
 *   its member roles cannot change; also in MEMBERSHIP_CONFLICT_REASONS
 * - ORGANIZATION_ARCHIVED: the organization is archived; nothing on it changes until an admin
 *   restores it; also in MEMBERSHIP_CONFLICT_REASONS
 * - BOT_NOT_CONFIGURED: a bot connect link was asked for but the api has no working bot
 * - UNIT_CODE_DUPLICATE: the scanned IMEI / marking (any order) or serial (same product) is already
 *   recorded on a live unit (`details.kind`, `details.orderNumber` of the holder)
 * - UNIT_CODE_NOT_REQUIRED: the product's rule does not ask for that code kind or slot
 * - UNIT_CODES_NOT_EDITABLE: codes are scanned only between the manager's approval and the release
 * - GOODS_RETURN_NOT_PENDING: the order has no goods waiting to be returned
 * - UNIT_CODES_INCOMPLETE: release refused, required codes are missing (`details.items`)
 * - ALLOCATION_CHANGED: the supply lines moved since the plan was read (`details.preview` is the
 *   fresh plan; the manager confirms it with one click)
 * - SUPPLY_PARTY_CONFLICT: a chosen supply has another party, or this party is on other supplies;
 *   the manager answers and sends again (`details.supplyConflicts`, `details.partyMembers`)
 * - SUPPLY_PARTY_CHANGED: another manager changed it since the screen loaded (`details.parties`,
 *   `details.partyMembers`)
 * - SUPPLY_NOT_AVAILABLE: a chosen supply has no live delivery line left (`details.deliveryRefs`)
 * - STOCK_INSUFFICIENT: the delivery lines cannot cover the order (`details.preview` shows how much
 *   is short); the manager lowers the quantity, rejects or syncs
 * - ALLOCATION_NOT_CHANGEABLE: holds are chosen only from SUBMITTED until the release
 * - DUPLICATE_CATEGORY_NAME: a product category with that name (ignoring case) already exists
 * - CATEGORY_ARCHIVED: an archived category cannot be linked to a product
 * - PAYMENT_VOIDED: a voided organization payment cannot be corrected or voided again
 * - PRICE_LIST_CHANGED: publishing changes against a `baseVersionNumber` that is no longer the
 *   published version (someone published meanwhile; `details.currentVersionNumber`)
 * - EMPTY_PRICE_LIST: publishing changes that would leave the price list without any product
 * - SHEET_SYNC_QUEUE_UNAVAILABLE: "sync now" was asked for, but the worker jobs (and so the sheet
 *   sync queue) are switched off on this api
 * - DUPLICATE_BRAND_NAME: a brand with that name (ignoring case) already exists
 * - PRODUCT_IMAGE_DUPLICATE: the same photo file is already on the product (`details.imageId`)
 * - PRIMARY_IMAGE_EXISTS: a photo was uploaded as primary while the product already has one; the
 *   primary is switched only by its own explicit request, never silently
 * - RESERVED_PRODUCT_CODE_PREFIX: a product code starting with `IO-` was entered by hand; that
 *   prefix is for system-generated codes only [C, 2026-11-09]
 * - NOT_GENERATED_CODE: merging asked for a source product that is a sheet product (only a
 *   generated-code product can be merged into a sheet product)
 * - TARGET_IS_GENERATED: merging asked for a target that is itself a generated-code product
 * - PRODUCT_ALREADY_MERGED: the product was merged into another one; it cannot be merged again,
 *   re-priced or reactivated (`details.mergedIntoProductId`)
 * - STAFF_ORDERING_DISABLED: a staff member using the customer app tried to place an order where
 *   no test organization is configured for staff orders (always the case in production)
 */
export const CONFLICT_REASONS = [
  'DRAFT_ALREADY_OPEN',
  'DRAFT_NOT_OPEN',
  'VERSION_NOT_DRAFT',
  'INVALID_VERSION_TRANSITION',
  'EMPTY_DRAFT',
  'NO_PUBLISHED_VERSION',
  'ANOTHER_VERSION_PUBLISHED',
  'INACTIVE_PRODUCT',
  'INACTIVE_PRODUCT_IN_DRAFT',
  'DUPLICATE_PRODUCT_CODE',
  'REMOVAL_REQUEST_NOT_PENDING',
  'ORDER_CHANGED',
  'ILLEGAL_ORDER_TRANSITION',
  'ORDER_NOT_EDITABLE',
  'PAYMENT_METHOD_NOT_CHANGEABLE',
  'PAYMENT_PLAN_NOT_CHANGEABLE',
  'DEFERRED_PRICE_UNAVAILABLE',
  'PAYMENT_PLAN_WINDOW_ENDED',
  'CART_TOTAL_CHANGED',
  'CURRENCY_CONVERSION_UNAVAILABLE',
  'EMPTY_CART',
  'PRODUCT_NOT_ORDERABLE',
  'STOCK_LIMIT_EXCEEDED',
  'IDEMPOTENCY_KEY_REUSED',
  'ORDERING_ORGANIZATION_INACTIVE',
  'CONTACT_REQUIRED',
  'LAST_ADMIN',
  'TELEGRAM_ID_REQUIRED',
  'ORGANIZATION_NOT_LINKED',
  'ORGANIZATION_ALREADY_LINKED',
  'PERSON_ORGANIZATION',
  'ORGANIZATION_ARCHIVED',
  'BOT_NOT_CONFIGURED',
  'UNIT_CODE_DUPLICATE',
  'UNIT_CODE_NOT_REQUIRED',
  'UNIT_CODES_NOT_EDITABLE',
  'GOODS_RETURN_NOT_PENDING',
  'UNIT_CODES_INCOMPLETE',
  'ALLOCATION_CHANGED',
  'STOCK_INSUFFICIENT',
  'SUPPLY_PARTY_CONFLICT',
  'SUPPLY_PARTY_CHANGED',
  'SUPPLY_NOT_AVAILABLE',
  'ALLOCATION_NOT_CHANGEABLE',
  'DUPLICATE_CATEGORY_NAME',
  'CATEGORY_ARCHIVED',
  'PAYMENT_VOIDED',
  'PRICE_LIST_CHANGED',
  'EMPTY_PRICE_LIST',
  'SHEET_SYNC_QUEUE_UNAVAILABLE',
  'DUPLICATE_BRAND_NAME',
  'PRODUCT_IMAGE_DUPLICATE',
  'PRIMARY_IMAGE_EXISTS',
  'RESERVED_PRODUCT_CODE_PREFIX',
  'NOT_GENERATED_CODE',
  'TARGET_IS_GENERATED',
  'PRODUCT_ALREADY_MERGED',
  'STAFF_ORDERING_DISABLED',
] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];
export const conflictReasonSchema = z.enum(CONFLICT_REASONS);

export const errorBodySchema = z.strictObject({
  error: z
    .strictObject({
      code: z.string(),
      message: z.string(),
      reason: conflictReasonSchema.optional(),
      details: z.unknown().optional(),
    })
    .refine((error) => error.reason === undefined || error.code === 'CONFLICT', {
      message: 'reason is only allowed on CONFLICT errors',
      path: ['reason'],
    }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
