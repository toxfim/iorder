import { ForbiddenError } from '../errors/domain-errors.js';
import type { Actor } from './actor.js';

/**
 * Only an administrator may act on an administrator account (rename, block, credentials,
 * Telegram link, roles). One rule for every path that touches a staff user, so a new path cannot
 * forget it. The answer is the same generic 403 as other refusals: it must not tell a manager
 * which reason applied.
 */
export function assertMayTouchStaffTarget(
  actor: Actor,
  target: { staffRoles: readonly string[] },
): void {
  if (target.staffRoles.includes('ADMIN') && !actor.staffRoles.includes('ADMIN')) {
    throw new ForbiddenError('Access denied');
  }
}
