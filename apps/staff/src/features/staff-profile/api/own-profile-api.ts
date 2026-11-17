import {
  STAFF_PROFILE_ROUTES,
  ownStaffProfileResponseSchema,
  type OwnStaffProfileResponse,
  type UpdateOwnStaffProfileRequest,
} from '@iorder/shared/staff-auth';
import type { HttpClient } from '@core/lib/http-client';

// The profile page (features/profile) reads these types from here: the staff-only contract entry
// is imported in features/staff*/ only.
export type OwnProfile = OwnStaffProfileResponse;
export type OwnProfileUpdate = UpdateOwnStaffProfileRequest;

/**
 * The signed-in staff member's own name and phone ([C] 2026-11-09). Neither call names a person:
 * the server always acts on the caller.
 */
export interface OwnProfileApi {
  get: () => Promise<OwnProfile>;
  /** Replaces both fields; a null phone removes the number. */
  update: (request: OwnProfileUpdate) => Promise<OwnProfile>;
}

export function createHttpOwnProfileApi(http: HttpClient): OwnProfileApi {
  return {
    get: () => http.request(STAFF_PROFILE_ROUTES.getOwnProfile, ownStaffProfileResponseSchema),
    update: (request) =>
      http.request(STAFF_PROFILE_ROUTES.updateOwnProfile, ownStaffProfileResponseSchema, {
        body: request,
      }),
  };
}
