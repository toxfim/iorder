// Category tabs shared by the price list and the stock page. The tab id is a string key so a
// category called "all" or "none" cannot collide with the two built-in tabs.

export const CATEGORY_ALL = 'all';
export const CATEGORY_NONE = 'none';
const PREFIX = 'c:';

export const categoryTabId = (category: string): string => `${PREFIX}${category}`;

/** Does a product's category pass the selected tab? */
export function matchesCategory(category: string | null, selected: string): boolean {
  if (selected === CATEGORY_ALL) return true;
  if (selected === CATEGORY_NONE) return category === null;
  return category !== null && categoryTabId(category) === selected;
}

export function filterByCategory<T extends { readonly category: string | null }>(
  items: readonly T[],
  selected: string,
): T[] {
  return items.filter((item) => matchesCategory(item.category, selected));
}

export interface CategoryCounts {
  readonly total: number;
  readonly uncategorized: number;
  readonly categories: readonly { readonly category: string; readonly count: number }[];
}

/** Code unit order, not locale order: the same on every device (and as the api sorts them). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function countCategories(
  items: readonly { readonly category: string | null }[],
): CategoryCounts {
  const counts = new Map<string, number>();
  let uncategorized = 0;
  for (const { category } of items) {
    if (category === null) uncategorized += 1;
    else counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return {
    total: items.length,
    uncategorized,
    categories: [...counts]
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([category, count]) => ({ category, count })),
  };
}

/** Counts from an endpoint answer (`categories` + `uncategorizedCount`) over `total` items. */
export function countsFromResponse(response: {
  readonly categories: readonly { readonly category: string; readonly count: number }[];
  readonly uncategorizedCount: number;
}): CategoryCounts {
  return {
    total: response.categories.reduce((sum, c) => sum + c.count, 0) + response.uncategorizedCount,
    uncategorized: response.uncategorizedCount,
    categories: response.categories,
  };
}

export interface CategoryTabLabels {
  readonly all: string;
  readonly none: string;
}

export interface CategoryOption {
  /** The same ids as the tabs used: `CATEGORY_NONE` or `categoryTabId(name)`. */
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

/**
 * The searchable category dropdown (v8): every known category with its count in the list that is
 * open, the ones with products first and the empty ones after them (drawn dimmed), each group in
 * code unit order with "no category" last. `alsoKnown` / `alsoUncategorized` keep categories the
 * list does not hold right now (the other list tab, a filter), so a choice never vanishes from
 * the menu just because it matches nothing at the moment. "All" is not an option here: the
 * dropdown adds it itself.
 */
export function buildCategoryOptions(
  counts: CategoryCounts,
  labels: CategoryTabLabels,
  alsoKnown: readonly string[] = [],
  alsoUncategorized = false,
): CategoryOption[] {
  const shown = new Map(counts.categories.map((c) => [c.category, c.count]));
  for (const name of alsoKnown) if (!shown.has(name)) shown.set(name, 0);
  const options: CategoryOption[] = [...shown]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([name, count]) => ({ id: categoryTabId(name), label: name, count }));
  if (counts.uncategorized > 0 || alsoUncategorized) {
    options.push({ id: CATEGORY_NONE, label: labels.none, count: counts.uncategorized });
  }
  // A stable partition: the order inside each group stays as built above.
  return [...options.filter((o) => o.count > 0), ...options.filter((o) => o.count === 0)];
}

/** Case-insensitive "contains" over the label; an empty query keeps everything. */
export function searchCategoryOptions(
  options: readonly CategoryOption[],
  query: string,
): CategoryOption[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [...options];
  return options.filter((option) => option.label.toLocaleLowerCase().includes(needle));
}
