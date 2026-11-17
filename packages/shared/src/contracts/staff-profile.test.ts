import { describe, expect, it } from 'vitest';
import {
  ownStaffProfileResponseSchema,
  STAFF_PROFILE_ROUTES,
  updateOwnStaffProfileRequestSchema,
} from './staff-profile.js';

describe('own staff profile contract', () => {
  it('normalises the phone to +digits and trims the name, as the customer contact does', () => {
    expect(
      updateOwnStaffProfileRequestSchema.parse({
        fullName: '  Sardor Aliyev ',
        phone: '+998 (90) 123-45-67',
      }),
    ).toEqual({ fullName: 'Sardor Aliyev', phone: '+998901234567' });
  });

  it('a phone may be removed, but the field is always sent', () => {
    expect(updateOwnStaffProfileRequestSchema.parse({ fullName: 'Sardor', phone: null })).toEqual({
      fullName: 'Sardor',
      phone: null,
    });
    expect(updateOwnStaffProfileRequestSchema.safeParse({ fullName: 'Sardor' }).success).toBe(
      false,
    );
  });

  it('rejects a bad phone, an empty, long or disguised name and every other field', () => {
    const ok = { fullName: 'Sardor', phone: '+998901234567' };
    for (const bad of [
      { ...ok, phone: '901234567' },
      { ...ok, phone: '' },
      { ...ok, fullName: '   ' },
      { ...ok, fullName: 'x'.repeat(201) },
      { ...ok, fullName: 'Sar\u202Edor' },
      { ...ok, userId: '019a0000-0000-7000-8000-000000000001' },
      { ...ok, staffRoles: ['ADMIN'] },
      { ...ok, login: 'admin' },
      { ...ok, telegramUserId: '1' },
      { ...ok, status: 'ACTIVE' },
      { ...ok, language: 'RU' },
    ]) {
      expect(updateOwnStaffProfileRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it('the answer carries the name and the phone only', () => {
    expect(Object.keys(ownStaffProfileResponseSchema.shape).sort()).toEqual(['fullName', 'phone']);
  });

  it('neither route names a person: the caller is the only possible target', () => {
    for (const { path } of Object.values(STAFF_PROFILE_ROUTES)) {
      expect(path).toBe('/staff/me/profile');
    }
  });
});
