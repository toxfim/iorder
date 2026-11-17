import {
  STAFF_DASHBOARD_ROUTES,
  staffDashboardSummarySchema,
  type StaffDashboardSummary,
} from '@iorder/shared/staff-orders';
import type { HttpClient } from '@core/lib/http-client';

/**
 * `GET /staff/dashboard/summary`. The api leaves a section out (the key is absent) when the
 * caller's role may not see it, so the screen renders only what is present and never asks the
 * role again. The response is parsed with the strict shared schema: a stray key (for example a
 * money field for the warehouse) is an invalid response, not something to show.
 */
export interface DashboardSummaryApi {
  getSummary: () => Promise<StaffDashboardSummary>;
}

export function createHttpDashboardSummaryApi(http: HttpClient): DashboardSummaryApi {
  return {
    getSummary: () => http.request(STAFF_DASHBOARD_ROUTES.summary, staffDashboardSummarySchema),
  };
}
