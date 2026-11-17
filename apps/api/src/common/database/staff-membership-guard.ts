import { ConflictError } from '../errors/domain-errors.js';

/**
 * The database enforces "staff are never members", "one active membership per user" and "one
 * active shop owner per organization" as the last line of defence when two requests race past
 * the service checks. Their errors become the same conflicts the services raise, never a 500.
 *
 * Matching uses the structured fields of the driver error (SQLSTATE and the violated index name
 * for unique violations; SQLSTATE and the tag the trigger raises for the two staff guards), not
 * Prisma's decorated message. The names are those of migration identity_organizations.
 * Returns the original error when it is none of these.
 */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

interface DriverFacts {
  prismaCode: string | undefined;
  sqlState: string | undefined;
  /** The violated index/constraint, when the driver reports it. */
  constraint: string | undefined;
  /** The message as the database wrote it (no Prisma decoration). */
  databaseMessage: string | undefined;
  modelName: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Reads what Prisma 7 + the pg driver adapter put in `meta`; every field may be absent. */
function readDriverFacts(error: unknown): DriverFacts | null {
  const top = asRecord(error);
  if (!top) return null;
  const meta = asRecord(top['meta']);
  // A failure at COMMIT (a deferred constraint trigger) arrives as the driver adapter error itself,
  // with the database facts on `cause`, instead of wrapped in a Prisma request error.
  const cause =
    asRecord(asRecord(meta?.['driverAdapterError'])?.['cause']) ?? asRecord(top['cause']);
  const constraint = asRecord(cause?.['constraint']);
  return {
    prismaCode: asString(top['code']),
    // Raw queries (P2010) report the SQLSTATE and message directly in meta.
    sqlState: asString(cause?.['originalCode']) ?? asString(meta?.['code']),
    constraint: asString(constraint?.['index']) ?? asString(constraint?.['name']),
    databaseMessage:
      asString(cause?.['originalMessage']) ??
      asString(cause?.['message']) ??
      asString(meta?.['message']),
    modelName: asString(meta?.['modelName']),
  };
}

const UNIQUE_CONFLICTS: Record<string, () => ConflictError> = {
  organization_members_one_active_owner_per_organization: () =>
    new ConflictError('The organization already has a shop owner', 'SHOP_OWNER_EXISTS'),
  organization_members_one_active_per_user: () =>
    new ConflictError(
      'The person is already an active member of an organization',
      'ALREADY_MEMBER_ELSEWHERE',
    ),
};

/** The triggers raise "<tag>: <explanation>"; the tag is the stable part. */
const TRIGGER_CONFLICTS: Record<string, () => ConflictError> = {
  staff_role_conflicts_with_membership: () =>
    new ConflictError(
      'A person with an organization membership cannot hold a staff role',
      'STAFF_HAS_MEMBERSHIP',
    ),
  membership_conflicts_with_staff_role: () =>
    new ConflictError('A staff member cannot be an organization member', 'MEMBER_IS_STAFF'),
  // Raised by migration staff_accounts: a person with no Telegram id exists only as staff.
  telegram_id_required: () =>
    new ConflictError(
      'A person without a Telegram id must keep a staff role',
      'TELEGRAM_ID_REQUIRED',
    ),
};

export function mapMembershipGuardError(error: unknown): unknown {
  const facts = readDriverFacts(error);
  if (!facts) return error;

  if (facts.prismaCode === 'P2002' || facts.sqlState === UNIQUE_VIOLATION) {
    const known = facts.constraint ? UNIQUE_CONFLICTS[facts.constraint] : undefined;
    if (known) return known();
    // Some other uniqueness rule of a membership row (for example the same person twice in one
    // organization): still a conflict the caller can understand, never a 500.
    if (facts.modelName === 'OrganizationMember') {
      return new ConflictError(
        'The person is already an active member of an organization',
        'ALREADY_MEMBER_ELSEWHERE',
      );
    }
    return error;
  }

  if (facts.sqlState === CHECK_VIOLATION && facts.databaseMessage) {
    const tag = facts.databaseMessage.split(':', 1)[0]?.trim() ?? '';
    const known = TRIGGER_CONFLICTS[tag];
    if (known) return known();
  }
  return error;
}
