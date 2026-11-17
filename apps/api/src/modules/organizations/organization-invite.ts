import { randomBytes } from 'node:crypto';
import {
  ORGANIZATION_INVITE_START_PREFIX,
  organizationInviteStartPayloadSchema,
  type OrganizationInviteStatus,
} from '@iorder/shared';

// PURE rules of the organization invite link [P, owner request 2026-11-11]: a one-time,
// expiring bot deep link that binds a chat to a staff-created organization. No I/O, no clock.

/** 32 random bytes as base64url: 43 characters, the alphabet Telegram allows in a start payload. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The `start` / `startgroup` payload of a token. */
export function invitePayload(token: string): string {
  return `${ORGANIZATION_INVITE_START_PREFIX}${token}`;
}

/** The token inside a payload, or null when the payload is not an organization invite. */
export function inviteTokenOf(payload: string): string | null {
  return organizationInviteStartPayloadSchema.safeParse(payload).success
    ? payload.slice(ORGANIZATION_INVITE_START_PREFIX.length)
    : null;
}

export function isInvitePayload(payload: string | undefined): payload is string {
  return payload?.startsWith(ORGANIZATION_INVITE_START_PREFIX) === true;
}

/** What a Start press may do with an invite row: only a VALID one binds. */
export type InviteVerdict = 'VALID' | 'UNKNOWN' | 'USED' | 'REVOKED' | 'EXPIRED';

export function judgeInvite(
  invite: { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null } | null,
  now: Date,
): InviteVerdict {
  if (invite === null) return 'UNKNOWN';
  if (invite.usedAt !== null) return 'USED';
  if (invite.revokedAt !== null) return 'REVOKED';
  // The expiry instant itself no longer works.
  if (invite.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'VALID';
}

/**
 * The invite status staff see: LINKED once a chat is bound (also every group the bot registered by
 * itself), PENDING while the open link works, EXPIRED otherwise (staff make a new link).
 */
export function inviteStatusOf(
  organization: { telegramChatId: bigint | null; openInvite: { expiresAt: Date } | null },
  now: Date,
): { status: OrganizationInviteStatus; expiresAt: Date | null } {
  if (organization.telegramChatId !== null) return { status: 'LINKED', expiresAt: null };
  const open = organization.openInvite;
  if (open !== null && open.expiresAt.getTime() > now.getTime()) {
    return { status: 'PENDING', expiresAt: open.expiresAt };
  }
  return { status: 'EXPIRED', expiresAt: open?.expiresAt ?? null };
}
