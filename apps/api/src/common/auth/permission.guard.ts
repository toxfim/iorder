import {
  Inject,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, UnauthenticatedError } from '../errors/domain-errors.js';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { Actor } from './actor.js';
import { ActorResolver } from './actor-resolver.js';
import { holdsAnyGrantFor } from './can.js';
import { ACTOR_REQUEST_KEY, isCustomerAreaRoute, readRoutePolicy } from './route-access.js';
import { staffOrderingOrganizationOf, toStaffViewerActor } from './staff-viewer.js';

/**
 * Registered globally (APP_GUARD) so a forgotten decorator can never leave a route open:
 * every route must declare `@RequirePermission(...)` or `@Public()`, otherwise it is denied.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    // Optional so that a missing resolver is a clean 401, not a boot-time DI crash that
    // someone might "fix" by registering a fake one.
    @Optional() @Inject(ActorResolver) private readonly resolver: ActorResolver | null,
    // Optional for hand-built guards in unit tests: without it no organization takes staff orders.
    @Optional()
    @Inject(APP_ENV)
    private readonly env: Pick<Env, 'STAFF_ORDERING_ORGANIZATION_ID'> | null = null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = readRoutePolicy(this.reflector, context.getHandler(), context.getClass());
    if (policy === null) throw new ForbiddenError('Access denied');
    if (policy.kind === 'PUBLIC') return true;

    // A resolver that throws propagates as an unexpected error (500, no details): never allowed.
    const resolved = this.resolver ? await this.resolver.resolve(context) : null;
    if (!resolved) throw new UnauthenticatedError('Authentication required');
    const actor = this.inCustomerArea(context, resolved);

    if (!holdsAnyGrantFor(actor, policy.action)) throw new ForbiddenError('Access denied');

    // Stored so the controller can pass the same actor to services without resolving twice.
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    request[ACTOR_REQUEST_KEY] = actor;
    return true;
  }

  /**
   * On a customer-area route a staff member is the staff viewer, never the staff actor: the
   * replacement happens here, before the permission check and before any handler, so the Mini App
   * (whose init data is the same in both apps) cannot carry staff grants into customer routes.
   */
  private inCustomerArea(context: ExecutionContext, actor: Actor): Actor {
    if (actor.staffRoles.length === 0) return actor;
    if (!isCustomerAreaRoute(this.reflector, context.getHandler(), context.getClass())) {
      return actor;
    }
    return toStaffViewerActor(actor, staffOrderingOrganizationOf(this.env ?? {}), actor);
  }
}
