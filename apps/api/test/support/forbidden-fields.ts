/**
 * Name fragments that must never appear in this phase's API responses NOR in its database
 * schema (hard rule 7: cost data is staff-only and, per the data model, stored in a separate
 * staff-only area, not in catalog/price tables). Matched case-insensitively, ignoring "_" and
 * "-", as a SUBSTRING of every key or schema name, at any depth.
 *
 * EXTEND THIS LIST when a new sensitive concept appears. A hit means "stop and think", not
 * "add an exception".
 */
export const FORBIDDEN_KEY_PARTS: readonly string[] = [
  'cost',
  'cogs',
  'purchase',
  'buyprice',
  'landed',
  'tannarx',
  'rate',
  'exchange',
  'kurs',
  'usd',
  'margin',
  'markup',
  'profit',
  'supplier',
  'vendor',
  'wholesale',
  // [C, owner 2026-11-12] the «Alif factoring» price tier: like "wholesale", a customer response
  // never names it (the price list carries the caller's tier only), so any key with it is a hit.
  'alif',
  'internal',
];

/**
 * The ONE stock figure a customer may see (owner decision 2026-11-09): how many whole pieces can be
 * ordered now. It is listed among the staff-only names below ON PURPOSE, so it is a hit everywhere
 * except the three places that are allowed to carry it, each through its own helper:
 * an item of the customer price list (`findStaffOnlyFieldsInCustomerPriceList`), a line of the cart
 * and a line of the STOCK_LIMIT_EXCEEDED refusal (`findStaffOnlyFieldsInCustomerCart`). In an order,
 * an order list or any other customer answer it is still a leak.
 */
export const CUSTOMER_STOCK_FIELD = 'orderableStock';

/**
 * Field names that are STAFF-ONLY data even though they are not cost-like words: they come from the
 * delivery lines of the sheet (who we bought from, how, in which category) or are the stock
 * aggregate (the raw sheet number and the held quantities stay staff-only; customers get only
 * CUSTOMER_STOCK_FIELD, see above). They may appear in the staff-cost entry and in the
 * price_reference table, and NOWHERE else: every customer-facing schema, response and Prisma file
 * is scanned for them by exact name (case-insensitive).
 * EXTEND THIS LIST when a new staff-only field appears.
 */
export const STAFF_ONLY_FIELD_NAMES: readonly string[] = [
  'supplier',
  // The staff supplier filter's per-product list (2026-11-13).
  'suppliers',
  'purchaseMethod',
  'purchase_method',
  'category',
  'stockQuantity',
  // Stock under any plausible name. NOT 'quantity': orders use it.
  'stock',
  'inStock',
  'available',
  'stockCache',
  'availableQuantity',
  CUSTOMER_STOCK_FIELD,
  'deliveredQuantity',
  'deliveryRef',
  // How an order line splits over supplies: staff order responses only.
  'supplyRef',
  'partyNumber',
];

export function isStaffOnlyFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  return STAFF_ONLY_FIELD_NAMES.some((staffOnly) => staffOnly.toLowerCase() === lower);
}

/**
 * JSON-key check used by the response scans: the exact staff-only names PLUS any key that merely
 * contains `categor`, so a renamed leak such as `categoryName` or `supplierCategory` cannot slip
 * past the exact-name list. The one allowed place (`items[n].category` of the customer price
 * list) is removed before scanning, see `findStaffOnlyFieldsInCustomerPriceList`.
 */
export function isStaffOnlyJsonKey(name: string): boolean {
  return isStaffOnlyFieldName(name) || name.toLowerCase().includes('categor');
}

/** Paths of staff-only field names in a JSON-like value, at any depth. */
export function findStaffOnlyFields(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findStaffOnlyFields(item, `${path}[${index}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(isStaffOnlyJsonKey(key) ? [`${path}.${key}`] : []),
    ...findStaffOnlyFields(child, `${path}.${key}`),
  ]);
}

/**
 * Staff-only names in a CUSTOMER PRICE LIST response (`GET /price-list/current`). The owner
 * decided on 2026-10-23 that customers browse the price list by category, and on 2026-11-09 that
 * they see how many pieces can be ordered, so `category` and `orderableStock` are allowed as
 * exactly one field each: directly on `items[n]`. They stay a hit anywhere else in this response
 * (top level, `version`, nested), and every other staff-only name stays a hit everywhere. Use this
 * ONLY for that one endpoint; all other customer JSON uses `findStaffOnlyFields`, where both are
 * still forbidden.
 */
export function findStaffOnlyFieldsInCustomerPriceList(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return findStaffOnlyFields(body);
  }
  return findStaffOnlyFields(
    Object.fromEntries(
      Object.entries(body).map(([key, child]) => [
        key,
        key === 'items' && Array.isArray(child) ? child.map(withoutItemCategory) : child,
      ]),
    ),
  );
}

function withoutItemCategory(item: unknown): unknown {
  return withoutKeys(item, ['category', CUSTOMER_STOCK_FIELD]);
}

function withoutKeys(item: unknown, names: readonly string[]): unknown {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).filter(([key]) => !names.includes(key)));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const withoutLineStock = (lines: unknown): unknown =>
  Array.isArray(lines) ? lines.map((line) => withoutKeys(line, [CUSTOMER_STOCK_FIELD])) : lines;

/**
 * Staff-only names in a customer answer of the ORDER routes (cart, orders, their refusals). The
 * stock figure is allowed in exactly two places: directly on a cart line (`lines[n]` at the top
 * level, which only the cart has) and directly on a line of a refusal's details
 * (`error.details.lines[n]`). An order, an order item or anything nested deeper still reports it.
 */
export function findStaffOnlyFieldsInCustomerCart(body: unknown): string[] {
  if (!isRecord(body)) return findStaffOnlyFields(body);
  const error = body.error;
  const details = isRecord(error) ? error.details : undefined;
  return findStaffOnlyFields({
    ...body,
    ...('lines' in body ? { lines: withoutLineStock(body.lines) } : {}),
    ...(isRecord(error) && isRecord(details)
      ? { error: { ...error, details: { ...details, lines: withoutLineStock(details.lines) } } }
      : {}),
  });
}

/**
 * Staff-only names in the CUSTOMER HOME recommendations (`GET /me/recommendations`). The cards
 * are the price list items again (owner decisions 2026-10-23 and 2026-11-09), so the stock figure
 * is allowed directly on a card of `reorder[n]`, `matching[n]` and on `newerModel`; the category is
 * NOT sent on the home (the "why" line names a product instead) and stays a hit everywhere.
 */
export function findStaffOnlyFieldsInCustomerHome(body: unknown): string[] {
  if (!isRecord(body)) return findStaffOnlyFields(body);
  return findStaffOnlyFields({
    ...body,
    ...('reorder' in body ? { reorder: withoutLineStock(body.reorder) } : {}),
    ...('matching' in body ? { matching: withoutLineStock(body.matching) } : {}),
    ...('newerModel' in body
      ? { newerModel: withoutKeys(body.newerModel, [CUSTOMER_STOCK_FIELD]) }
      : {}),
  });
}

// Names that legitimately contain a forbidden fragment by accident (for example "separate").
// Keep this empty unless a real collision appears, and explain each entry.
// - codeGenerated / code_generated [C, 2026-11-09]: "gene-rate-d" contains "rate" by spelling only.
//   It is a boolean flag (the product's code was made by the system), not an exchange rate.
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['codeGenerated', 'code_generated']);

/**
 * [C, owner 2026-11-11] «Оптовик/Партнер» is a SELLING price tier (organizations labelled wholesale
 * or partner pay these prices), NOT a purchase price. These exact names may carry the fragment
 * "wholesale", and ONLY where a test allows them explicitly: the staff price list and its
 * requests, the staff import, the two Prisma files that declare them. They are NOT in ALLOWED_KEYS,
 * so a customer response with any of them still fails every leak scan; the customer price list
 * carries ONE price resolved to the caller's tier (test/organization-tiers.int-spec.ts proves it by
 * value too).
 */
export const STAFF_PRICE_TIER_NAMES: readonly string[] = [
  'WHOLESALE',
  'WHOLESALE_PARTNER',
  'wholesalePrice',
  'wholesale_price',
  'wholesaleDeferredPrice',
  'wholesale_deferred_price',
  'currentWholesalePrice',
  'currentWholesaleDeferredPrice',
  'wholesaleGiven',
  // The «Alif factoring» tier [C, owner 2026-11-12], allowed exactly like the wholesale names.
  'ALIF_FACTORING',
  'alifPrice',
  'alif_price',
  'alifDeferredPrice',
  'alif_deferred_price',
  'currentAlifPrice',
  'currentAlifDeferredPrice',
  'alifGiven',
];

/** Staff responses only: drops the price tier keys before a cost-word scan (like the USD keys). */
export function stripStaffPriceTier(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripStaffPriceTier);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !STAFF_PRICE_TIER_NAMES.includes(key))
      .map(([key, child]) => [key, stripStaffPriceTier(child)]),
  );
}

const normalize = (name: string): string => name.toLowerCase().replace(/[_-]/g, '');

/**
 * STAFF version DTOs carry exactly one cost-class object: the USD rate snapshot, under this key.
 * Tests of staff responses strip it (and only it) before scanning for cost-like keys, so any OTHER
 * cost key in a staff response still fails. Customer responses are never stripped.
 */
export const STAFF_RATE_SNAPSHOT_KEY = 'usdRateSnapshot';

export function stripStaffRateSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripStaffRateSnapshot);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== STAFF_RATE_SNAPSHOT_KEY)
      .map(([key, child]) => [key, stripStaffRateSnapshot(child)]),
  );
}

/**
 * The staff FULL order detail, its history and the `orders` table carry the frozen USD facts of an
 * order (owner rule: the debt is USD), under exactly these keys. Tests of those places strip them
 * (and only them), so any other cost key still fails. Customer responses are never stripped.
 */
export const STAFF_ORDER_USD_KEYS: readonly string[] = [
  'usdRate',
  'totalUsd',
  'fullUnitPriceUsd',
  'deferredUnitPriceUsd',
];

export function stripStaffOrderUsd(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripStaffOrderUsd);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !STAFF_ORDER_USD_KEYS.includes(key))
      .map(([key, child]) => [key, stripStaffOrderUsd(child)]),
  );
}

export function isForbiddenName(name: string): boolean {
  if (ALLOWED_KEYS.has(name)) return false;
  const normalized = normalize(name);
  return FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part));
}

/** Paths of forbidden keys in a JSON-like value, at any depth. */
export function findForbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(isForbiddenName(key) ? [`${path}.${key}`] : []),
    ...findForbiddenKeys(child, `${path}.${key}`),
  ]);
}

/**
 * Names declared in Prisma schema text: model/enum names, field names, enum values and the
 * database names given in @map/@@map. Comments are ignored on purpose (they may explain what
 * is NOT stored).
 */
export function extractSchemaNames(schema: string): string[] {
  const names: string[] = [];
  const blocks = schema.matchAll(/^(?:model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm);
  for (const block of blocks) {
    names.push(block[1] ?? '');
    for (const rawLine of (block[2] ?? '').split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (line === '') continue;
      for (const mapped of line.matchAll(/@@?map\("([^"]+)"\)/g)) names.push(mapped[1] ?? '');
      if (line.startsWith('@@')) continue;
      names.push(line.split(/\s+/)[0] ?? '');
    }
  }
  return names.filter((name) => name !== '');
}

/**
 * True when `secret` appears in `text` as a value of its own, not inside a longer run of letters
 * and digits. A plain substring check is flaky for numeric secrets: the random part of a UUIDv7
 * id (`…1bab30120008`) contains `12000` now and then. A decimal point or a quote still ends the
 * run, so `12000.00` and `"12000"` are found.
 */
export function containsStandalone(text: string, secret: string): boolean {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![0-9A-Za-z])${escaped}(?![0-9A-Za-z])`).test(text);
}
