import type { PaymentPlan } from '@iorder/shared';
import type {
  CreateStaffOrderRequest,
  NewOrderCatalogItem,
  NewOrderCustomer,
  NewOrderCustomerMember,
} from '@iorder/shared/staff-orders';
import { ApiConflictError } from '@core/lib/api-errors';
import { multiplyMoney, sumMoney } from '@core/lib/money';

// The manager's new order [C, owner 2026-11-20]: display and request helpers only. The server
// prices the order, checks the member against the organization and decides everything else.

export type NewOrderStep = 'items' | 'details' | 'confirm';

/** One cart line: a product of the catalog and a whole number of pieces (at least 1). */
export interface NewOrderLine {
  readonly productId: string;
  readonly quantity: number;
}

export type Catalog = ReadonlyMap<string, NewOrderCatalogItem>;

/** The most pieces one line may hold (the api's ceiling). */
export const MAX_LINE_QUANTITY = 999_999;

/** The price a line costs under the plan; before a plan is chosen the sale price is shown. */
export function unitPriceOf(item: NewOrderCatalogItem, plan: PaymentPlan | null): string | null {
  return plan === 'DEFERRED' ? item.deferredUnitPrice : item.unitPrice;
}

export function lineTotalOf(
  item: NewOrderCatalogItem,
  quantity: number,
  plan: PaymentPlan | null,
): string | null {
  const price = unitPriceOf(item, plan);
  return price === null ? null : multiplyMoney(price, quantity);
}

/** The lines whose product is in the catalog, in cart order. */
export function pricedLines(
  lines: readonly NewOrderLine[],
  catalog: Catalog,
): { line: NewOrderLine; item: NewOrderCatalogItem }[] {
  return lines.flatMap((line) => {
    const item = catalog.get(line.productId);
    return item ? [{ line, item }] : [];
  });
}

/** The total under the plan (the sale prices before one is chosen); exact, never a float. */
export function totalOf(
  lines: readonly NewOrderLine[],
  catalog: Catalog,
  plan: PaymentPlan | null,
): string {
  return sumMoney(
    pricedLines(lines, catalog).map(
      ({ line, item }) => lineTotalOf(item, line.quantity, plan) ?? '0.00',
    ),
  );
}

export const pieceCount = (lines: readonly NewOrderLine[]): number =>
  lines.reduce((sum, line) => sum + line.quantity, 0);

/** DEFERRED needs a deferred price on every line (the server refuses it otherwise). */
export function deferredPossible(lines: readonly NewOrderLine[], catalog: Catalog): boolean {
  return pricedLines(lines, catalog).every(({ item }) => item.deferredUnitPrice !== null);
}

/**
 * The «Omborda atigi N dona» warning [P]: the free stock when the line asks for more, else null.
 * Only a warning: the manager may go on (the server does not cap the manager's order).
 */
export function stockWarning(item: NewOrderCatalogItem, quantity: number): number | null {
  return item.stock !== null && quantity > item.stock ? item.stock : null;
}

/** Sets a line's quantity; 0 removes it, a new product is appended. */
export function withQuantity(
  lines: readonly NewOrderLine[],
  productId: string,
  quantity: number,
): NewOrderLine[] {
  const bounded = Math.min(Math.max(0, Math.trunc(quantity)), MAX_LINE_QUANTITY);
  const exists = lines.some((line) => line.productId === productId);
  if (bounded === 0) return lines.filter((line) => line.productId !== productId);
  if (!exists) return [...lines, { productId, quantity: bounded }];
  return lines.map((line) =>
    line.productId === productId ? { productId, quantity: bounded } : line,
  );
}

export interface CatalogFilter {
  readonly text: string;
  readonly category: string | null;
  readonly brand: string | null;
}

/** Step 2's search (code or name, any letter case), category and brand. */
export function filterCatalog(
  items: readonly NewOrderCatalogItem[],
  filter: CatalogFilter,
): NewOrderCatalogItem[] {
  const needle = filter.text.trim().toLowerCase();
  return items.filter(
    (item) =>
      (filter.category === null || item.category === filter.category) &&
      (filter.brand === null || item.brand === filter.brand) &&
      (needle === '' ||
        item.name.toLowerCase().includes(needle) ||
        item.productCode.toLowerCase().includes(needle)),
  );
}

/** The distinct non-empty values of a field, sorted, for the filter lists. */
export function distinctOf(
  items: readonly NewOrderCatalogItem[],
  field: 'category' | 'brand',
): string[] {
  const values = new Set<string>();
  for (const item of items) {
    const value = item[field];
    if (value) values.add(value);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** The member an order of this customer is placed by without a choice: a PERSON's only member. */
export function implicitMember(customer: NewOrderCustomer): NewOrderCustomerMember | null {
  return customer.type === 'PERSON' && customer.members.length === 1
    ? (customer.members[0] ?? null)
    : null;
}

export function createRequestOf(input: {
  customer: NewOrderCustomer;
  member: NewOrderCustomerMember;
  lines: readonly NewOrderLine[];
  catalog: Catalog;
  plan: PaymentPlan;
  comment: string;
}): CreateStaffOrderRequest {
  const lines = pricedLines(input.lines, input.catalog);
  const comment = input.comment.trim();
  return {
    organizationId: input.customer.organizationId,
    placedByUserId: input.member.userId,
    paymentPlan: input.plan,
    lines: lines.map(({ line }) => ({
      productId: line.productId,
      quantity: String(line.quantity),
    })),
    ...(comment === '' ? {} : { comment }),
    expectedTotalAmount: totalOf(
      lines.map(({ line }) => line),
      input.catalog,
      input.plan,
    ),
  };
}

/** A new Idempotency-Key for one order (getRandomValues works outside secure contexts too). */
export function newOrderKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `order-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Step 2 shows what is in stock (the design: «Omborda yo'q tovarlar ko'rinmaydi»): a product with
 * a free stock of exactly 0 is left out [P]; untracked ("By order") and unknown stock (null) stay.
 * Display only: the server does not refuse it (the manager's order is not capped).
 */
export function offeredInStep2(items: readonly NewOrderCatalogItem[]): NewOrderCatalogItem[] {
  return items.filter((item) => item.stock !== 0);
}

export type RefusalAction = 'CHOOSE_CUSTOMER' | 'RELOAD_CATALOG' | 'STAY';

const CUSTOMER_REFUSALS: readonly string[] = [
  'PLACER_NOT_MEMBER',
  'ORDERING_ORGANIZATION_INACTIVE',
];
const CATALOG_REFUSALS: readonly string[] = [
  'CART_TOTAL_CHANGED',
  'PRODUCT_NOT_ORDERABLE',
  'DEFERRED_PRICE_UNAVAILABLE',
  'NO_PUBLISHED_VERSION',
];

/**
 * What the wizard does after a refused create: the customer is no longer possible (back to step 1
 * with the message), the prices or the offer moved (read the catalog again), or anything else
 * (stay on step 4 with the message; a retry of the unchanged order keeps its key).
 */
export function afterRefusal(error: unknown): RefusalAction {
  if (!(error instanceof ApiConflictError) || error.reason === undefined) return 'STAY';
  if (CUSTOMER_REFUSALS.includes(error.reason)) return 'CHOOSE_CUSTOMER';
  if (CATALOG_REFUSALS.includes(error.reason)) return 'RELOAD_CATALOG';
  return 'STAY';
}
