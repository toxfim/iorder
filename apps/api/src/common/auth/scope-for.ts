import type { OrderStatus } from '@iorder/shared';
import type { Actor, ResourceContext } from './actor.js';
import { withinScopes } from './can.js';
import {
  actorHoldsRole,
  effectiveMembership,
  isStatusCondition,
  PERMISSION_MATRIX,
  statusesFor,
  type ConditionName,
  type PermissionAction,
} from './permission-matrix.js';

/**
 * One alternative of a query scope. All present fields of ONE filter are ANDed; a filter with
 * no fields matches everything ("all"). An actor's scope is the OR of its filters.
 *
 * A repository MUST handle every field or throw: silently dropping a field widens access
 * (fail-open). Never merge `statuses` lists across filters, because each list only holds
 * together with the other fields of its own filter. `scopeFilterToPredicate` below is the
 * reference implementation and its field map breaks the build when a field is added unhandled.
 */
export interface ScopeFilter {
  organizationId?: string;
  placedByUserId?: string;
  assignedDriverId?: string;
  /** When true, only orders the manager approved at some point (manager_approved_at set). */
  managerApproved?: true;
  /** Allowed statuses; when several conditions limit status, only the intersection remains. */
  statuses?: readonly OrderStatus[];
}

function isKnownId(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** Returns null when the actor cannot satisfy the condition (the grant then yields nothing). */
function applyCondition(
  filter: ScopeFilter,
  condition: ConditionName,
  actor: Actor,
): ScopeFilter | null {
  if (isStatusCondition(condition)) {
    const allowed = statusesFor(condition);
    const statuses = filter.statuses ? filter.statuses.filter((s) => allowed.includes(s)) : allowed;
    return { ...filter, statuses };
  }
  switch (condition) {
    case 'SAME_ORGANIZATION': {
      const organizationId = effectiveMembership(actor)?.organizationId;
      return isKnownId(organizationId) ? { ...filter, organizationId } : null;
    }
    case 'MANAGER_WAS_APPROVED':
      return { ...filter, managerApproved: true };
    case 'PLACED_BY_ACTOR':
      return isKnownId(actor.userId) ? { ...filter, placedByUserId: actor.userId } : null;
    case 'ASSIGNED_TO_ACTOR':
      return isKnownId(actor.userId) ? { ...filter, assignedDriverId: actor.userId } : null;
    case 'STAFF_ORDERING_ORGANIZATION': {
      // Null where no organization is configured for staff orders: the grant yields nothing.
      const organizationId = actor.staffViewer?.orderingOrganizationId ?? undefined;
      return isKnownId(organizationId) ? { ...filter, organizationId } : null;
    }
  }
}

/**
 * The query-side twin of `can`, derived from the same matrix: the filters a list query must
 * apply so the actor only receives resources `can(actor, action, thatResource)` would allow.
 * An empty result means "nothing" (return an empty list); a filter without fields means "all".
 * Hard rule 6 for list endpoints is enforced with this, in the WHERE clause, never in the UI.
 */
export function scopeFor(actor: Actor, action: PermissionAction): readonly ScopeFilter[] {
  const filters: ScopeFilter[] = [];
  if (!withinScopes(actor, action)) return filters;
  for (const grant of PERMISSION_MATRIX[action]) {
    if (!actorHoldsRole(actor, grant)) continue;
    let filter: ScopeFilter | null = {};
    for (const condition of grant.when) {
      filter = applyCondition(filter, condition, actor);
      if (filter === null) break;
    }
    if (filter !== null && !(filter.statuses && filter.statuses.length === 0)) filters.push(filter);
  }
  return filters;
}

type FieldMatchers = {
  [K in keyof ScopeFilter]-?: (
    value: NonNullable<ScopeFilter[K]>,
    context: ResourceContext,
  ) => boolean;
};

// Adding a ScopeFilter field without a matcher here is a compile error, so a consumer built
// on this map cannot forget it.
const FIELD_MATCHERS: FieldMatchers = {
  organizationId: (value, context) => context.organizationId === value,
  placedByUserId: (value, context) => context.placedByUserId === value,
  assignedDriverId: (value, context) => context.assignedDriverId === value,
  // Strictly the literal true, like the matrix condition.
  managerApproved: (_value, context) => context.wasManagerApproved === true,
  statuses: (value, context) => context.status !== undefined && value.includes(context.status),
};

/** Reference evaluation of one filter against a loaded resource (used by tests; mirrors `can`). */
export function scopeFilterToPredicate(filter: ScopeFilter): (context: ResourceContext) => boolean {
  const keys = Object.keys(FIELD_MATCHERS) as (keyof ScopeFilter)[];
  return (context) =>
    keys.every((key) => {
      const value = filter[key];
      if (value === undefined) return true;
      return (FIELD_MATCHERS[key] as (v: unknown, c: ResourceContext) => boolean)(value, context);
    });
}
