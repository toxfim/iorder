import { describe, expect, it } from 'vitest';
import { sortRows, type DataTableColumn } from '@/components/ui/data-table';
import { hasValidTotal, orderAgeMinutes } from './order-sort';
import { compareMoney } from '@core/lib/money';

interface Row {
  id: string;
  total: string | null;
}
const totalColumn: DataTableColumn<Row> = {
  key: 'total',
  label: 'Total',
  hasSortValue: (r) => hasValidTotal(r.total),
  compare: (a, b) => compareMoney(a.total ?? '0', b.total ?? '0'),
};
const rows: Row[] = [
  { id: 'bad', total: 'abc' },
  { id: 'ten', total: '10.00' },
  { id: 'neg', total: '-5.00' },
  { id: 'nine', total: '9.50' },
  { id: 'long', total: '1.234' },
  { id: 'none', total: null },
];
const ids = (direction: 'asc' | 'desc'): string[] =>
  sortRows(rows, [totalColumn], { key: 'total', direction }).map((r) => r.id);

describe('sorting money that may be malformed', () => {
  it('does not throw and puts invalid values last in both directions', () => {
    expect(ids('asc')).toEqual(['nine', 'ten', 'bad', 'neg', 'long', 'none']);
    expect(ids('desc')).toEqual(['ten', 'nine', 'bad', 'neg', 'long', 'none']);
  });

  it('survives a comparator that throws', () => {
    const throwing: DataTableColumn<Row> = {
      ...totalColumn,
      hasSortValue: () => true,
      compare: (a, b) => compareMoney(a.total ?? '0', b.total ?? '0'),
    };
    expect(() => sortRows(rows, [throwing], { key: 'total', direction: 'asc' })).not.toThrow();
  });
});

describe('orderAgeMinutes', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  it('counts whole minutes since submission', () => {
    expect(orderAgeMinutes('2026-10-22T09:15:30Z', now)).toBe(44);
  });
  it('is null for an invalid date', () => {
    expect(orderAgeMinutes('not a date', now)).toBeNull();
  });
  it('is null for a future submission (clock skew), not "under a minute"', () => {
    expect(orderAgeMinutes('2026-10-22T10:05:00Z', now)).toBeNull();
  });
});
