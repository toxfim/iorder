import type { OrganizationRole, OrganizationType } from '@iorder/shared';

// View-models of the directory screens. packages/shared has no directory contract: the real
// adapter (api/http-directory-api.ts) maps the organization and user responses onto these, and
// the fake (api/fake-backoffice.ts) serves them directly.

/**
 * A customer organization: a Telegram group (GROUP) or one individual in a private chat with the
 * bot (PERSON) [C, owner 2026-11-11].
 */
export interface OrganizationView {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly address: string;
  readonly phone: string;
  /** Telegram group handle, for example `@idealmobile_opt`. */
  readonly telegramGroup: string;
  readonly isActive: boolean;
  /** ISO instant of the first day with us; shown as MM.YYYY. */
  readonly since: string;
}

export interface MemberView {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly phone: string;
  readonly telegramUsername: string;
  /** Exactly one role per member (SHOP_OWNER or SELLER). */
  readonly role: OrganizationRole;
  readonly isActive: boolean;
  readonly joinedAt: string;
}

/** Two-letter initials for avatars: first letters of the first two words, upper case. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
