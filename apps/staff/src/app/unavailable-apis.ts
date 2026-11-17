import type { ActivityApi } from '@/features/activity/api/activity-api';
import type { DashboardApi } from '@/features/dashboard/api/dashboard-api';
import { ApiError } from '@core/lib/api-errors';

/**
 * A screen whose backend route does not exist yet. The pages treat it like any other failed read
 * (their error state), so nothing is invented and nothing pretends to have loaded.
 */
export class FeatureUnavailableError extends ApiError {
  constructor(feature: string) {
    super(`The backend has no route for "${feature}" yet`);
    this.name = 'FeatureUnavailableError';
  }
}

const unavailable = (feature: string) => (): Promise<never> =>
  Promise.reject(new FeatureUnavailableError(feature));

// The "recent actions" feed has no endpoint (the audit log is not exposed over HTTP).
export const unavailableActivityApi: ActivityApi = { listRecent: unavailable('activity') };

// The sales chart has no report endpoint; the chart is not drawn in a real build.
export const unavailableDashboardApi: DashboardApi = { getSalesStats: unavailable('sales-stats') };
