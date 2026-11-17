// UI-ONLY contract for the home page's sales statistics ("Savdo statistikasi"). The real numbers
// will come from a backend report; amounts are decimal strings (so'm).

export type SalesPeriod = 7 | 30;

export interface SalesBucket {
  /** First and last day of the bucket, ISO instants (a day for 7 kun, a week for 30 kun). */
  readonly from: string;
  readonly to: string;
  readonly total: string;
}

export interface SalesStats {
  readonly period: SalesPeriod;
  readonly buckets: readonly SalesBucket[];
  readonly orderCount: number;
  /** Total of the previous period of the same length, for the change badge. */
  readonly previousTotal: string;
}

export interface DashboardApi {
  getSalesStats: (period: SalesPeriod) => Promise<SalesStats>;
}
