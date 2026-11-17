import type { Locale, OrganizationRole, StaffRole, UserStatusName } from '@iorder/shared';

/** A user with their staff roles. The Telegram id stays a bigint inside the api; DTOs make it a string. Null only for a staff account not yet linked to Telegram. */
export interface UserView {
  id: string;
  telegramUserId: bigint | null;
  fullName: string;
  phone: string | null;
  language: Locale;
  status: UserStatusName;
  staffRoles: StaffRole[];
  createdAt: Date;
  updatedAt: Date;
}

/** A user's ACTIVE organization membership, with just enough of the organization to act on it. */
export interface ActiveMembershipView {
  userId: string;
  organizationId: string;
  organizationName: string;
  organizationActive: boolean;
  role: OrganizationRole;
  joinedAt: Date;
}

/** What other modules may ask about a person (for example the organizations module). */
export interface UserSummary {
  id: string;
  fullName: string;
  phone: string | null;
  status: UserStatusName;
  staffRoles: StaffRole[];
}
