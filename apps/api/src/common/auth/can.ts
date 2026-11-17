import type { Actor, ResourceContext } from './actor.js';
import {
  actorHoldsRole,
  CONDITIONS,
  PERMISSION_MATRIX,
  type ContextFreeAction,
  type PermissionAction,
} from './permission-matrix.js';

/**
 * Resource-level check for ONE already-loaded resource. Services call it after loading the
 * resource and pass the facts the matrix needs. Pure: no I/O, no clock. Allowed if ANY of
 * the actor's roles has a grant whose conditions all hold; otherwise denied.
 *
 * Two rules for callers:
 * - It is not a list filter. Hard rule 6 for list endpoints is enforced by the query itself:
 *   use `scopeFor` and apply the result in the WHERE clause. Never fetch rows and filter
 *   them with `can`.
 * - When the resource belongs to another organization (or the actor may not see it), answer
 *   404, not 403, so its existence does not leak. Use 403 only when the actor may see the
 *   resource but is not allowed to perform the action.
 *
 * The context is required for every action whose grants have conditions (compile-time);
 * only the context-free actions may omit it.
 */
export function can(actor: Actor, action: ContextFreeAction, context?: ResourceContext): boolean;
export function can(actor: Actor, action: PermissionAction, context: ResourceContext): boolean;
export function can(
  actor: Actor,
  action: PermissionAction,
  context: ResourceContext = {},
): boolean {
  if (!withinScopes(actor, action)) return false;
  return PERMISSION_MATRIX[action].some(
    (grant) =>
      actorHoldsRole(actor, grant) &&
      grant.when.every((condition) => CONDITIONS[condition](actor, context)),
  );
}

/**
 * NOT AN AUTHORIZATION CHECK. Only answers "does any role of this actor have a grant for
 * the action, ignoring every resource condition?". The route guard uses it to turn away
 * callers who could never succeed (for example, a driver calling an admin route). A seller
 * passes it for VIEW_ORDER on any organization; the service must still call `can` or apply
 * `scopeFor`.
 */
export function holdsAnyGrantFor(actor: Actor, action: PermissionAction): boolean {
  if (!withinScopes(actor, action)) return false;
  return PERMISSION_MATRIX[action].some((grant) => actorHoldsRole(actor, grant));
}

/**
 * An API token narrows what its person may do: an action outside `actor.scopes` is denied even
 * when the person's roles grant it. Without scopes (a person's own session) nothing is narrowed.
 */
export function withinScopes(actor: Actor, action: PermissionAction): boolean {
  return actor.scopes === undefined || actor.scopes.includes(action);
}
