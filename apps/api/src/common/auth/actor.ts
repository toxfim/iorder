import type { OrderStatus, OrganizationRole, StaffRole } from '@iorder/shared';
import type { PermissionAction } from './permission-matrix.js';

export interface OrganizationMembership {
  organizationId: string;
  role: OrganizationRole;
}

/**
 * A staff member using the CUSTOMER app ([C] 2026-11-09). Such an actor has EMPTY `staffRoles`,
 * so no staff grant applies to it, and no membership: it holds only the few `staffViewer` grants
 * of the matrix (prices, a personal cart and, where configured, test orders).
 */
export interface StaffViewer {
  /** The roles the person really holds. For history only (who placed an order); never a grant. */
  staffRoles: readonly StaffRole[];
  /**
   * The one organization staff orders are written to (STAFF_ORDERING_ORGANIZATION_ID, staging
   * only). Null, as in production, means the viewer can neither place nor see any order.
   */
  orderingOrganizationId: string | null;
}

/**
 * Who is calling. Built by the (future) authentication layer from verified Telegram data;
 * the permission code only trusts what is in here. One person may hold several staff roles
 * (data-model open question 4, assumption) and permissions are the union of all of them.
 * Staff are never organization members: `membership` is ignored when any staff role is held.
 */
export interface Actor {
  userId: string;
  staffRoles: readonly StaffRole[];
  membership?: OrganizationMembership;
  /** Set only by `toStaffViewerActor`; never together with `staffRoles` or a membership. */
  staffViewer?: StaffViewer;
  /** Set only when the request carried a website session (Bearer token); logout needs it. */
  sessionId?: string;
  /**
   * Set only for an API token (`Authorization: Bearer iot_...`): the token may perform ONLY these
   * actions, and each of them still needs a grant from the person's current roles. Absent means
   * "no extra limit" (a person signed in themselves).
   */
  scopes?: readonly PermissionAction[];
}

/**
 * Facts about the resource, loaded by the service before it calls `can`. A missing fact
 * never grants anything: every condition that needs a fact fails when it is absent.
 */
export interface ResourceContext {
  organizationId?: string;
  placedByUserId?: string;
  status?: OrderStatus;
  assignedDriverId?: string | null;
  /**
   * True when the manager approved the order at some point, i.e. manager_approved_at is set, also
   * on an order rejected or cancelled later. The orders service derives it; only the literal
   * `true` counts.
   */
  wasManagerApproved?: boolean;
}
