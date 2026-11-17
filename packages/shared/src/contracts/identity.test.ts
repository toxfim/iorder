import { describe, expect, it } from 'vitest';
import {
  assignShopOwnerRequestSchema,
  buildPath,
  CONFLICT_REASONS,
  MEMBERSHIP_CONFLICT_REASONS,
  IDENTITY_ROUTES,
  meResponseSchema,
  staffViewerSchema,
  ORGANIZATION_ROUTES,
  phoneSchema,
  setOwnContactRequestSchema,
  staffUserResponseSchema,
  telegramChatIdSchema,
  telegramUserIdSchema,
  updateOrganizationRequestSchema,
  updateUserRequestSchema,
} from '../index.js';

describe('Telegram ids are strings', () => {
  it.each(['1', '777000111', '4503599627370495', '9007199254740991'])(
    'accepts user id %s',
    (id) => {
      expect(telegramUserIdSchema.safeParse(id).success).toBe(true);
    },
  );

  it.each([777000111, '0', '-1', '01', '1.5', '12abc', '', ' 1', '9007199254740992'])(
    'rejects user id %j',
    (id) => {
      expect(telegramUserIdSchema.safeParse(id).success).toBe(false);
    },
  );

  it('accepts negative group chat ids, rejects zero and numbers', () => {
    expect(telegramChatIdSchema.safeParse('-1001234567890').success).toBe(true);
    expect(telegramChatIdSchema.safeParse('0').success).toBe(false);
    expect(telegramChatIdSchema.safeParse(-1001234567890).success).toBe(false);
  });
});

describe('membership conflict reasons', () => {
  it('overlap the reasons the web maps exhaustively only where a staff screen shows them', () => {
    expect(
      MEMBERSHIP_CONFLICT_REASONS.filter((r) =>
        (CONFLICT_REASONS as readonly string[]).includes(r),
      ),
    ).toEqual([
      'LAST_ADMIN',
      'TELEGRAM_ID_REQUIRED',
      'ORGANIZATION_NOT_LINKED',
      'ORGANIZATION_ALREADY_LINKED',
      'PERSON_ORGANIZATION',
      'ORGANIZATION_ARCHIVED',
    ]);
    expect([...MEMBERSHIP_CONFLICT_REASONS].sort()).toEqual([
      'ALREADY_MEMBER_ELSEWHERE',
      'LAST_ADMIN',
      'MEMBER_IS_STAFF',
      'ORGANIZATION_ALREADY_LINKED',
      'ORGANIZATION_ARCHIVED',
      'ORGANIZATION_INACTIVE',
      'ORGANIZATION_NOT_LINKED',
      'PERSON_ORGANIZATION',
      'SHOP_OWNER_EXISTS',
      'STAFF_HAS_MEMBERSHIP',
      'TELEGRAM_ID_REQUIRED',
      'USER_BLOCKED',
    ]);
  });
});

describe('phone', () => {
  it('accepts E.164 and rejects other shapes', () => {
    expect(phoneSchema.safeParse('+998901234567').success).toBe(true);
    for (const bad of ['998901234567', '+0123456', '+99890', '90 123 45 67', '+998 90 123 45 67']) {
      expect(phoneSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('own contact request', () => {
  it('normalises the phone to +digits and trims the name', () => {
    expect(
      setOwnContactRequestSchema.parse({ fullName: '  Ali Valiyev ', phone: '+998 93 555-01 47' }),
    ).toEqual({ fullName: 'Ali Valiyev', phone: '+998935550147' });
  });

  it('rejects a bad phone, an empty or long name and unknown keys', () => {
    const ok = { fullName: 'Ali', phone: '+998935550147' };
    for (const bad of [
      { ...ok, phone: '998935550147' },
      { ...ok, phone: '+12' },
      { ...ok, phone: '+99893555014778901234' },
      { ...ok, fullName: '   ' },
      { ...ok, fullName: 'x'.repeat(201) },
      { ...ok, userId: 'x' },
    ]) {
      expect(setOwnContactRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('person name', () => {
  const phone = '+998935550147';

  it.each([
    'Ali‮Valiyev',
    'Ali⁦Valiyev',
    'Ali​Valiyev',
    'Ali‍Valiyev',
    'Ali⁠Valiyev',
    'Ali﻿Valiyev',
    'Ali\u0000Valiyev',
    'Ali\nValiyev',
    'Ali\tValiyev',
    'Ali­Valiyev',
  ])('rejects control or format characters in %j', (fullName) => {
    expect(setOwnContactRequestSchema.safeParse({ fullName, phone }).success).toBe(false);
    expect(updateUserRequestSchema.safeParse({ fullName }).success).toBe(false);
  });

  it.each(['Ali Valiyev', 'Алишер Валиев', 'O‘ktam Karimov', 'Oʻktam', "D'Arcy", 'Anna-Maria'])(
    'accepts %j',
    (fullName) => {
      expect(setOwnContactRequestSchema.safeParse({ fullName, phone }).success).toBe(true);
    },
  );
});

describe('request schemas are strict', () => {
  it('rejects unknown and empty updates', () => {
    expect(updateUserRequestSchema.safeParse({}).success).toBe(false);
    expect(updateUserRequestSchema.safeParse({ fullName: 'A', status: 'BLOCKED' }).success).toBe(
      false,
    );
    expect(updateUserRequestSchema.safeParse({ phone: null }).success).toBe(true);
    expect(updateOrganizationRequestSchema.safeParse({}).success).toBe(false);
    expect(updateOrganizationRequestSchema.safeParse({ telegramChatId: '1' }).success).toBe(false);
    expect(assignShopOwnerRequestSchema.safeParse({ userId: 'nope' }).success).toBe(false);
  });
});

describe('response contracts', () => {
  it('/me carries only the caller own contact and no Telegram id', () => {
    expect(Object.keys(meResponseSchema.shape).sort()).toEqual([
      'contact',
      'fullName',
      'locale',
      'membership',
      'needsContact',
      'staffRoles',
      'staffViewer',
      'userId',
    ]);
  });

  it('the staff viewer block of /me says only whether an order is possible and where it goes', () => {
    // No organization id, no role, no cost: the customer app needs the name to show, nothing else.
    expect(Object.keys(staffViewerSchema.shape).sort()).toEqual(['canOrder', 'organizationName']);
    const base = {
      userId: '0198c0de-0000-7000-8000-000000000001',
      fullName: 'A',
      locale: 'UZ',
      staffRoles: [],
      membership: null,
      contact: null,
      needsContact: false,
    };
    // Optional and nullable: older answers and customers simply have none.
    expect(meResponseSchema.safeParse(base).success).toBe(true);
    expect(meResponseSchema.safeParse({ ...base, staffViewer: null }).success).toBe(true);
    expect(
      meResponseSchema.safeParse({
        ...base,
        staffViewer: { canOrder: true, organizationName: 'Test shop' },
      }).success,
    ).toBe(true);
    expect(
      meResponseSchema.safeParse({
        ...base,
        staffViewer: { canOrder: true, organizationName: 'Test shop', organizationId: 'x' },
      }).success,
    ).toBe(false);
  });

  it('the staff user DTO carries the phone and a string Telegram id', () => {
    expect(Object.keys(staffUserResponseSchema.shape)).toEqual(
      expect.arrayContaining(['phone', 'telegramUserId']),
    );
  });
});

describe('identity and organization routes', () => {
  it('build their paths', () => {
    expect(buildPath(IDENTITY_ROUTES.assignStaffRole, { id: 'u1', role: 'DRIVER' })).toBe(
      '/staff/users/u1/roles/DRIVER',
    );
    expect(buildPath(ORGANIZATION_ROUTES.markMemberLeft, { id: 'o1', userId: 'u1' })).toBe(
      '/staff/organizations/o1/members/u1/leave',
    );
  });
});
