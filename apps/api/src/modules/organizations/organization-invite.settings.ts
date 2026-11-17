import { DEFAULT_ORGANIZATION_INVITE_TTL_SECONDS } from '@iorder/shared';

/** How long an organization invite link works: `ORGANIZATION_INVITE_TTL_SECONDS` [P], 7 days. */
export class OrganizationInviteSettings {
  constructor(readonly ttlSeconds: number = DEFAULT_ORGANIZATION_INVITE_TTL_SECONDS) {}
}
