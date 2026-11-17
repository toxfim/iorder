import {
  IDENTITY_ROUTES,
  ORGANIZATION_ROUTES,
  staffOrganizationListResponseSchema,
  staffOrganizationResponseSchema,
  staffUserListResponseSchema,
  staffUserResponseSchema,
  type StaffOrganizationSummary,
  type StaffUserResponse,
} from '@iorder/shared';
import { setUserActive, type StaffUsersApi } from '@/features/staff-users/api/staff-users-api';
import { ApiNotFoundError } from '@core/lib/api-errors';
import type { HttpClient } from '@core/lib/http-client';
import type { MemberView, OrganizationView } from '../domain/directory-model';
import type { DirectoryApi } from './directory-api';

/**
 * The customers directory over the routes the api already has: organizations (with their status),
 * `/staff/users` for the members (a customer is a user with a membership), the staff users api for
 * a member's active flag (block, unblock) and the organization member route for the role. The
 * directory model keeps a few fields the api has no source for (address, a group handle); they
 * stay empty.
 */
export function createHttpDirectoryApi(http: HttpClient, staffUsers: StaffUsersApi): DirectoryApi {
  const toOrganization = (o: StaffOrganizationSummary): OrganizationView => ({
    id: o.id,
    name: o.name,
    type: o.type,
    address: '',
    phone: '',
    // The api knows the group only by its chat id; there is no public handle to show.
    telegramGroup: o.telegramChatId ?? '',
    isActive: o.status === 'ACTIVE',
    since: o.createdAt,
  });

  const toMember = (u: StaffUserResponse): MemberView | null =>
    u.membership === null
      ? null
      : {
          id: u.id,
          organizationId: u.membership.organizationId,
          name: u.fullName,
          phone: u.phone ?? '',
          telegramUsername: u.telegramUserId ?? '',
          role: u.membership.role,
          isActive: u.status === 'ACTIVE',
          joinedAt: u.membership.joinedAt,
        };

  // Staff accounts are never organization members (CLAUDE.md); their membership is null.
  const requireMember = (u: StaffUserResponse): MemberView => {
    const member = toMember(u);
    if (!member) throw new ApiNotFoundError('The person is not a member', 'NOT_FOUND');
    return member;
  };

  return {
    // The default list leaves archived organizations out [C, owner 2026-11-13], so their members
    // have no organization here and the people list drops them.
    listOrganizations: async () =>
      (
        await http.request(
          ORGANIZATION_ROUTES.listOrganizations,
          staffOrganizationListResponseSchema,
        )
      ).items.map(toOrganization),

    listMembers: async () =>
      (await http.request(IDENTITY_ROUTES.listUsers, staffUserListResponseSchema)).items
        .map(toMember)
        .filter((member): member is MemberView => member !== null),

    setOrganizationActive: async (organizationId, isActive) =>
      toOrganization(
        await http.request(
          ORGANIZATION_ROUTES.updateOrganization,
          staffOrganizationResponseSchema,
          {
            params: { id: organizationId },
            body: { status: isActive ? 'ACTIVE' : 'INACTIVE' },
          },
        ),
      ),

    // Blocking from the directory never touches the Telegram group; the member page's dialog is
    // where the person chooses the removal.
    setMemberActive: async (memberId, isActive) =>
      requireMember(await setUserActive(staffUsers, memberId, isActive)),

    // The organization route answers the organization, not the person: read the user afterwards
    // so every member goes through the one mapping.
    setMemberRole: async (memberId, organizationId, role) => {
      await http.request(ORGANIZATION_ROUTES.changeMemberRole, staffOrganizationResponseSchema, {
        params: { id: organizationId, userId: memberId },
        body: { role },
      });
      return requireMember(
        await http.request(IDENTITY_ROUTES.getUser, staffUserResponseSchema, {
          params: { id: memberId },
        }),
      );
    },
  };
}
