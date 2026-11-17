import { describe, expect, it } from 'vitest';
import {
  generateInviteToken,
  invitePayload,
  inviteStatusOf,
  inviteTokenOf,
  isInvitePayload,
  judgeInvite,
} from './organization-invite.js';

const now = new Date('2026-11-11T10:00:00Z');
const later = new Date('2026-11-18T10:00:00Z');
const earlier = new Date('2026-11-11T09:59:59Z');

describe('organization invite token', () => {
  it('is 43 base64url characters and round-trips through the start payload', () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateInviteToken()).not.toBe(token);
    const payload = invitePayload(token);
    expect(payload).toBe(`org_${token}`);
    expect(isInvitePayload(payload)).toBe(true);
    expect(inviteTokenOf(payload)).toBe(token);
  });

  it('refuses anything that is not an invite payload', () => {
    expect(inviteTokenOf('staff_x')).toBeNull();
    expect(inviteTokenOf('org_short')).toBeNull();
    expect(isInvitePayload(undefined)).toBe(false);
    expect(isInvitePayload('staff_abc')).toBe(false);
  });
});

describe('judgeInvite [P]', () => {
  const open = { expiresAt: later, usedAt: null, revokedAt: null };

  it('a known, unused, unrevoked, unexpired invite is VALID', () => {
    expect(judgeInvite(open, now)).toBe('VALID');
  });

  it('unknown, used, revoked (regenerated) and expired invites are refused', () => {
    expect(judgeInvite(null, now)).toBe('UNKNOWN');
    expect(judgeInvite({ ...open, usedAt: earlier }, now)).toBe('USED');
    expect(judgeInvite({ ...open, revokedAt: earlier }, now)).toBe('REVOKED');
    expect(judgeInvite({ ...open, expiresAt: earlier }, now)).toBe('EXPIRED');
    // The expiry instant itself no longer works.
    expect(judgeInvite({ ...open, expiresAt: now }, now)).toBe('EXPIRED');
  });
});

describe('inviteStatusOf', () => {
  it('is LINKED once a chat is bound, PENDING while the link works, EXPIRED otherwise', () => {
    expect(inviteStatusOf({ telegramChatId: -100n, openInvite: null }, now)).toEqual({
      status: 'LINKED',
      expiresAt: null,
    });
    expect(inviteStatusOf({ telegramChatId: null, openInvite: { expiresAt: later } }, now)).toEqual(
      { status: 'PENDING', expiresAt: later },
    );
    expect(
      inviteStatusOf({ telegramChatId: null, openInvite: { expiresAt: earlier } }, now),
    ).toEqual({ status: 'EXPIRED', expiresAt: earlier });
    expect(inviteStatusOf({ telegramChatId: null, openInvite: null }, now)).toEqual({
      status: 'EXPIRED',
      expiresAt: null,
    });
  });
});
