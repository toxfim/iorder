import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../common/auth/actor.js';
import { StaffAuthService } from './staff-auth.service.js';
import { StaffSessionService } from './staff-session.service.js';

const customer: Actor = {
  userId: 'customer',
  staffRoles: [],
  membership: { organizationId: 'own-shop', role: 'SELLER' },
};
const now = new Date('2026-10-24T10:00:00Z');
function fixture() {
  const user = { id: 'customer', status: 'ACTIVE', staffRoles: [] };
  const users = {
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})),
    lockById: vi.fn().mockResolvedValue(true),
    findById: vi.fn().mockResolvedValue(user),
    findActiveMemberships: vi
      .fn()
      .mockResolvedValue([
        { organizationId: 'own-shop', role: 'SELLER', organizationActive: true },
      ]),
  };
  const repository = {
    findCredentialByUserId: vi.fn().mockResolvedValue(null),
    upsertCredential: vi.fn().mockResolvedValue({}),
    findSessionByTokenHash: vi.fn().mockResolvedValue({
      id: 'session',
      userId: 'customer',
      sourceSessionId: null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60000),
      revokedAt: null,
    }),
    touchSession: vi.fn(),
  };
  const sessions = {
    find: vi.fn().mockResolvedValue({ method: 'PASSWORD' }),
    revokeAllForUser: vi.fn().mockResolvedValue(2),
  };
  const audit = { record: vi.fn() };
  const hasher = { hash: vi.fn().mockResolvedValue('hashed-secret') };
  const args = [
    users,
    repository,
    sessions,
    audit,
    { now: () => now },
    {},
    {},
    {},
    hasher,
    null,
    {},
    {},
  ] as unknown as ConstructorParameters<typeof StaffAuthService>;
  const auth = new StaffAuthService(...args);
  const sessionArgs = [
    repository,
    users,
    { now: () => now },
    {},
  ] as unknown as ConstructorParameters<typeof StaffSessionService>;
  return {
    auth,
    user,
    users,
    repository,
    sessions,
    audit,
    hasher,
    sessionService: new StaffSessionService(...sessionArgs),
  };
}
describe('customer website credentials and session authorization', () => {
  it('rejects password-authenticated credential changes before hashing or writing', async () => {
    const f = fixture();
    await expect(
      f.auth.setOwnCustomerCredentials(
        { ...customer, sessionId: 'session' },
        { login: 'my.shop', password: 'new customer secret' },
      ),
    ).rejects.toThrow('Sign in with Telegram');
    expect(f.hasher.hash).not.toHaveBeenCalled();
    expect(f.repository.upsertCredential).not.toHaveBeenCalled();
  });
  it('stores only the password hash, audits and revokes website sessions in the same transaction', async () => {
    const f = fixture();
    expect(
      await f.auth.setOwnCustomerCredentials(customer, {
        login: 'my.shop',
        password: 'new customer secret',
      }),
    ).toEqual({ login: 'my.shop' });
    expect(f.repository.upsertCredential).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        userId: 'customer',
        login: 'my.shop',
        passwordHash: 'hashed-secret',
      }),
    );
    expect(f.sessions.revokeAllForUser).toHaveBeenCalledWith({}, 'customer');
    expect(f.audit.record).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ actorUserId: 'customer', action: 'CUSTOMER_CREDENTIALS_SET' }),
    );
    expect(JSON.stringify(f.audit.record.mock.calls)).not.toContain('new customer secret');
  });
  it('rejects a customer whose organization became inactive before the write', async () => {
    const f = fixture();
    f.users.findActiveMemberships.mockResolvedValue([
      { organizationId: 'own-shop', role: 'SELLER', organizationActive: false },
    ]);
    await expect(
      f.auth.setOwnCustomerCredentials(customer, {
        login: 'my.shop',
        password: 'new customer secret',
      }),
    ).rejects.toThrow('Access denied');
    expect(f.repository.upsertCredential).not.toHaveBeenCalled();
  });
  it('builds a fresh own-organization actor for a website session and refuses lost membership', async () => {
    const f = fixture();
    const token = 'a'.repeat(43);
    expect(await f.sessionService.authenticate(token)).toEqual({
      ...customer,
      sessionId: 'session',
    });
    f.users.findActiveMemberships.mockResolvedValue([]);
    expect(await f.sessionService.authenticate(token)).toBeNull();
  });
  it('does not expose customer credential management to staff', async () => {
    const f = fixture();
    await expect(
      f.auth.ownCustomerCredentials({ userId: 'staff', staffRoles: ['MANAGER'] }),
    ).rejects.toThrow('Access denied');
  });
});
