import type {
  StaffAccountResponse,
  StaffCredentialsResponse,
  StaffCurrentSessionResponse,
  StaffDirectoryEntry,
  StaffSessionInfo,
  StaffSignInResponse,
} from '@iorder/shared/staff-auth';
import type { Actor } from '../../../common/auth/actor.js';
import type { CredentialsView, SignInOutcome } from '../staff-auth.service.js';
import type { StaffAccountView } from '../staff-accounts.service.js';
import type { SessionTimes } from '../staff-session.service.js';
import type { UserView } from '../user.view.js';
import { toMeResponse } from './user.response.js';

/**
 * Explicit allow-list mappers, like every other DTO. The password hash never reaches this layer
 * (CredentialsView has no such field) and the token appears only in the sign-in answer.
 */
export function toSessionInfo(times: SessionTimes): StaffSessionInfo {
  return {
    expiresAt: times.expiresAt.toISOString(),
    idleExpiresAt: times.idleExpiresAt.toISOString(),
  };
}

export function toSignInResponse(outcome: SignInOutcome): StaffSignInResponse {
  // A session belongs to a person with staff roles, so the summary has no membership.
  const actor: Actor = { userId: outcome.user.id, staffRoles: outcome.user.staffRoles };
  return {
    token: outcome.token,
    session: toSessionInfo(outcome.session),
    me: toMeResponse(actor, outcome.user),
  };
}

export function toCurrentSessionResponse(
  actor: Actor,
  user: UserView,
  times: SessionTimes | null,
): StaffCurrentSessionResponse {
  return {
    session: times ? toSessionInfo(times) : null,
    me: toMeResponse(actor, user),
  };
}

/** Allow-list: no hash, no Telegram id (only whether one is linked), no phone. */
export function toStaffAccountResponse(view: StaffAccountView): StaffAccountResponse {
  return {
    id: view.user.id,
    fullName: view.user.fullName,
    login: view.login,
    roles: view.user.staffRoles,
    status: view.user.status,
    hasPassword: view.hasPassword,
    telegramLinked: view.user.telegramUserId !== null,
    lastSignInAt: view.lastSignInAt ? view.lastSignInAt.toISOString() : null,
    createdAt: view.user.createdAt.toISOString(),
  };
}

/** Field by field: no login, no password fact, no Telegram id. */
export function toStaffDirectoryEntry(user: UserView): StaffDirectoryEntry {
  return {
    id: user.id,
    fullName: user.fullName,
    roles: user.staffRoles,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toCredentialsResponse(view: CredentialsView): StaffCredentialsResponse {
  return {
    userId: view.userId,
    login: view.login,
    passwordChangedAt: view.passwordChangedAt.toISOString(),
  };
}
