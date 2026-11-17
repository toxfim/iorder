import type { Actor, ResourceContext } from '../../common/auth/actor.js';
import { effectiveMembership, isStaffViewer } from '../../common/auth/permission-matrix.js';
import { mayUseCustomerApp } from '../../common/auth/staff-viewer.js';
import type { OrderRecord } from './orders.repository.js';
import type { WorkflowRole } from './order-state-machine.js';

/** The roles an actor can act in: staff roles, or the customer membership role (staff are never members). */
export function workflowRolesOf(actor: Actor): WorkflowRole[] {
  if (actor.staffRoles.length > 0) return [...actor.staffRoles];
  const membership = effectiveMembership(actor);
  return membership ? [membership.role] : [];
}

/**
 * The role written on an order's SUBMITTED event. For a staff viewer (a test order on staging,
 * [C] 2026-11-09) it is a staff role the person really holds, so history names who placed it
 * (hard rule 12). Only here: `workflowRolesOf` gives a viewer no role, so no transition, edit or
 * decision can ever be made in that capacity.
 */
export function submitterRoleOf(actor: Actor): WorkflowRole | undefined {
  if (isStaffViewer(actor)) {
    return actor.staffViewer?.staffRoles.find((role) => mayUseCustomerApp([role]));
  }
  return workflowRolesOf(actor)[0];
}

/** Customers get no accounting internals in any order they read. */
export function isStaffActor(actor: Actor): boolean {
  return actor.staffRoles.length > 0;
}

/** The facts about an order that `can()` and `scopeFor()` reason about. */
export function resourceContextOf(order: OrderRecord): ResourceContext {
  return {
    organizationId: order.organizationId,
    placedByUserId: order.placedByUserId,
    status: order.status,
    assignedDriverId: order.driverUserId,
    wasManagerApproved: order.managerApprovedAt !== null,
  };
}
