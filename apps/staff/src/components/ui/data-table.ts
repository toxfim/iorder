export interface DataTableColumn<Row> {
  readonly key: string;
  /** Already translated header text. */
  readonly label: string;
  /** Extra explanation, shown as the header tooltip. */
  readonly hint?: string;
  /** Numbers and money: right aligned, tabular figures. */
  readonly align?: 'start' | 'end';
  /** Plain text of the cell: the default content, the tooltip of a truncated cell, the card line. */
  readonly text?: (row: Row) => string;
  /** Click-to-sort on the rows that are already loaded. Absent: the column is not sortable. */
  readonly compare?: (a: Row, b: Row) => number;
  /**
   * False when this row has nothing to compare in this column (empty, malformed, not applicable).
   * Such rows sort last in BOTH directions. Absent: every row has a value.
   */
  readonly hasSortValue?: (row: Row) => boolean;
  /** Cut long text with an ellipsis and show the full text as a tooltip. */
  readonly truncate?: boolean;
  /** CSS width (`12ch`, `140px`); omitted columns share the rest. */
  readonly width?: string;
  /** CSS minimum width of the column; the table then scrolls sideways instead of squeezing it. */
  readonly minWidth?: string;
  /** Not drawn at all. Pages set it from the shape of the DTO the server sent, never from a role. */
  readonly hidden?: boolean;
  /** The header text is read by screen readers only (an action column without a visible title). */
  readonly srOnlyLabel?: boolean;
  /** Not repeated on the phone card (the page's `card` slot decides what the card shows). */
  readonly hideOnCard?: boolean;
  /**
   * Already translated name of the column group: neighbouring columns with the same group share
   * one header cell above their own (Narxlar's STANDART / ULGURJI-HAMKOR prices).
   */
  readonly group?: string;
}

export interface ColumnGroupCell {
  readonly key: string;
  /** Empty for the columns outside any group. */
  readonly label: string;
  readonly span: number;
}

/** The group header row: one cell per run of neighbouring columns with the same group. */
export function columnGroups<Row>(columns: readonly DataTableColumn<Row>[]): ColumnGroupCell[] {
  const cells: ColumnGroupCell[] = [];
  for (const column of columns) {
    const label = column.group ?? '';
    const last = cells[cells.length - 1];
    if (last && last.label === label) {
      cells[cells.length - 1] = { ...last, span: last.span + 1 };
    } else {
      cells.push({ key: column.key, label, span: 1 });
    }
  }
  return cells;
}

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  readonly key: string;
  readonly direction: SortDirection;
}

/** Stable sort: equal rows keep the order they arrived in (the page's own default order). */
export function sortRows<Row>(
  rows: readonly Row[],
  columns: readonly DataTableColumn<Row>[],
  sort: SortState | null,
): Row[] {
  const column = sort ? columns.find((c) => c.key === sort.key) : undefined;
  const compare = column?.compare;
  if (!sort || !compare) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  const has = column?.hasSortValue ?? (() => true);
  // A comparator that throws on odd data must not take the whole list down: treat it as a tie.
  const safeCompare = (a: Row, b: Row): number => {
    try {
      return compare(a, b);
    } catch {
      return 0;
    }
  };
  return rows
    .map((row, index) => ({ row, index, has: has(row) }))
    .sort((a, b) => {
      if (a.has !== b.has) return a.has ? -1 : 1;
      if (!a.has) return a.index - b.index;
      return sign * safeCompare(a.row, b.row) || a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** Header click cycle: ascending, then descending, then the page's default order. */
export function nextSort(current: SortState | null, key: string): SortState | null {
  if (current?.key !== key) return { key, direction: 'asc' };
  return current.direction === 'asc' ? { key, direction: 'desc' } : null;
}
