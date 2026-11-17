import type { StaffRole } from '@iorder/shared';
import type { CurrentUser } from './api/auth-api';

// UI-level access checks that decide which screens to show or hide. They are a convenience for
// the person using the app; the server enforces the same rules on every endpoint.

/** No `required` list means "any staff role". */
export function hasStaffAccess(user: CurrentUser, required?: readonly StaffRole[]): boolean {
  if (user.staffRoles.length === 0) return false;
  if (!required || required.length === 0) return true;
  return user.staffRoles.some((role) => required.includes(role));
}
