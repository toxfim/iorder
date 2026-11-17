import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors/domain-errors.js';
import type { Actor } from './actor.js';
import { assertMayTouchStaffTarget } from './staff-target.js';

const actor = (...staffRoles: Actor['staffRoles'][number][]): Actor => ({
  userId: 'a',
  staffRoles,
});

describe('assertMayTouchStaffTarget', () => {
  it('refuses a non-admin actor on an administrator, even one with other roles', () => {
    expect(() => assertMayTouchStaffTarget(actor('MANAGER'), { staffRoles: ['ADMIN'] })).toThrow(
      ForbiddenError,
    );
    expect(() =>
      assertMayTouchStaffTarget(actor('MANAGER'), { staffRoles: ['MANAGER', 'ADMIN'] }),
    ).toThrow(ForbiddenError);
  });

  it('lets an administrator act on an administrator', () => {
    expect(() =>
      assertMayTouchStaffTarget(actor('ADMIN'), { staffRoles: ['ADMIN'] }),
    ).not.toThrow();
  });

  it('lets a manager act on a non-admin', () => {
    expect(() => assertMayTouchStaffTarget(actor('MANAGER'), { staffRoles: [] })).not.toThrow();
    expect(() =>
      assertMayTouchStaffTarget(actor('MANAGER'), { staffRoles: ['DRIVER'] }),
    ).not.toThrow();
  });
});
