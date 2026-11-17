import type {
  OrganizationInviteStatus,
  OrganizationLabel,
  OrganizationType,
  StaffOrganizationSummary,
} from '@iorder/shared';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  InvalidResponseError,
  NetworkError,
  PermissionDeniedError,
  RequestTimeoutError,
} from '@core/lib/api-errors';

/** `UNLINKED`: a staff-created organization whose invite was not used yet (no chat bound). */
export type OrganizationStatusFilter = 'all' | 'ACTIVE' | 'INACTIVE' | 'UNLINKED';
export type OrganizationTypeFilter = 'all' | OrganizationType;
export type OrganizationLabelFilter = 'all' | OrganizationLabel;

type Linkable = Pick<StaffOrganizationSummary, 'status' | 'invite'> &
  Partial<Pick<StaffOrganizationSummary, 'archivedAt'>>;

/**
 * Archived ("deleted" by the admin) [C, owner 2026-11-13]: read-only until restored (payments
 * stay open [P]).
 */
export function isArchived(org: Pick<StaffOrganizationSummary, 'archivedAt'>): boolean {
  return org.archivedAt !== null;
}

/**
 * Bound to its Telegram chat. The invite status says it for every role (the chat id itself is
 * null for a role that may not know Telegram ids).
 */
export function isLinked(org: Pick<StaffOrganizationSummary, 'invite'>): boolean {
  return org.invite.status === 'LINKED';
}

/**
 * An INACTIVE bound organization is either a group the bot just created or one staff switched off;
 * the api keeps no separate flag, so both read as "waiting for activation". An unbound one waits
 * for its customer, not for staff: its invite activates it.
 */
export function isWaitingForActivation(org: Linkable): boolean {
  // An archived organization waits for nobody: only the admin's restore brings it back.
  return org.status === 'INACTIVE' && isLinked(org) && (org.archivedAt ?? null) === null;
}

export function countWaiting(orgs: readonly Linkable[]): number {
  return orgs.filter(isWaitingForActivation).length;
}

/** What the status pill says: the two statuses, or the invite state while nothing is bound. */
export type OrganizationDisplayStatus =
  'ACTIVE' | 'INACTIVE' | Exclude<OrganizationInviteStatus, 'LINKED'>;

export function displayStatusOf(org: Linkable): OrganizationDisplayStatus {
  if (!isLinked(org) && org.status === 'INACTIVE') {
    return org.invite.status === 'PENDING' ? 'PENDING' : 'EXPIRED';
  }
  return org.status;
}

/**
 * Inactive first (they need a decision or a customer), the newest first among them; active ones
 * follow by name. Stable and independent of the order the server used.
 */
export function sortInactiveFirst<T extends StaffOrganizationSummary>(orgs: readonly T[]): T[] {
  return [...orgs].sort((a, b) => {
    const aWaiting = a.status === 'INACTIVE';
    if (aWaiting !== (b.status === 'INACTIVE')) return aWaiting ? -1 : 1;
    if (aWaiting) return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

export interface OrganizationFilters {
  readonly search: string;
  readonly status: OrganizationStatusFilter;
  readonly type?: OrganizationTypeFilter;
  readonly label?: OrganizationLabelFilter;
}

function matchesStatus(org: Linkable, status: OrganizationStatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'UNLINKED') return !isLinked(org);
  if (status === 'INACTIVE') return isWaitingForActivation(org);
  return org.status === status;
}

/** Search over the name, the chat id (staff paste it from the bot's notice) and the phone digits. */
export function filterOrganizations<T extends StaffOrganizationSummary>(
  orgs: readonly T[],
  filters: OrganizationFilters,
): T[] {
  const needle = filters.search.trim().toLowerCase();
  const digits = needle.replace(/\D/g, '');
  const type = filters.type ?? 'all';
  const label = filters.label ?? 'all';
  return orgs.filter(
    (org) =>
      matchesStatus(org, filters.status) &&
      (type === 'all' || org.type === type) &&
      (label === 'all' || org.label === label) &&
      (needle === '' ||
        org.name.toLowerCase().includes(needle) ||
        (org.telegramChatId?.includes(needle) ?? false) ||
        // Only a search with enough digits looks at phones: "a" must not match every number.
        (digits.length >= 3 && (org.phone?.includes(digits) ?? false))),
  );
}

/** Whole days and hours left on an invite link; null once it ran out (or has no end). */
export function inviteTimeLeft(
  expiresAt: string | null,
  now: Date,
): { readonly days: number; readonly hours: number } | null {
  if (expiresAt === null) return null;
  const left = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(left) || left <= 0) return null;
  const totalHours = Math.floor(left / 3_600_000);
  return { days: Math.floor(totalHours / 24), hours: totalHours % 24 };
}

export interface OrganizationErrorMessage {
  readonly key: string;
  /** The organization changed or vanished since it was read: the screen reads it again. */
  readonly reload: boolean;
}

/** Maps a failed call to an i18n key; the server's English text is never shown. */
export function describeOrganizationError(error: unknown): OrganizationErrorMessage {
  if (error instanceof PermissionDeniedError) return { key: 'apiErrors.denied', reload: false };
  if (error instanceof ApiNotFoundError) return { key: 'organizations.errors.gone', reload: true };
  if (error instanceof ApiConflictError) {
    // The organization reasons the api names [C, owner 2026-11-11]; the page re-reads after each.
    if (error.reason === 'ORGANIZATION_NOT_LINKED') {
      return { key: 'apiErrors.organizationNotLinked', reload: true };
    }
    if (error.reason === 'ORGANIZATION_ALREADY_LINKED') {
      return { key: 'apiErrors.organizationAlreadyLinked', reload: true };
    }
    if (error.reason === 'PERSON_ORGANIZATION') {
      return { key: 'apiErrors.personOrganization', reload: true };
    }
    if (error.reason === 'ORGANIZATION_ARCHIVED') {
      return { key: 'apiErrors.organizationArchived', reload: true };
    }
    return { key: 'organizations.errors.conflict', reload: true };
  }
  if (error instanceof ApiValidationError) return { key: 'apiErrors.validation', reload: false };
  if (error instanceof RequestTimeoutError) return { key: 'apiErrors.timeout', reload: false };
  if (error instanceof NetworkError) return { key: 'apiErrors.network', reload: false };
  if (error instanceof InvalidResponseError) {
    return { key: 'apiErrors.invalidResponse', reload: false };
  }
  return { key: 'apiErrors.generic', reload: false };
}
