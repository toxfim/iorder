import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { effectiveMembership, isStaffViewer } from '../../common/auth/permission-matrix.js';
import { ACTOR_REQUEST_KEY } from '../../common/auth/route-access.js';
import { ForbiddenError } from '../../common/errors/domain-errors.js';

// Several matrix actions (VIEW_ORDER) are held by customers AND staff, and the two
// areas answer differently (customer allow-lists vs staff views). These guards keep each area
// for its audience; they run after the global PermissionGuard, which has resolved the actor.

function actorOf(context: ExecutionContext): Actor {
  const request = context.switchToHttp().getRequest<Record<string, unknown>>();
  const actor = request[ACTOR_REQUEST_KEY] as Actor | undefined;
  // Reaching here without the global guard is a programming error; never fabricate an actor.
  if (!actor) throw new ForbiddenError('Access denied');
  return actor;
}

/**
 * Customer routes: a member of an organization, or a staff member as the staff viewer
 * ([C] 2026-11-09; the global guard has already replaced a staff actor with it on these routes).
 * An actor that still carries staff roles never passes: staff use the /staff routes.
 */
@Injectable()
export class CustomerAudienceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const actor = actorOf(context);
    if (effectiveMembership(actor) === undefined && !isStaffViewer(actor)) {
      throw new ForbiddenError('Access denied');
    }
    return true;
  }
}

/** Staff routes: someone who holds a staff role. */
@Injectable()
export class StaffAudienceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (actorOf(context).staffRoles.length === 0) throw new ForbiddenError('Access denied');
    return true;
  }
}
