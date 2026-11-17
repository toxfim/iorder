import {
  businessInstant,
  businessParts,
  shiftBusinessDays,
  systemClock,
  type Clock,
} from '@core/lib/business-clock';
import type { DashboardApi, SalesBucket, SalesPeriod, SalesStats } from './dashboard-api';

// Figures from docs/private/design/v1 (Dashboard v5, sales). Millions of so'm per day / per week.
const DAILY_MILLIONS = ['86.4', '112.3', '74.1', '128.6', '96.2', '40.8', '100.6'];
const WEEKLY_MILLIONS = ['512.4', '478.9', '590.2', '639.0'];

/** `86.4` mln -> `86400000.00` without a float. */
function millionsToSom(millions: string): string {
  const [whole = '0', fraction = ''] = millions.split('.');
  const tenths = (fraction + '0').slice(0, 1);
  return `${whole}${tenths}00000.00`;
}

export function createFakeDashboardApi(
  options: { clock?: Clock; latencyMs?: number } = {},
): DashboardApi {
  const clock = options.clock ?? systemClock;
  const latencyMs = options.latencyMs ?? 0;

  const dayEnd = (daysBack: number): string => {
    const day = businessParts(shiftBusinessDays(clock.now(), daysBack));
    return businessInstant(day, 12, 0).toISOString();
  };

  return {
    async getSalesStats(period: SalesPeriod): Promise<SalesStats> {
      if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      if (period === 7) {
        const buckets: SalesBucket[] = DAILY_MILLIONS.map((millions, index) => {
          const day = dayEnd(DAILY_MILLIONS.length - 1 - index);
          return { from: day, to: day, total: millionsToSom(millions) };
        });
        return { period, buckets, orderCount: 23, previousTotal: millionsToSom('590.2') };
      }
      const buckets: SalesBucket[] = WEEKLY_MILLIONS.map((millions, index) => {
        const weeksBack = WEEKLY_MILLIONS.length - 1 - index;
        return {
          from: dayEnd(weeksBack * 7 + 6),
          to: dayEnd(weeksBack * 7),
          total: millionsToSom(millions),
        };
      });
      return { period, buckets, orderCount: 81, previousTotal: millionsToSom('2050.0') };
    },
  };
}
