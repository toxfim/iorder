import type { OrganizationLabel, OrganizationRole, OrganizationType } from '@iorder/shared';

export interface OrganizationView {
  id: string;
  name: string;
  type: OrganizationType;
  label: OrganizationLabel;
  /** Staff-entered contact phone (+digits); staff-only. */
  phone: string | null;
  /** The group chat or the bound person's private chat; null while a staff-created one is unbound. */
  telegramChatId: bigint | null;
  status: 'ACTIVE' | 'INACTIVE';
  pricePostingEnabled: boolean;
  /** Who added the bot (Telegram), for organizations created from a group; staff-only data. */
  addedBy: { telegramUserId: bigint; name: string } | null;
  /** The staff member who created it in the staff app; null for a group the bot registered. */
  createdByUserId: string | null;
  /** Folded into another organization (a retired bot-registered group); never listed. */
  merged: boolean;
  /** The open (unused, not revoked) invite, if any; it may have expired already. */
  openInvite: { expiresAt: Date } | null;
  /** [C, owner 2026-11-13] archived ("deleted") by an admin: INACTIVE, read-only, out of the lists. */
  archivedAt: Date | null;
  /** The admin who archived it; null while not archived. */
  archivedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemberView {
  userId: string;
  role: OrganizationRole;
  status: 'ACTIVE' | 'LEFT';
  joinedAt: Date;
  leftAt: Date | null;
}

/** An organization with its members (current and former). */
export interface OrganizationWithMembers {
  organization: OrganizationView;
  members: MemberView[];
}

/**
 * THE rule for changing an organization's type [C, owner 2026-11-12; P]: only one that was NEVER
 * bound. No chat now, no member history (a LEFT member counts: a chat-less PERSON whose person left
 * keeps its orders and debt, which a group bound later would inherit), not merged (retired) and
 * not archived (nothing on an archived organization changes).
 * The service enforces it on a PATCH and the staff DTO reports it, so the UI never guesses.
 */
export function isTypeChangeable({ organization, members }: OrganizationWithMembers): boolean {
  return (
    organization.telegramChatId === null &&
    members.length === 0 &&
    !organization.merged &&
    organization.archivedAt === null
  );
}
