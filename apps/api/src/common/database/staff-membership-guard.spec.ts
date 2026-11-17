import { describe, expect, it } from 'vitest';
import { ConflictError } from '../errors/domain-errors.js';
import { mapMembershipGuardError } from './staff-membership-guard.js';

/** The shape Prisma 7 + the pg driver adapter produce (checked against a real database). */
function driverError(options: {
  prismaCode: string;
  sqlState: string;
  databaseMessage: string;
  constraint?: string;
  modelName?: string;
}): Error {
  return Object.assign(new Error('Invalid `prisma.x.create()` invocation: decorated text'), {
    code: options.prismaCode,
    meta: {
      modelName: options.modelName ?? 'OrganizationMember',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: options.sqlState,
          originalMessage: options.databaseMessage,
          ...(options.constraint ? { constraint: { index: options.constraint } } : {}),
        },
      },
    },
  });
}

const reasonOf = (value: unknown): unknown => {
  expect(value).toBeInstanceOf(ConflictError);
  return (value as ConflictError).reason;
};

describe('mapMembershipGuardError', () => {
  it.each([
    ['organization_members_one_active_owner_per_organization', 'SHOP_OWNER_EXISTS'],
    ['organization_members_one_active_per_user', 'ALREADY_MEMBER_ELSEWHERE'],
  ])('maps a unique violation of the index %s to %s', (constraint, reason) => {
    const error = driverError({
      prismaCode: 'P2002',
      sqlState: '23505',
      databaseMessage: 'duplicate key value violates unique constraint',
      constraint,
    });
    expect(reasonOf(mapMembershipGuardError(error))).toBe(reason);
  });

  it('maps the same violation reported as a raw SQLSTATE without the Prisma code', () => {
    const error = driverError({
      prismaCode: 'P2010',
      sqlState: '23505',
      databaseMessage: 'duplicate key',
      constraint: 'organization_members_one_active_per_user',
    });
    expect(reasonOf(mapMembershipGuardError(error))).toBe('ALREADY_MEMBER_ELSEWHERE');
  });

  it.each([
    ['staff_role_conflicts_with_membership: user has an ACTIVE membership', 'STAFF_HAS_MEMBERSHIP'],
    ['membership_conflicts_with_staff_role: user holds a staff role', 'MEMBER_IS_STAFF'],
  ])('maps the trigger error "%s" to %s', (databaseMessage, reason) => {
    const error = driverError({ prismaCode: 'P2039', sqlState: '23514', databaseMessage });
    expect(reasonOf(mapMembershipGuardError(error))).toBe(reason);
  });

  it('answers an unknown uniqueness rule of a membership row with a generic 409, not a 500', () => {
    const error = driverError({
      prismaCode: 'P2002',
      sqlState: '23505',
      databaseMessage: 'duplicate key',
      constraint: 'organization_members_organization_id_user_id_key',
    });
    expect(reasonOf(mapMembershipGuardError(error))).toBe('ALREADY_MEMBER_ELSEWHERE');
  });

  it('does not rewrite unique violations of other tables', () => {
    const error = driverError({
      prismaCode: 'P2002',
      sqlState: '23505',
      databaseMessage: 'duplicate key',
      constraint: 'users_telegram_user_id_key',
      modelName: 'User',
    });
    expect(mapMembershipGuardError(error)).toBe(error);
  });

  it('does not trust message text alone: a plain error that mentions a name stays as it is', () => {
    const error = new Error('staff_role_conflicts_with_membership: made up');
    expect(mapMembershipGuardError(error)).toBe(error);
    const unrelatedCheck = driverError({
      prismaCode: 'P2039',
      sqlState: '23514',
      databaseMessage: 'users_full_name_not_blank',
    });
    expect(mapMembershipGuardError(unrelatedCheck)).toBe(unrelatedCheck);
  });

  it('returns every other error untouched', () => {
    const other = new Error('connection reset');
    expect(mapMembershipGuardError(other)).toBe(other);
    expect(mapMembershipGuardError('text')).toBe('text');
    expect(mapMembershipGuardError(null)).toBeNull();
  });
});
