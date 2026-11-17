// Browsing the customer price list by category. The labels are the raw strings of the sheet (no
// translations exist), shown as they are. Products without a category form one last group whose
// name is an i18n text. Nothing here computes prices.

/** Selection value for "all categories". */
export const SELECT_ALL = '';
/**
 * Selection value for "products without a category". A real category whose name starts with "~"
 * gets one more "~" in front (see `selectionOf`), so no real name can ever equal this value.
 */
export const SELECT_OTHER = '~other';

export interface CategorizedItem {
  readonly category: string | null;
}

export interface CategoryGroup<T extends CategorizedItem> {
  /** The category label, or null for the "other" group. */
  readonly category: string | null;
  readonly items: readonly T[];
}

/** The selection value that stands for a group. */
export function selectionOf(category: string | null): string {
  if (category === null) return SELECT_OTHER;
  // Escape: a real category literally named "~other" becomes "~~other" and stays distinct.
  return category.startsWith('~') ? `~${category}` : category;
}

const collators = new Map<string, Intl.Collator>();
function collatorFor(locale: string): Intl.Collator {
  let collator = collators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    collators.set(locale, collator);
  }
  return collator;
}

/**
 * How far to scroll (negative = up) so that the top of the list is not hidden behind the sticky
 * tools bar after a shorter list replaced a longer one. 0 when the list top is already visible.
 */
export function scrollDeltaToListTop(listTop: number, toolsBottom: number): number {
  return listTop < toolsBottom ? listTop - toolsBottom : 0;
}

/**
 * Alphabetical groups (locale-aware, numeric-aware), the "other" group last. Item order inside a
 * group is the input order.
 */
export function groupByCategory<T extends CategorizedItem>(
  items: readonly T[],
  locale: string,
): CategoryGroup<T>[] {
  const byCategory = new Map<string | null, T[]>();
  for (const item of items) {
    const list = byCategory.get(item.category);
    if (list) list.push(item);
    else byCategory.set(item.category, [item]);
  }
  const collator = collatorFor(locale);
  return [...byCategory]
    .sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return collator.compare(a, b) || (a < b ? -1 : 1);
    })
    .map(([category, list]) => ({ category, items: list }));
}

/**
 * Out-of-stock products (a figure of exactly 0) go after the others, in their existing order
 * otherwise: they stay visible but do not stand between the customer and what can be ordered. A
 * product without a figure (null) is not out of stock and keeps its place.
 */
export function outOfStockLast<T extends { readonly orderableStock: number | null }>(
  items: readonly T[],
): T[] {
  const gone = (item: T): number => (item.orderableStock === 0 ? 1 : 0);
  return [...items].sort((a, b) => gone(a) - gone(b));
}

/** Every group the whole list has, whatever the search says, so the chips do not jump around. */
export function knownSelections(groups: readonly { readonly category: string | null }[]): string[] {
  return groups.map((group) => selectionOf(group.category));
}

/**
 * A selection from an untrusted source (URL, storage) is used only when the list really has that
 * category; anything else is "all".
 */
export function resolveSelection(raw: unknown, known: readonly string[]): string {
  return typeof raw === 'string' && raw !== SELECT_ALL && known.includes(raw) ? raw : SELECT_ALL;
}

export function filterBySelection<T extends CategorizedItem>(
  items: readonly T[],
  selection: string,
): T[] {
  if (selection === SELECT_ALL) return [...items];
  return items.filter((item) => selectionOf(item.category) === selection);
}

/** Tab ids are positions, not category names: names hold spaces and would break aria-labelledby. */
export const chipTabKey = (index: number): string => `t${index}`;

const STORAGE_KEY = 'iorder.customer.catalog.category';

/** The category remembered for this session; storage can be blocked (private mode, previews). */
export function readStoredSelection(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredSelection(selection: string): void {
  try {
    if (selection === SELECT_ALL) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, selection);
  } catch {
    // Remembering the category is a convenience; the URL still carries it.
  }
}
