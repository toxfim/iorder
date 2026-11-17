import type { OwnStaffProfileResponse } from '@iorder/shared/staff-auth';
import type { StaffDriver } from '@iorder/shared/staff-orders';
import type {
  MeResponse,
  StaffPersonCard,
  StaffUserResponse,
  StaffViewerInfo,
} from '@iorder/shared';
import type { Actor } from '../../../common/auth/actor.js';
import { can } from '../../../common/auth/can.js';
import type { UserWithMembership } from '../identity.service.js';
import type { UserView } from '../user.view.js';

/**
 * Explicit allow-list mappers. The phone number and the Telegram id appear in the staff
 * DTO; the customer-facing `/me` DTO has the caller's OWN phone only and no Telegram id. New columns never reach the API by accident.
 */
export function toStaffUserResponse(
  { user, membership }: UserWithMembership,
  actor: Actor,
): StaffUserResponse {
  return {
    id: user.id,
    // bigint -> decimal string: a JS number could lose precision.
    telegramUserId: can(actor, 'VIEW_TELEGRAM_IDS')
      ? (user.telegramUserId?.toString() ?? null)
      : null,
    fullName: user.fullName,
    phone: user.phone,
    language: user.language,
    status: user.status,
    staffRoles: user.staffRoles,
    membership: membership
      ? {
          organizationId: membership.organizationId,
          organizationName: membership.organizationName,
          role: membership.role,
          joinedAt: membership.joinedAt.toISOString(),
        }
      : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/** The hover card: name, phone, role and nothing else (no Telegram id, no timestamps). */
export function toStaffPersonCard(
  { user, membership }: UserWithMembership,
  actor: Actor,
): StaffPersonCard {
  return {
    id: user.id,
    fullName: user.fullName,
    phone: user.staffRoles.length === 0 || can(actor, 'VIEW_STAFF_PHONE') ? user.phone : null,
    status: user.status,
    staffRoles: user.staffRoles,
    membership: membership
      ? { organizationName: membership.organizationName, role: membership.role }
      : null,
  };
}

/** The caller's own summary: role and membership come from the authenticated actor. */
export function toMeResponse(
  actor: Actor,
  user: UserView,
  organizationName?: string,
  /** `GET /me` passes it (null: not a viewer); the staff sign-in answers leave the field out. */
  staffViewer?: StaffViewerInfo | null,
): MeResponse {
  // Staff never carry a membership, even if an actor was built with one by mistake. A staff
  // viewer of the customer app is staff too: no membership, no contact to enter.
  const isStaff = actor.staffRoles.length > 0 || actor.staffViewer !== undefined;
  const membership = isStaff ? undefined : actor.membership;
  // The caller's OWN contact only; staff never need one (they do not place orders).
  const contact =
    !isStaff && user.phone !== null ? { fullName: user.fullName, phone: user.phone } : null;
  return {
    userId: user.id,
    fullName: user.fullName,
    locale: user.language,
    staffRoles: [...actor.staffRoles],
    membership: membership
      ? {
          organizationId: membership.organizationId,
          role: membership.role,
          ...(organizationName === undefined ? {} : { organizationName }),
        }
      : null,
    contact,
    needsContact: !isStaff && user.phone === null,
    ...(staffViewer === undefined ? {} : { staffViewer }),
  };
}

/** The driver choice: id and display name only. No phone, no Telegram id, no status. */
export function toStaffDriverResponse(user: UserView): StaffDriver {
  return { id: user.id, fullName: user.fullName };
}

/** A staff member's own profile: the two fields they may change, nothing else of the row. */
export function toOwnStaffProfileResponse(user: UserView): OwnStaffProfileResponse {
  return { fullName: user.fullName, phone: user.phone };
}
