import { businessParts, isSameBusinessDay, type Clock } from '@core/lib/business-clock';
import { formatDayMonth } from '@core/lib/format';
import { toCents } from '@core/lib/money';
import type { SalesBucket } from '../api/dashboard-api';

export interface ChartDot {
  /** Position in percent of the plot box (the SVG uses a 300x100 viewBox). */
  readonly xPercent: number;
  readonly yPercent: number;
  readonly isLast: boolean;
  readonly total: string;
  readonly label: string;
}

export interface SalesChart {
  /** `x,y x,y ...` in the 300x100 viewBox. */
  readonly line: string;
  /** The line closed down to the baseline, for the soft area fill. */
  readonly area: string;
  readonly dots: readonly ChartDot[];
}

const WIDTH = 300;
const HEIGHT = 100;

/**
 * Geometry of the v1 sales chart. Amounts are decimal strings; they are turned into numbers ONLY
 * here, to place points on the screen (a display ratio, never stored or summed as money): the
 * line is scaled between 85% of the smallest value and the largest, with 6 units of padding at the
 * bottom and 6 at the top, exactly like the design.
 */
export function buildSalesChart(
  buckets: readonly Pick<SalesBucket, 'total'>[],
  labelOf: (index: number) => string,
): SalesChart {
  // Geometry only: Number() may round a huge amount, which moves a dot by less than a pixel but
  // never reaches a displayed or summed amount (`total` below stays the exact decimal string).
  const values = buckets.map((bucket) => Number(toCents(bucket.total)));
  if (values.length === 0) return { line: '', area: '', dots: [] };
  const max = Math.max(...values);
  const min = Math.min(...values) * 0.85;
  const span = max - min || 1;
  const count = values.length;

  const points = values.map((value, index): [number, number] => [
    count === 1 ? WIDTH / 2 : (index / (count - 1)) * WIDTH,
    HEIGHT - ((value - min) / span) * 88 - 6,
  ]);
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  return {
    line,
    area: `${line} ${WIDTH},${HEIGHT} 0,${HEIGHT}`,
    dots: points.map(([x, y], index) => ({
      xPercent: x / 3,
      yPercent: y,
      isLast: index === count - 1,
      total: buckets[index]?.total ?? '0.00',
      label: labelOf(index),
    })),
  };
}

/**
 * Axis label of a bucket: `13.10` for a day (or "today" for the current day), `22–28.09` for a week
 * inside one month and `29.09–05.10` across two months.
 */
export function bucketLabel(
  bucket: Pick<SalesBucket, 'from' | 'to'>,
  clock: Clock,
  todayLabel: string,
): string {
  if (isSameBusinessDay(bucket.from, bucket.to)) {
    return isSameBusinessDay(bucket.to, clock.now()) ? todayLabel : formatDayMonth(bucket.to);
  }
  const from = businessParts(bucket.from);
  const to = businessParts(bucket.to);
  const start = formatDayMonth(bucket.from);
  const end = formatDayMonth(bucket.to);
  return from.month === to.month ? `${start.slice(0, 2)}–${end}` : `${start}–${end}`;
}
