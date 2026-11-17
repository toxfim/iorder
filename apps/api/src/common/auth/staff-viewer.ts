import type { StaffRole } from '@iorder/shared';
import type { Actor } from './actor.js';
import { PERMISSION_MATRIX } from './permission-matrix.js';

/**
 * Which staff members may use the customer app as viewers ([C] 2026-11-09). [P] Those whose staff
 * roles already let them browse the price list: the customer app shows selling prices, and the
 * warehouse and the driver never see a price anywhere (lifecycle 4.1 and 5). Read from the matrix,
 * so the two can never disagree.
 */
export function mayUseCustomerApp(staffRoles: readonly StaffRole[]): boolean {
  return PERMISSION_MATRIX.BROWSE_PRICE_LIST.some(
    (grant) => grant.kind === 'staff' && staffRoles.includes(grant.role),
  );
}

/**
 * The actor a staff member is in the customer app: NO staff roles (so no staff grant applies to
 * anything it touches) and no membership, only the viewer block. A staff member who may not use
 * the customer app comes out with nothing at all, which the matrix denies everywhere.
 *
 * The session id and the API token scopes are kept: a viewer can still sign out, and a token stays
 * as narrow as it was.
 */
export function toStaffViewerActor(
  person: { userId: string; staffRoles: readonly StaffRole[] },
  orderingOrganizationId: string | null,
  carried: Pick<Actor, 'sessionId' | 'scopes'> = {},
): Actor {
  return {
    userId: person.userId,
    staffRoles: [],
    ...(carried.sessionId === undefined ? {} : { sessionId: carried.sessionId }),
    ...(carried.scopes === undefined ? {} : { scopes: carried.scopes }),
    ...(mayUseCustomerApp(person.staffRoles)
      ? { staffViewer: { staffRoles: [...person.staffRoles], orderingOrganizationId } }
      : {}),
  };
}

/** The setting behind staff orders, as the viewer block wants it: an id or null, never ''. */
export function staffOrderingOrganizationOf(env: {
  STAFF_ORDERING_ORGANIZATION_ID?: string | undefined;
}): string | null {
  const id = env.STAFF_ORDERING_ORGANIZATION_ID;
  return id === undefined || id === '' ? null : id;
}
