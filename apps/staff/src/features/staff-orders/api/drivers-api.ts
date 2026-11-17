import { STAFF_DRIVER_ROUTES, staffDriverListResponseSchema } from '@iorder/shared/staff-orders';
import type { HttpClient } from '@core/lib/http-client';

export interface DriverOption {
  readonly id: string;
  readonly fullName: string;
}

/**
 * The people the warehouse can hand an order to: `GET /staff/drivers` (LIST_DRIVERS, held by the
 * warehouse manager, manager and admin). The identity directory stays closed to the warehouse;
 * this endpoint answers id and name only.
 */
export interface DriversApi {
  /** Active users who hold the driver role. A caller without the permission gets PermissionDeniedError. */
  listActiveDrivers: () => Promise<readonly DriverOption[]>;
}

export function createHttpDriversApi(http: HttpClient): DriversApi {
  return {
    async listActiveDrivers() {
      const result = await http.request(
        STAFF_DRIVER_ROUTES.listDrivers,
        staffDriverListResponseSchema,
      );
      return result.items.map((driver) => ({ id: driver.id, fullName: driver.fullName }));
    },
  };
}
