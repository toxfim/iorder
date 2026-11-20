// Client-side pages of a list the page already holds in full (Qoldiq reads every page of the
// staff answer, see `allPages`): the design's 10 / 25 / 50 / 100 per page and numbered pages.

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

export const isPageSize = (value: number): value is PageSize =>
  (PAGE_SIZES as readonly number[]).includes(value);

export interface PageSlice {
  /** Zero-based page actually shown (a page past the end falls back to the last one). */
  readonly page: number;
  readonly pages: number;
  /** Zero-based index of the first row shown, and one past the last. */
  readonly start: number;
  readonly end: number;
}

export function pageSlice(total: number, page: number, size: number): PageSlice {
  const pages = Math.max(1, Math.ceil(total / size));
  const shown = Math.min(Math.max(0, page), pages - 1);
  const start = shown * size;
  return { page: shown, pages, start, end: Math.min(total, start + size) };
}

/** A page button, or a gap ("…") between two runs of them. */
export type PageWindowItem =
  { readonly kind: 'page'; readonly page: number } | { readonly kind: 'gap'; readonly key: string };

/**
 * First, last, the current page and its neighbours; a gap of one page is shown as that page
 * (never "1 … 3"), a longer one as "…".
 */
export function pageWindow(page: number, pages: number): PageWindowItem[] {
  const wanted = [...new Set([0, page - 1, page, page + 1, pages - 1])]
    .filter((p) => p >= 0 && p < pages)
    .sort((a, b) => a - b);
  const items: PageWindowItem[] = [];
  let previous: number | null = null;
  for (const p of wanted) {
    if (previous !== null && p - previous === 2) items.push({ kind: 'page', page: previous + 1 });
    else if (previous !== null && p - previous > 2) items.push({ kind: 'gap', key: `gap-${p}` });
    items.push({ kind: 'page', page: p });
    previous = p;
  }
  return items;
}
