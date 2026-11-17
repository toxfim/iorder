import type { OrganizationRole } from '@iorder/shared';
import type { MemberView, OrganizationView } from '../domain/directory-model';

/**
 * Customers and their members, as the directory screens model them (domain/directory-model). The
 * real adapter (http-directory-api.ts) composes the organizations and users routes; errors use
 * the typed errors of lib/api-errors. Staff accounts have their own api (features/staff-users).
 */
export interface DirectoryApi {
  listOrganizations: () => Promise<readonly OrganizationView[]>;
  listMembers: () => Promise<readonly MemberView[]>;
  setOrganizationActive: (organizationId: string, isActive: boolean) => Promise<OrganizationView>;
  setMemberActive: (memberId: string, isActive: boolean) => Promise<MemberView>;
  /** A member has exactly one role; the organization is the one the member belongs to. */
  setMemberRole: (
    memberId: string,
    organizationId: string,
    role: OrganizationRole,
  ) => Promise<MemberView>;
}
