import {
  applyDecorators,
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { UnauthenticatedError } from '../errors/domain-errors.js';
import type { Actor } from './actor.js';
import type { PermissionAction } from './permission-matrix.js';

export const REQUIRED_ACTION_KEY = 'iorder:required-action';
export const PUBLIC_ROUTE_KEY = 'iorder:public-route';
export const CUSTOMER_AREA_KEY = 'iorder:customer-area';
export const ACTOR_REQUEST_KEY = 'iorderActor';

type MetadataTarget = Parameters<Reflector['get']>[1];

/**
 * Declares the action a route needs. Enforced by the global `PermissionGuard`. Route-level
 * only: resource-level checks stay in services via `can(...)`. On a method it overrides a
 * class-level declaration.
 */
export function RequirePermission(action: PermissionAction): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(REQUIRED_ACTION_KEY, action));
}

/**
 * Explicit opt-out from authentication and permission checks (health probe, Telegram
 * webhook once it verifies its own signature). Every route needs either this or
 * `RequirePermission`; a route with neither is denied.
 */
export function Public(): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(PUBLIC_ROUTE_KEY, true));
}

/**
 * Marks routes of the CUSTOMER app (cart, orders, own balance, own goods, the customer price
 * list). On them a staff member is never a staff actor: the global guard replaces the actor with
 * the staff viewer BEFORE the permission check ([C] 2026-11-09), so nothing behind such a route
 * can use a staff grant, by construction. On a class it covers every method.
 */
export function CustomerArea(): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(CUSTOMER_AREA_KEY, true));
}

/** True when the handler or its controller is marked `@CustomerArea()`. */
export function isCustomerAreaRoute(
  reflector: Reflector,
  handler: MetadataTarget,
  controller: MetadataTarget,
): boolean {
  return [handler, controller].some(
    (target) => reflector.get<boolean | undefined>(CUSTOMER_AREA_KEY, target) === true,
  );
}

/** The actor the guard authenticated. Only valid on routes guarded by `RequirePermission`. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const actor = request[ACTOR_REQUEST_KEY];
    // Reaching here without the guard is a programming error; never fabricate an actor.
    if (!actor) throw new UnauthenticatedError('Authentication required');
    return actor as Actor;
  },
);

export type RoutePolicy = { kind: 'PUBLIC' } | { kind: 'ACTION'; action: PermissionAction };

/**
 * Reads the access declaration of a route. The method wins over the class, so a class can
 * require one action and a single method can override it or opt out. Returns null when
 * nothing is declared. If one target declares both, the action wins (more restrictive).
 */
export function readRoutePolicy(
  reflector: Reflector,
  handler: MetadataTarget,
  controller: MetadataTarget,
): RoutePolicy | null {
  for (const target of [handler, controller]) {
    const action = reflector.get<PermissionAction | undefined>(REQUIRED_ACTION_KEY, target);
    if (action !== undefined) return { kind: 'ACTION', action };
    if (reflector.get<boolean | undefined>(PUBLIC_ROUTE_KEY, target) === true) {
      return { kind: 'PUBLIC' };
    }
  }
  return null;
}
