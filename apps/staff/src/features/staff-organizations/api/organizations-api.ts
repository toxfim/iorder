import {
  ORGANIZATION_ROUTES,
  createOrganizationResponseSchema,
  staffOrganizationInviteResponseSchema,
  staffOrganizationListResponseSchema,
  staffOrganizationResponseSchema,
  type CreateOrganizationRequest,
  type CreateOrganizationResponse,
  type OrganizationLabel,
  type OrganizationType,
  type StaffOrganizationInviteResponse,
  type StaffOrganizationResponse,
  type StaffOrganizationSummary,
} from '@iorder/shared';
import type { HttpClient } from '@core/lib/http-client';

export type OrganizationStatus = StaffOrganizationSummary['status'];

export interface OrganizationListFilter {
  readonly search?: string;
  readonly status?: OrganizationStatus;
  readonly type?: OrganizationType;
  readonly label?: OrganizationLabel;
  /**
   * [C, owner 2026-11-13] archived organizations are left out by default; `true` lists only them.
   */
  readonly archived?: boolean;
}

/** What staff may change on an organization besides its status [C, owner 2026-11-11]. */
export interface OrganizationDetailsChange {
  readonly name?: string;
  /** Only while no chat is bound [C, owner 2026-11-12; P]; 409 ORGANIZATION_ALREADY_LINKED otherwise. */
  readonly type?: OrganizationType;
  readonly label?: OrganizationLabel;
  /** Normalized `+digits`; null clears it. */
  readonly phone?: string | null;
}

/**
 * Staff organizations (manager and admin change them; the purchasing manager reads; the server
 * answers 403 to everyone else). The server takes no expected version and no reason for a status
 * change: activating or deactivating is one audited PATCH, and a repeat of the same status is a
 * no-op.
 */
export interface OrganizationsApi {
  list: (filter?: OrganizationListFilter) => Promise<readonly StaffOrganizationSummary[]>;
  /** 404 for an unknown id. */
  get: (organizationId: string) => Promise<StaffOrganizationResponse>;
  /**
   * Activates or deactivates. Answers the updated organization. 409 ORGANIZATION_NOT_LINKED when
   * an organization without a Telegram chat is activated (its invite activates it).
   */
  setStatus: (
    organizationId: string,
    status: OrganizationStatus,
  ) => Promise<StaffOrganizationResponse>;
  /** Name, type (unlinked only), label and phone (manager, admin). */
  update: (
    organizationId: string,
    change: OrganizationDetailsChange,
  ) => Promise<StaffOrganizationResponse>;
  /** A GROUP or PERSON organization plus its first one-time bot link (manager, admin). */
  create: (request: CreateOrganizationRequest) => Promise<CreateOrganizationResponse>;
  /** The current invite link; `url` only while PENDING (and when the bot is configured). */
  getInvite: (organizationId: string) => Promise<StaffOrganizationInviteResponse>;
  /** A new link; the old one stops at once. 409 ORGANIZATION_ALREADY_LINKED once bound. */
  regenerateInvite: (organizationId: string) => Promise<StaffOrganizationInviteResponse>;
  /**
   * "Delete" = archive (admin only) [C, owner 2026-11-13]: it leaves the lists, turns INACTIVE and
   * keeps its history. A repeat is a no-op. Every other write on it answers 409
   * ORGANIZATION_ARCHIVED until it is restored.
   */
  archive: (organizationId: string) => Promise<StaffOrganizationResponse>;
  /** Back from the archive (admin only); it stays INACTIVE until staff activate it. */
  restore: (organizationId: string) => Promise<StaffOrganizationResponse>;
}

export function createHttpOrganizationsApi(http: HttpClient): OrganizationsApi {
  return {
    list: async (filter = {}) =>
      (
        await http.request(
          ORGANIZATION_ROUTES.listOrganizations,
          staffOrganizationListResponseSchema,
          {
            query: {
              search: filter.search,
              status: filter.status,
              type: filter.type,
              label: filter.label,
              archived: filter.archived === undefined ? undefined : String(filter.archived),
            },
          },
        )
      ).items,
    get: (organizationId) =>
      http.request(ORGANIZATION_ROUTES.getOrganization, staffOrganizationResponseSchema, {
        params: { id: organizationId },
      }),
    setStatus: (organizationId, status) =>
      http.request(ORGANIZATION_ROUTES.updateOrganization, staffOrganizationResponseSchema, {
        params: { id: organizationId },
        body: { status },
      }),
    update: (organizationId, change) =>
      http.request(ORGANIZATION_ROUTES.updateOrganization, staffOrganizationResponseSchema, {
        params: { id: organizationId },
        body: change,
      }),
    create: (request) =>
      http.request(ORGANIZATION_ROUTES.createOrganization, createOrganizationResponseSchema, {
        body: request,
      }),
    getInvite: (organizationId) =>
      http.request(
        ORGANIZATION_ROUTES.getOrganizationInvite,
        staffOrganizationInviteResponseSchema,
        { params: { id: organizationId } },
      ),
    regenerateInvite: (organizationId) =>
      http.request(
        ORGANIZATION_ROUTES.regenerateOrganizationInvite,
        staffOrganizationInviteResponseSchema,
        { params: { id: organizationId } },
      ),
    archive: (organizationId) =>
      http.request(ORGANIZATION_ROUTES.archiveOrganization, staffOrganizationResponseSchema, {
        params: { id: organizationId },
      }),
    restore: (organizationId) =>
      http.request(ORGANIZATION_ROUTES.restoreOrganization, staffOrganizationResponseSchema, {
        params: { id: organizationId },
      }),
  };
}
