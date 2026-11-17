import { describe, expect, it } from 'vitest';
import {
  createStaffAccountRequestSchema,
  passwordSignInRequestSchema,
  setStaffCredentialsRequestSchema,
  staffAccountResponseSchema,
  staffCredentialsResponseSchema,
  staffLoginSchema,
  telegramWidgetSignInRequestSchema,
} from './staff-auth.js';

describe('staff sign-in contracts', () => {
  it('keeps accepting the legacy lowercase login of 3 to 32 allowed characters', () => {
    for (const ok of ['abc', 'a.b_c-d', 'sardor01', 'x'.repeat(32)]) {
      expect(staffLoginSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['ab', 'Abc', '.abc', 'a b', 'x'.repeat(33), 'ab\n', 'añb']) {
      expect(staffLoginSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts email-like logins and refuses malformed ones', () => {
    const ok = [
      'toxfim@iorder.uz',
      'a.b+c_d-e@sub.iorder.uz',
      'x1@a-b.co',
      `${'a'.repeat(40)}@iorder.uz`,
    ];
    for (const login of ok) expect(staffLoginSchema.safeParse(login).success, login).toBe(true);
    const bad = [
      'a@b',
      'A@iorder.uz',
      '@iorder.uz',
      'a@@iorder.uz',
      'a@b@iorder.uz',
      '.a@iorder.uz',
      'a.@iorder.uz',
      'a..b@iorder.uz',
      'a@iorder..uz',
      'a@-iorder.uz',
      'a@iorder-.uz',
      'a@.iorder.uz',
      'a@iorder.u',
      'a@iorder.u1',
      'a b@iorder.uz',
      'a@iorder.uz\n',
      'añ@iorder.uz',
      `${'a'.repeat(60)}@iorder.uz`,
    ];
    for (const login of bad) expect(staffLoginSchema.safeParse(login).success, login).toBe(false);
  });

  it('enforces the 8 character minimum when a password is SET, but not when signing in', () => {
    const set = (password: string) =>
      setStaffCredentialsRequestSchema.safeParse({ password }).success;
    expect(set('x'.repeat(7))).toBe(false);
    expect(set('x'.repeat(8))).toBe(true);
    expect(set('x'.repeat(129))).toBe(false);
    expect(passwordSignInRequestSchema.safeParse({ login: 'a', password: 'short' }).success).toBe(
      true,
    );
  });

  it('rejects unknown fields and an empty credentials request', () => {
    expect(
      passwordSignInRequestSchema.safeParse({ login: 'a', password: 'b', remember: true }).success,
    ).toBe(false);
    expect(setStaffCredentialsRequestSchema.safeParse({}).success).toBe(false);
    expect(
      setStaffCredentialsRequestSchema.safeParse({ login: 'abc', role: 'ADMIN' }).success,
    ).toBe(false);
    const widget = {
      id: 1,
      first_name: 'A',
      auth_date: 1_700_000_000,
      hash: 'a'.repeat(64),
    };
    expect(telegramWidgetSignInRequestSchema.safeParse(widget).success).toBe(true);
    expect(telegramWidgetSignInRequestSchema.safeParse({ ...widget, admin: 1 }).success).toBe(
      false,
    );
  });

  it('has no place for a password or a hash in the credentials response', () => {
    expect(Object.keys(staffCredentialsResponseSchema.shape).sort()).toEqual([
      'login',
      'passwordChangedAt',
      'userId',
    ]);
  });

  it('requires at least one staff role to create an account, and rejects unknown fields', () => {
    const base = {
      fullName: 'A B',
      login: 'ab@iorder.uz',
      password: 'x'.repeat(12),
      roles: ['DRIVER'],
      telegramUserId: '555000111',
    };
    const parse = (value: unknown) => createStaffAccountRequestSchema.safeParse(value).success;
    expect(parse(base)).toBe(true);
    // Mandatory: an unlinked staff member would be taken for a customer in a Telegram group.
    expect(parse({ ...base, telegramUserId: undefined })).toBe(false);
    expect(parse({ ...base, telegramUserId: '' })).toBe(false);
    expect(parse({ ...base, roles: [] })).toBe(false);
    expect(parse({ ...base, roles: ['CUSTOMER'] })).toBe(false);
    expect(parse({ ...base, roles: ['DRIVER', 'DRIVER'] })).toBe(false);
    expect(parse({ ...base, status: 'ACTIVE' })).toBe(false);
    expect(parse({ ...base, password: 'short' })).toBe(false);
  });

  it('has no place for a password, a hash or a Telegram id in the account response', () => {
    expect(Object.keys(staffAccountResponseSchema.shape).sort()).toEqual([
      'createdAt',
      'fullName',
      'hasPassword',
      'id',
      'lastSignInAt',
      'login',
      'roles',
      'status',
      'telegramLinked',
    ]);
  });
});

describe('customer site handoff contracts', () => {
  it('accept only http(s) addresses: a browser is sent there', async () => {
    const { customerSiteHandoffResponseSchema, customerSiteResponseSchema } =
      await import('./staff-auth.js');
    const { customerHandoffPageResponseSchema } = await import('./customer-auth.js');
    const expiresAt = '2026-11-09T10:00:00.000Z';
    expect(customerSiteResponseSchema.parse({ url: null })).toEqual({ url: null });
    expect(customerSiteResponseSchema.parse({ url: 'https://order.iorder.uz' }).url).toBe(
      'https://order.iorder.uz',
    );
    expect(
      customerSiteHandoffResponseSchema.safeParse({
        url: 'http://localhost:5174/#handoff=abc',
        expiresAt,
      }).success,
    ).toBe(true);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.example', '/handoff']) {
      expect(customerSiteResponseSchema.safeParse({ url }).success, url).toBe(false);
      expect(customerSiteHandoffResponseSchema.safeParse({ url, expiresAt }).success, url).toBe(
        false,
      );
      expect(customerHandoffPageResponseSchema.safeParse({ url }).success, url).toBe(false);
    }
  });

  it('the handoff request has no field at all: there is no return address to send', async () => {
    const { customerSiteHandoffRequestSchema } = await import('./staff-auth.js');
    expect(customerSiteHandoffRequestSchema.safeParse({}).success).toBe(true);
    expect(
      customerSiteHandoffRequestSchema.safeParse({ returnTo: 'https://evil.example' }).success,
    ).toBe(false);
  });

  it('the exchange request takes any short string, so a malformed code is the service`s to refuse', async () => {
    const { customerHandoffRequestSchema } = await import('./customer-auth.js');
    for (const code of ['', 'short', 'A'.repeat(43), 'x'.repeat(256)]) {
      expect(customerHandoffRequestSchema.safeParse({ code }).success, code).toBe(true);
    }
    expect(customerHandoffRequestSchema.safeParse({ code: 'x'.repeat(257) }).success).toBe(false);
    expect(customerHandoffRequestSchema.safeParse({ code: 'A'.repeat(43), extra: 1 }).success).toBe(
      false,
    );
    expect(customerHandoffRequestSchema.safeParse({}).success).toBe(false);
  });
});
