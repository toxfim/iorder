import { meResponseSchema, type MeResponse } from '@iorder/shared';
import {
  staffCredentialsResponseSchema,
  staffCurrentSessionResponseSchema,
  staffSignInResponseSchema,
} from '@iorder/shared/staff-auth';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/modules/audit/index.js';
import { IdentityModule } from '../src/modules/identity/index.js';
import { PasswordHasher } from '../src/modules/identity/password-hasher.js';
import { SignInThrottle } from '../src/modules/identity/sign-in-guards.js';
import { StaffAuthRepository } from '../src/modules/identity/staff-auth.repository.js';
import { OrganizationsModule } from '../src/modules/organizations/index.js';
import { makeMember, makeOrganization, makeUser } from './support/identity-fixtures.js';
import { FAKE_BOT_TOKEN, signedInitData, tma } from './support/init-data.js';
import { signedLoginWidget } from './support/login-widget.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GOOD_PASSWORD = 'correct horse battery staple';

// Staff website sign-in (Login Widget, login + password), sessions, lockout and credentials
// management, on a real database through the production guard and resolver chain.
describe('staff website sessions (real PostgreSQL)', () => {
  let t: TestApp;
  // Cheap scrypt keeps the suite fast; the production parameters are pinned in the unit test.
  const hasher = new PasswordHasher({ N: 1024, r: 8, p: 1 });

  beforeAll(async () => {
    t = await createTestApp([IdentityModule, OrganizationsModule], {
      botToken: FAKE_BOT_TOKEN,
      overrides: [{ token: PasswordHasher, value: hasher }],
    });
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetIdentity(t.prisma);
    // A fresh hour: the in-process throttle windows and used-proof memory start empty.
    advance(HOUR);
  });

  function advance(ms: number): void {
    t.clock.set(new Date(t.clock.now().getTime() + ms));
  }
  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
  const tmaOf = (user: { telegramUserId: bigint }): Record<string, string> =>
    tma(signedInitData({ telegramUserId: user.telegramUserId, now: t.clock.now() }));
  const passwordLogin = (login: string, password: string) =>
    t.request('POST', '/auth/password-login', { body: { login, password } });
  const widgetLogin = (body: Record<string, string | number>) =>
    t.request('POST', '/auth/telegram-widget', { body });
  const widgetFor = (user: { telegramUserId: bigint }, ageSeconds = 0) =>
    signedLoginWidget({ telegramUserId: user.telegramUserId, now: t.clock.now(), ageSeconds });

  async function makeStaff(roles: Parameters<typeof makeUser>[1] = { staff: ['MANAGER'] }) {
    return makeUser(t.prisma, roles);
  }
  async function admin() {
    return makeUser(t.prisma, { staff: ['ADMIN'] });
  }
  /** Sets credentials through the real endpoint, as the given person. */
  function setCredentials(
    as: { telegramUserId: bigint },
    userId: string,
    body: Record<string, string>,
  ) {
    return t.request('PUT', `/staff/users/${userId}/credentials`, {
      headers: tmaOf(as),
      body,
    });
  }
  /** Staff member with login + password set by an admin; returns what the tests need. */
  async function staffWithPassword(
    login = 'alice',
    roles: Parameters<typeof makeUser>[1] = { staff: ['MANAGER'] },
  ) {
    const boss = await admin();
    const person = await makeStaff(roles);
    const res = await setCredentials(boss, person.id, { login, password: GOOD_PASSWORD });
    expect(res.status).toBe(200);
    return { boss, person };
  }
  async function signedIn(login = 'alice') {
    const res = await passwordLogin(login, GOOD_PASSWORD);
    expect(res.status).toBe(200);
    return staffSignInResponseSchema.parse(res.body);
  }

  describe('password sign-in', () => {
    it('signs a staff member in and the Bearer token works on the guarded routes', async () => {
      const { person } = await staffWithPassword('alice', { staff: ['MANAGER', 'ACCOUNTANT'] });
      const signIn = await signedIn();
      expect(signIn.me).toMatchObject({
        userId: person.id,
        staffRoles: ['MANAGER', 'ACCOUNTANT'],
        membership: null,
      });
      const headers = bearer(signIn.token);

      const me = await t.request('GET', '/me', { headers });
      // `/me` also tells a staff member what they are in the customer app ([C] 2026-11-09).
      expect(meResponseSchema.parse(me.body)).toEqual({
        ...signIn.me,
        staffViewer: { canOrder: false, organizationName: null },
      });
      expect((await t.request('GET', '/staff/users', { headers })).status).toBe(200);

      const session = staffCurrentSessionResponseSchema.parse(
        (await t.request('GET', '/auth/session', { headers })).body,
      );
      expect(session.me).toEqual(signIn.me);
      expect(session.session).toEqual(signIn.session);
      // 90 days absolute, 14 days idle (defaults, [C] 2026-11-09).
      const now = t.clock.now().getTime();
      expect(Date.parse(signIn.session.expiresAt)).toBe(now + 90 * DAY);
      expect(Date.parse(signIn.session.idleExpiresAt)).toBe(now + 14 * DAY);
    });

    it('keeps the permission matrix: a session of an accountant cannot reach manager routes', async () => {
      await staffWithPassword('acc', { staff: ['ACCOUNTANT'] });
      const { token } = await signedIn('acc');
      expect((await t.request('GET', '/staff/users', { headers: bearer(token) })).status).toBe(403);
    });

    it('treats the login case-insensitively', async () => {
      await staffWithPassword('alice');
      expect((await passwordLogin('  ALICE ', GOOD_PASSWORD)).status).toBe(200);
    });

    it('stores only the hash of the token, never the token', async () => {
      await staffWithPassword();
      const { token } = await signedIn();
      const rows = await t.prisma.$queryRaw<{ token_hash: string }[]>`
        SELECT token_hash FROM staff_sessions`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.token_hash).not.toBe(token);
      expect(JSON.stringify(rows)).not.toContain(token);
    });

    it('answers the same 401 for an unknown login, a wrong password, a customer, a blocked person and a person without roles', async () => {
      await staffWithPassword('alice');
      const org = await makeOrganization(t.prisma);
      const customer = await makeUser(t.prisma);
      await makeMember(t.prisma, org.id, customer.id, 'SELLER');
      const hash = await hasher.hash(GOOD_PASSWORD);
      // A customer who somehow holds a credential row (a former staff member): still no session.
      await t.prisma.staffCredential.create({
        data: {
          userId: customer.id,
          scope: 'STAFF',
          login: 'cust',
          passwordHash: hash,
          passwordChangedAt: t.clock.now(),
        },
      });
      const blocked = await makeStaff({ staff: ['MANAGER'], status: 'BLOCKED' });
      await t.prisma.staffCredential.create({
        data: {
          userId: blocked.id,
          scope: 'STAFF',
          login: 'blocked',
          passwordHash: hash,
          passwordChangedAt: t.clock.now(),
        },
      });
      const noRoles = await makeUser(t.prisma);
      await t.prisma.staffCredential.create({
        data: {
          userId: noRoles.id,
          scope: 'STAFF',
          login: 'noroles',
          passwordHash: hash,
          passwordChangedAt: t.clock.now(),
        },
      });

      const attempts: [string, string][] = [
        ['nobody', GOOD_PASSWORD],
        ['alice', 'wrong password here'],
        ['cust', GOOD_PASSWORD],
        ['blocked', GOOD_PASSWORD],
        ['noroles', GOOD_PASSWORD],
      ];
      const bodies = new Set<string>();
      for (const [login, password] of attempts) {
        const res = await passwordLogin(login, password);
        expect(res.status, login).toBe(401);
        bodies.add(JSON.stringify(res.body));
      }
      expect(bodies.size).toBe(1);
      expect(await t.prisma.staffSession.count()).toBe(0);
      // The real person is untouched by the wrong-password counter of the others.
      expect((await passwordLogin('alice', GOOD_PASSWORD)).status).toBe(200);
    });

    it('answers byte-identical 401 bodies for every failure cause, password and widget alike', async () => {
      const person = await makeStaff();
      await staffWithPassword('alice');
      const blocked = await makeStaff({ staff: ['MANAGER'], status: 'BLOCKED' });
      const customer = await makeUser(t.prisma);
      const raws = new Set<string>();
      const seen: number[] = [];
      const note = (res: { status: number; raw: string }) => {
        seen.push(res.status);
        raws.add(res.raw);
      };
      note(await passwordLogin('nobody', GOOD_PASSWORD));
      note(await passwordLogin('alice', 'wrong password here'));
      note(await widgetLogin({ ...widgetFor(person), hash: '0'.repeat(64) }));
      note(await widgetLogin(widgetFor({ telegramUserId: 424242n })));
      note(await widgetLogin(widgetFor(blocked)));
      note(await widgetLogin(widgetFor(customer)));
      const good = widgetFor(person);
      expect((await widgetLogin(good)).status).toBe(200);
      note(await widgetLogin(good));
      expect(seen.every((status) => status === 401)).toBe(true);
      expect(raws.size).toBe(1);
    });

    it('rejects an unknown field and answers 422 for a malformed body', async () => {
      expect(
        (
          await t.request('POST', '/auth/password-login', {
            body: { login: 'a', password: 'b', remember: true },
          })
        ).status,
      ).toBe(422);
      expect(
        (await t.request('POST', '/auth/password-login', { body: { login: 'a' } })).status,
      ).toBe(422);
    });
  });

  describe('lockout and rate limit', () => {
    it('locks the login after five wrong passwords, even for the right password, then recovers', async () => {
      await staffWithPassword();
      for (let i = 0; i < 5; i += 1) {
        expect((await passwordLogin('alice', 'wrong password here')).status).toBe(401);
      }
      const locked = await passwordLogin('alice', GOOD_PASSWORD);
      expect(locked.status).toBe(401);
      const credential = await t.prisma.staffCredential.findFirstOrThrow();
      expect(credential.failedAttempts).toBe(5);
      expect(credential.lockedUntil?.getTime()).toBe(t.clock.now().getTime() + 60_000);

      // Locked attempts are not counted (hammering cannot extend the lock) and, like anonymous
      // failures, are written as at most one audit row per minute: hammering a lock costs the
      // attacker nothing, so it must not grow the append-only log either.
      for (let i = 0; i < 3; i += 1) {
        expect((await passwordLogin('alice', 'wrong password here')).status).toBe(401);
      }
      expect((await t.prisma.staffCredential.findFirstOrThrow()).failedAttempts).toBe(5);
      const credentialRow = await t.prisma.staffCredential.findFirstOrThrow();
      const lockedRows = (
        await t.prisma.auditLog.findMany({
          where: {
            action: 'AUTH_SIGN_IN_FAILED',
            entityType: 'USER',
            entityId: credentialRow.userId,
          },
        })
      ).filter((r) => (r.diff as { reason: { to: string } }).reason.to === 'LOCKED');
      expect(lockedRows).toHaveLength(1);
      expect(lockedRows[0]?.diff).toMatchObject({ count: { from: null, to: 1 } });

      advance(61_000);
      expect((await passwordLogin('alice', GOOD_PASSWORD)).status).toBe(200);
      const after = await t.prisma.staffCredential.findFirstOrThrow();
      expect(after.failedAttempts).toBe(0);
      expect(after.lockedUntil).toBeNull();
    });

    it('starts a new round once a lock was served: one stray guess does not re-lock the login', async () => {
      await staffWithPassword();
      for (let i = 0; i < 5; i += 1) await passwordLogin('alice', 'wrong password here');
      advance(61_000);
      await passwordLogin('alice', 'wrong password here');
      const credential = await t.prisma.staffCredential.findFirstOrThrow();
      expect(credential.failedAttempts).toBe(1);
      expect(credential.lockedUntil).toBeNull();
      expect((await passwordLogin('alice', GOOD_PASSWORD)).status).toBe(200);
    });

    it('forgets old failures after 30 quiet minutes, but not before', async () => {
      await staffWithPassword();
      for (let i = 0; i < 4; i += 1) await passwordLogin('alice', 'wrong password here');
      advance(29 * 60_000);
      await passwordLogin('alice', 'wrong password here');
      // Fifth within the decay window: locked.
      expect((await t.prisma.staffCredential.findFirstOrThrow()).failedAttempts).toBe(5);

      await t.prisma.staffCredential.updateMany({
        data: { failedAttempts: 4, lockedUntil: null, lastFailedAt: t.clock.now() },
      });
      advance(31 * 60_000);
      await passwordLogin('alice', 'wrong password here');
      const credential = await t.prisma.staffCredential.findFirstOrThrow();
      expect(credential.failedAttempts).toBe(1);
      expect(credential.lockedUntil).toBeNull();
    });

    it('counts two parallel wrong passwords one by one (no lost update) and locks at the threshold', async () => {
      await staffWithPassword();
      for (let i = 0; i < 3; i += 1) await passwordLogin('alice', 'wrong password here');
      const results = await Promise.all([
        passwordLogin('alice', 'wrong password one'),
        passwordLogin('alice', 'wrong password two'),
      ]);
      expect(results.map((r) => r.status)).toEqual([401, 401]);
      const credential = await t.prisma.staffCredential.findFirstOrThrow();
      expect(credential.failedAttempts).toBe(5);
      expect(credential.lockedUntil?.getTime()).toBe(t.clock.now().getTime() + 60_000);
      expect((await passwordLogin('alice', GOOD_PASSWORD)).status).toBe(401);
    });

    it('two parallel wrong passwords at the threshold never lose a count', async () => {
      await staffWithPassword();
      for (let i = 0; i < 4; i += 1) await passwordLogin('alice', 'wrong password here');
      const results = await Promise.all([
        passwordLogin('alice', 'wrong password one'),
        passwordLogin('alice', 'wrong password two'),
      ]);
      expect(results.map((r) => r.status)).toEqual([401, 401]);
      const credential = await t.prisma.staffCredential.findFirstOrThrow();
      // 6 when both raced past the lock check, 5 when the second saw the fresh lock first.
      expect(credential.failedAttempts).toBeGreaterThanOrEqual(5);
      expect(credential.lockedUntil).not.toBeNull();
    });

    it('answers 429 early, before any database work, once the service saw 300 failures in a minute', async () => {
      const throttle = t.get(SignInThrottle);
      for (let i = 0; i < 300; i += 1) throttle.noteFailure(t.clock.now().getTime());
      const repository = t.get(StaffAuthRepository);
      const lookup = vi.spyOn(repository, 'findCredentialByLogin');
      const res = await passwordLogin('alice', GOOD_PASSWORD);
      expect(res.status).toBe(429);
      expect((await widgetLogin(widgetFor({ telegramUserId: 999n }))).status).toBe(429);
      expect(lookup).not.toHaveBeenCalled();
      lookup.mockRestore();
    });

    it('answers 429 after 10 attempts for the same login from one address, naming nothing', async () => {
      for (let i = 0; i < 10; i += 1) {
        expect((await passwordLogin('ghost', 'whatever password')).status).toBe(401);
      }
      const limited = await passwordLogin('ghost', 'whatever password');
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(JSON.stringify(limited.body)).not.toContain('ghost');
      // An existing login is throttled identically, so the 429 reveals nothing.
      await staffWithPassword('alice');
      for (let i = 0; i < 10; i += 1) await passwordLogin('alice', 'wrong password here');
      expect((await passwordLogin('alice', GOOD_PASSWORD)).status).toBe(429);
    });

    it('does not count successful sign-ins toward the per login budget (12 successes, then another)', async () => {
      await staffWithPassword('alice');
      for (let i = 0; i < 12; i += 1) {
        expect((await passwordLogin('alice', GOOD_PASSWORD)).status).toBe(200);
      }
      expect((await passwordLogin('alice', GOOD_PASSWORD)).status).toBe(200);
    });

    it('still counts failures after successes: the 429 arrives at the 11th failed attempt', async () => {
      for (let i = 0; i < 12; i += 1) {
        expect((await passwordLogin('ghost', 'whatever password')).status).toBe(i < 10 ? 401 : 429);
      }
      await staffWithPassword('alice');
      // alice has her own budget; her successes are free and a ghost spree does not touch it.
      expect((await passwordLogin('alice', GOOD_PASSWORD)).status).toBe(200);
      expect((await passwordLogin('ghost', 'whatever password')).status).toBe(429);
    });
  });

  describe('Telegram Login Widget', () => {
    it('signs in a staff member whose Telegram id is known', async () => {
      const person = await makeStaff({ staff: ['WAREHOUSE_MANAGER'] });
      const res = await widgetLogin(widgetFor(person));
      expect(res.status).toBe(200);
      const body = staffSignInResponseSchema.parse(res.body);
      expect(body.me).toMatchObject({ userId: person.id, staffRoles: ['WAREHOUSE_MANAGER'] });
      expect((await t.request('GET', '/me', { headers: bearer(body.token) })).status).toBe(200);
      const row = await t.prisma.staffSession.findFirstOrThrow();
      expect(row.method).toBe('TELEGRAM_WIDGET');
    });

    it('rejects a bad signature, a stale proof, an extra field and a replay, all with one 401', async () => {
      const person = await makeStaff();
      const good = widgetFor(person);
      const bodies = new Set<string>();
      const cases: Record<string, Record<string, string | number>> = {
        'wrong token': signedLoginWidget({
          telegramUserId: person.telegramUserId,
          now: t.clock.now(),
          token: '1:other-fake-token',
        }),
        tampered: { ...good, id: Number(person.telegramUserId) + 1 },
        stale: widgetFor(person, 301),
        future: widgetFor(person, -3600),
      };
      for (const [name, payload] of Object.entries(cases)) {
        const res = await widgetLogin(payload);
        expect(res.status, name).toBe(401);
        bodies.add(JSON.stringify(res.body));
      }
      // An unknown field is refused at the boundary, before any signature work.
      expect((await widgetLogin({ ...good, is_admin: 1 })).status).toBe(422);

      expect((await widgetLogin(good)).status).toBe(200);
      const replay = await widgetLogin(good);
      expect(replay.status).toBe(401);
      bodies.add(JSON.stringify(replay.body));
      expect(bodies.size).toBe(1);
      expect(await t.prisma.staffSession.count()).toBe(1);
    });

    it('gives no session to a customer, a stranger or a blocked staff member', async () => {
      const org = await makeOrganization(t.prisma);
      const customer = await makeUser(t.prisma);
      await makeMember(t.prisma, org.id, customer.id, 'SHOP_OWNER');
      const blocked = await makeStaff({ staff: ['ADMIN'], status: 'BLOCKED' });
      const stranger = { telegramUserId: 999_999_999_999n };
      const bodies = new Set<string>();
      for (const who of [customer, blocked, stranger]) {
        const res = await widgetLogin(widgetFor(who));
        expect(res.status).toBe(401);
        bodies.add(JSON.stringify(res.body));
      }
      expect(bodies.size).toBe(1);
      expect(await t.prisma.staffSession.count()).toBe(0);
    });

    it('is closed when no bot token is configured', async () => {
      const closed = await createTestApp([IdentityModule], {
        overrides: [{ token: PasswordHasher, value: hasher }],
      });
      try {
        const person = await makeStaff();
        const res = await closed.request('POST', '/auth/telegram-widget', {
          body: signedLoginWidget({
            telegramUserId: person.telegramUserId,
            now: closed.clock.now(),
          }),
        });
        expect(res.status).toBe(401);
      } finally {
        await closed.close();
      }
    });

    it('with STAFF_LOGIN_BOT_TOKEN: the staff site accepts only the login bot, the customer site only the main bot', async () => {
      const LOGIN_BOT_TOKEN = '7000000000:STAFF-LOGIN-BOT-TOKEN-FOR-TESTS';
      const twoBots = await createTestApp([IdentityModule, OrganizationsModule], {
        botToken: FAKE_BOT_TOKEN,
        env: { STAFF_LOGIN_BOT_TOKEN: LOGIN_BOT_TOKEN },
        overrides: [{ token: PasswordHasher, value: hasher }],
      });
      try {
        const person = await makeStaff();
        const proof = (token: string) =>
          signedLoginWidget({
            telegramUserId: person.telegramUserId,
            now: twoBots.clock.now(),
            token,
          });
        const staffSite = (token: string) =>
          twoBots.request('POST', '/auth/telegram-widget', { body: proof(token) });
        // Signed by the main bot: refused on the staff site (its widget is the login bot).
        expect((await staffSite(FAKE_BOT_TOKEN)).status).toBe(401);
        expect((await staffSite(LOGIN_BOT_TOKEN)).status).toBe(200);
        // The customer site still verifies with the main bot only.
        const customerSite = await twoBots.request('POST', '/customer/auth/telegram-widget', {
          body: proof(LOGIN_BOT_TOKEN),
        });
        expect(customerSite.status).toBe(401);
      } finally {
        await twoBots.close();
      }
    });
  });

  describe('sessions', () => {
    it('are not accepted when revoked by logout, and logout answers 204', async () => {
      await staffWithPassword();
      const { token } = await signedIn();
      const out = await t.request('POST', '/auth/logout', { headers: bearer(token) });
      expect(out.status).toBe(204);
      expect((await t.request('GET', '/me', { headers: bearer(token) })).status).toBe(401);
      expect((await t.request('GET', '/auth/session', { headers: bearer(token) })).status).toBe(
        401,
      );
      expect((await t.prisma.staffSession.findFirstOrThrow()).revokedAt).not.toBeNull();
    });

    // [C] 2026-11-09: whoever opens the site at least once in two weeks is not asked to sign in
    // again; a session left alone for two weeks ends, and none outlives the absolute limit.
    it('dies after 14 days without use, but a session opened every 13 days keeps going until 90 days', async () => {
      await staffWithPassword();
      const idle = await signedIn();
      advance(14 * DAY - 1000);
      expect((await t.request('GET', '/me', { headers: bearer(idle.token) })).status).toBe(200);

      // A different session left alone: dead at the idle limit.
      const other = await signedIn();
      advance(14 * DAY);
      expect((await t.request('GET', '/me', { headers: bearer(other.token) })).status).toBe(401);

      // Opened once every 13 days: alive until the absolute limit, then dead.
      const busy = await signedIn();
      for (let i = 0; i < 6; i += 1) {
        advance(13 * DAY);
        const res = await t.request('GET', '/me', { headers: bearer(busy.token) });
        expect(res.status, `after ${(i + 1) * 13} days`).toBe(200);
      }
      advance(12 * DAY); // 90 days
      expect((await t.request('GET', '/me', { headers: bearer(busy.token) })).status).toBe(401);
    });

    it('moves last_seen_at at most every few minutes, not on every request', async () => {
      await staffWithPassword();
      const { token } = await signedIn();
      const first = (await t.prisma.staffSession.findFirstOrThrow()).lastSeenAt.getTime();
      advance(60_000);
      await t.request('GET', '/me', { headers: bearer(token) });
      expect((await t.prisma.staffSession.findFirstOrThrow()).lastSeenAt.getTime()).toBe(first);
      advance(5 * 60_000);
      await t.request('GET', '/me', { headers: bearer(token) });
      expect((await t.prisma.staffSession.findFirstOrThrow()).lastSeenAt.getTime()).toBe(
        t.clock.now().getTime(),
      );
    });

    it('answer one identical 401 for garbage, unknown, wrong-scheme and missing tokens', async () => {
      await staffWithPassword();
      const { token } = await signedIn();
      const wrongScheme = { authorization: `Token ${token}` };
      const bodies = new Set<string>();
      for (const headers of [
        {},
        wrongScheme,
        bearer('short'),
        bearer('a'.repeat(43)),
        bearer(`${token}x`),
        bearer(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')),
      ]) {
        const res = await t.request('GET', '/me', { headers });
        expect(res.status).toBe(401);
        bodies.add(JSON.stringify(res.body));
      }
      expect(bodies.size).toBe(1);
    });

    // Customers may hold website sessions since 2026-10-24 (customer-website-auth.md), but only
    // while they belong to exactly one ACTIVE organization: membership is re-read on every request.
    it('resolve a non-staff user only while they are a member of an ACTIVE organization', async () => {
      const plantSession = async (userId: string, seed: string): Promise<string> => {
        const token = seed.repeat(43);
        await t.prisma.staffSession.create({
          data: {
            userId,
            tokenHash: createHash('sha256').update(token).digest('hex'),
            method: 'PASSWORD',
            createdAt: t.clock.now(),
            lastSeenAt: t.clock.now(),
            expiresAt: new Date(t.clock.now().getTime() + HOUR),
          },
        });
        return token;
      };
      const activeOrg = await makeOrganization(t.prisma);
      const inactiveOrg = await makeOrganization(t.prisma, { status: 'INACTIVE' });

      const member = await makeUser(t.prisma);
      await makeMember(t.prisma, activeOrg.id, member.id, 'SELLER');
      const nobody = await makeUser(t.prisma);
      const leaver = await makeUser(t.prisma);
      await makeMember(t.prisma, activeOrg.id, leaver.id, 'SELLER', 'LEFT');
      const inactiveMember = await makeUser(t.prisma);
      await makeMember(t.prisma, inactiveOrg.id, inactiveMember.id, 'SHOP_OWNER');

      const memberToken = await plantSession(member.id, 'c');
      expect((await t.request('GET', '/me', { headers: bearer(memberToken) })).status).toBe(200);
      for (const [userId, seed] of [
        [nobody.id, 'd'],
        [leaver.id, 'e'],
        [inactiveMember.id, 'f'],
      ] as const) {
        const token = await plantSession(userId, seed);
        expect((await t.request('GET', '/me', { headers: bearer(token) })).status).toBe(401);
      }
    });

    it('lets a Mini App caller read GET /auth/session with a null session', async () => {
      const person = await makeStaff();
      const res = await t.request('GET', '/auth/session', { headers: tmaOf(person) });
      expect(res.status).toBe(200);
      expect(staffCurrentSessionResponseSchema.parse(res.body).session).toBeNull();
      expect((await t.request('POST', '/auth/logout', { headers: tmaOf(person) })).status).toBe(
        204,
      );
    });

    it('still lets a customer in through the Mini App, and only that way', async () => {
      const org = await makeOrganization(t.prisma);
      const customer = await makeUser(t.prisma);
      await makeMember(t.prisma, org.id, customer.id, 'SELLER');
      const res = await t.request('GET', '/me', { headers: tmaOf(customer) });
      expect(res.status).toBe(200);
      expect((res.body as MeResponse).membership?.organizationId).toBe(org.id);
    });
  });

  describe('revocation', () => {
    it("ends a person's sessions when their last staff role is removed, not when another remains", async () => {
      const boss = await admin();
      const { person } = await staffWithPassword('alice', { staff: ['MANAGER', 'ACCOUNTANT'] });
      const { token } = await signedIn();

      const first = await t.request('DELETE', `/staff/users/${person.id}/roles/ACCOUNTANT`, {
        headers: tmaOf(boss),
      });
      expect(first.status).toBe(200);
      expect((await t.request('GET', '/me', { headers: bearer(token) })).status).toBe(200);

      const last = await t.request('DELETE', `/staff/users/${person.id}/roles/MANAGER`, {
        headers: tmaOf(boss),
      });
      expect(last.status).toBe(200);
      expect((await t.request('GET', '/me', { headers: bearer(token) })).status).toBe(401);
      expect((await t.prisma.staffSession.findFirstOrThrow()).revokedAt).not.toBeNull();
      const audit = await t.prisma.auditLog.findMany({
        where: { action: 'STAFF_SESSIONS_REVOKED' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorUserId).toBe(boss.id);
    });

    it('ends sessions when the person is blocked, and keeps them out after unblocking', async () => {
      const boss = await admin();
      const { person } = await staffWithPassword();
      const { token } = await signedIn();
      expect(
        (await t.request('POST', `/staff/users/${person.id}/block`, { headers: tmaOf(boss) }))
          .status,
      ).toBe(200);
      expect((await t.request('GET', '/me', { headers: bearer(token) })).status).toBe(401);
      expect(
        (await t.request('POST', `/staff/users/${person.id}/unblock`, { headers: tmaOf(boss) }))
          .status,
      ).toBe(200);
      // The old token stays dead; a fresh sign-in is needed.
      expect((await t.request('GET', '/me', { headers: bearer(token) })).status).toBe(401);
      expect((await passwordLogin('alice', GOOD_PASSWORD)).status).toBe(200);
    });
  });

  // The two-week lifetime ([C] 2026-11-09) must not weaken any way a session ends: each one still
  // works on a session that has been alive for ten days.
  describe('revocation of a session that has lived for ten days', () => {
    async function tenDayOldSession() {
      const made = await staffWithPassword();
      const { token } = await signedIn();
      for (let day = 0; day < 10; day += 1) {
        advance(DAY);
        expect((await t.request('GET', '/me', { headers: bearer(token) })).status).toBe(200);
      }
      return { ...made, token };
    }
    const isDead = async (token: string): Promise<void> => {
      expect((await t.request('GET', '/me', { headers: bearer(token) })).status).toBe(401);
      expect((await t.request('GET', '/staff/users', { headers: bearer(token) })).status).toBe(401);
    };

    it('sign-out', async () => {
      const { token } = await tenDayOldSession();
      expect((await t.request('POST', '/auth/logout', { headers: bearer(token) })).status).toBe(
        204,
      );
      await isDead(token);
    });

    it('a blocked person', async () => {
      const { boss, person, token } = await tenDayOldSession();
      const block = await t.request('POST', `/staff/users/${person.id}/block`, {
        headers: tmaOf(boss),
      });
      expect(block.status).toBe(200);
      await isDead(token);
    });

    it('the loss of the last staff role', async () => {
      const { boss, person, token } = await tenDayOldSession();
      const removed = await t.request('DELETE', `/staff/users/${person.id}/roles/MANAGER`, {
        headers: tmaOf(boss),
      });
      expect(removed.status).toBe(200);
      await isDead(token);
    });

    it('a new password', async () => {
      const { boss, person, token } = await tenDayOldSession();
      const reset = await setCredentials(boss, person.id, { password: 'a brand new password' });
      expect(reset.status).toBe(200);
      await isDead(token);
    });
  });

  describe('credentials management', () => {
    it('lets a manager set a password for an accountant and never returns the password or hash', async () => {
      const manager = await makeStaff({ staff: ['MANAGER'] });
      const accountant = await makeStaff({ staff: ['ACCOUNTANT'] });
      const res = await setCredentials(manager, accountant.id, {
        login: 'acc.one',
        password: GOOD_PASSWORD,
      });
      expect(res.status).toBe(200);
      const body = staffCredentialsResponseSchema.parse(res.body);
      expect(body).toMatchObject({ userId: accountant.id, login: 'acc.one' });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(GOOD_PASSWORD);
      expect(text).not.toContain('scrypt');
      const stored = await t.prisma.staffCredential.findFirstOrThrow();
      expect(stored.passwordHash).toMatch(/^scrypt\$v1\$/);
      expect(stored.passwordHash).not.toContain(GOOD_PASSWORD);
      expect((await passwordLogin('acc.one', GOOD_PASSWORD)).status).toBe(200);
    });

    it('refuses a manager changing an administrator, and everyone who is not manager or admin', async () => {
      const boss = await admin();
      const manager = await makeStaff({ staff: ['MANAGER'] });
      expect(
        (await setCredentials(manager, boss.id, { login: 'boss', password: GOOD_PASSWORD })).status,
      ).toBe(403);
      expect(await t.prisma.staffCredential.count()).toBe(0);
      // An admin may change a manager; a person holding BOTH roles counts as an administrator.
      const both = await makeStaff({ staff: ['MANAGER', 'ADMIN'] });
      expect(
        (await setCredentials(manager, both.id, { login: 'both', password: GOOD_PASSWORD })).status,
      ).toBe(403);
      expect(
        (await setCredentials(boss, manager.id, { login: 'mgr', password: GOOD_PASSWORD })).status,
      ).toBe(200);

      const target = await makeStaff({ staff: ['DRIVER'] });
      for (const role of ['ACCOUNTANT', 'WAREHOUSE_MANAGER', 'DRIVER'] as const) {
        const other = await makeStaff({ staff: [role] });
        const res = await setCredentials(other, target.id, {
          login: 'drv',
          password: GOOD_PASSWORD,
        });
        expect(res.status, role).toBe(403);
      }
      const org = await makeOrganization(t.prisma);
      const customer = await makeUser(t.prisma);
      await makeMember(t.prisma, org.id, customer.id, 'SHOP_OWNER');
      expect(
        (await setCredentials(customer, target.id, { login: 'drv', password: GOOD_PASSWORD }))
          .status,
      ).toBe(403);
      // Sessions give no extra power: a session of an accountant is refused the same way.
      await staffWithPassword('acc', { staff: ['ACCOUNTANT'] });
      const { token } = await signedIn('acc');
      const viaSession = await t.request('PUT', `/staff/users/${target.id}/credentials`, {
        headers: bearer(token),
        body: { login: 'drv', password: GOOD_PASSWORD },
      });
      expect(viaSession.status).toBe(403);
    });

    it('refuses a blocked target with the same answer as any other refusal', async () => {
      const boss = await admin();
      const blocked = await makeStaff({ staff: ['MANAGER'], status: 'BLOCKED' });
      const adminTarget = await admin();
      const manager = await makeStaff();
      const blockedRes = await t.request('PUT', `/staff/users/${blocked.id}/credentials`, {
        headers: tmaOf(boss),
        body: { login: 'blk', password: GOOD_PASSWORD },
      });
      const adminRes = await t.request('PUT', `/staff/users/${adminTarget.id}/credentials`, {
        headers: tmaOf(manager),
        body: { login: 'adm', password: GOOD_PASSWORD },
      });
      expect(blockedRes.status).toBe(403);
      expect(blockedRes.raw).toBe(adminRes.raw);
      expect(await t.prisma.staffCredential.count({ where: { userId: blocked.id } })).toBe(0);
    });

    it('validates input: short password, bad login, unknown field, customer target, taken login', async () => {
      const boss = await admin();
      const person = await makeStaff();
      const other = await makeStaff();
      const call = (body: Record<string, string>, id = person.id) => setCredentials(boss, id, body);
      expect((await call({ login: 'abc', password: 'short' })).status).toBe(422);
      expect((await call({ login: 'Bad Login', password: GOOD_PASSWORD })).status).toBe(422);
      expect((await call({ login: 'abc', password: GOOD_PASSWORD, role: 'ADMIN' })).status).toBe(
        422,
      );
      expect((await call({})).status).toBe(422);
      // First time: both are needed.
      expect((await call({ password: GOOD_PASSWORD })).status).toBe(422);
      expect((await call({ login: 'abc' })).status).toBe(422);
      expect((await call({ login: 'abc', password: 'ABC' + 'x'.repeat(9) })).status).toBe(200);
      expect((await call({ login: 'abc', password: GOOD_PASSWORD }, other.id)).status).toBe(422);
      // Password equal to login is refused.
      expect(
        (await call({ login: 'same-as-login', password: 'same-as-login' }, other.id)).status,
      ).toBe(422);
      // A customer has no website credentials.
      const org = await makeOrganization(t.prisma);
      const customer = await makeUser(t.prisma);
      await makeMember(t.prisma, org.id, customer.id, 'SELLER');
      expect((await call({ login: 'cust', password: GOOD_PASSWORD }, customer.id)).status).toBe(
        422,
      );
      expect(
        (
          await call(
            { login: 'ghost', password: GOOD_PASSWORD },
            '0198f4a4-0000-7000-8000-000000000000',
          )
        ).status,
      ).toBe(404);
    });

    it("a reset ends the person's sessions, clears the lockout and changes only what was sent", async () => {
      const { boss, person } = await staffWithPassword();
      const { token } = await signedIn();
      for (let i = 0; i < 5; i += 1) await passwordLogin('alice', 'wrong password here');
      expect((await t.prisma.staffCredential.findFirstOrThrow()).lockedUntil).not.toBeNull();

      const reset = await setCredentials(boss, person.id, { password: 'a brand new password' });
      expect(reset.status).toBe(200);
      expect((await t.request('GET', '/me', { headers: bearer(token) })).status).toBe(401);
      const stored = await t.prisma.staffCredential.findFirstOrThrow();
      expect(stored.lockedUntil).toBeNull();
      expect(stored.failedAttempts).toBe(0);
      expect(stored.login).toBe('alice');
      expect((await passwordLogin('alice', GOOD_PASSWORD)).status).toBe(401);
      const fresh = await passwordLogin('alice', 'a brand new password');
      expect(fresh.status).toBe(200);

      // A login-only change keeps the password and the sessions.
      const live = staffSignInResponseSchema.parse(fresh.body);
      const rename = await setCredentials(boss, person.id, { login: 'alice2' });
      expect(rename.status).toBe(200);
      expect((await t.request('GET', '/me', { headers: bearer(live.token) })).status).toBe(200);
      expect((await passwordLogin('alice2', 'a brand new password')).status).toBe(200);
    });
  });

  describe('audit trail', () => {
    it('records sign-in, failure, logout and credentials, and never a secret', async () => {
      const { boss, person } = await staffWithPassword();
      await passwordLogin('alice', 'a wrong password!');
      await passwordLogin('nobody', 'password-typed-as-login');
      const signIn = await signedIn();
      await t.request('POST', '/auth/logout', { headers: bearer(signIn.token) });

      const rows = await t.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      const by = (action: string) => rows.filter((r) => r.action === action);
      expect(by('STAFF_CREDENTIALS_SET')).toHaveLength(1);
      expect(by('STAFF_CREDENTIALS_SET')[0]).toMatchObject({
        actorUserId: boss.id,
        entityType: 'USER',
        entityId: person.id,
      });
      expect(by('STAFF_SESSION_CREATED')).toHaveLength(1);
      expect(by('STAFF_SESSION_CREATED')[0]?.actorUserId).toBe(person.id);
      expect(by('STAFF_SESSION_REVOKED')).toHaveLength(1);
      const failures = by('AUTH_SIGN_IN_FAILED');
      expect(failures).toHaveLength(2);
      for (const failure of failures) expect(failure.actorUserId).toBeNull();
      const reasons = failures.map((f) => (f.diff as { reason: { to: string } }).reason.to).sort();
      expect(reasons).toEqual(['BAD_PASSWORD', 'UNKNOWN_LOGIN']);

      const everything = JSON.stringify(rows);
      for (const secret of [
        GOOD_PASSWORD,
        'a wrong password!',
        'password-typed-as-login',
        'scrypt$',
        signIn.token,
        FAKE_BOT_TOKEN,
        '127.0.0.1',
      ]) {
        expect(everything, secret).not.toContain(secret);
      }
    });

    it('writes at most one aggregated row per reason and minute for failures with no known account', async () => {
      for (let i = 0; i < 50; i += 1) {
        expect((await passwordLogin(`ghost${i}`, 'whatever password')).status).toBe(401);
      }
      const unknownRows = async () =>
        (await t.prisma.auditLog.findMany({ where: { action: 'AUTH_SIGN_IN_FAILED' } })).filter(
          (r) => (r.diff as { reason: { to: string } }).reason.to === 'UNKNOWN_LOGIN',
        );
      const first = await unknownRows();
      expect(first).toHaveLength(1);
      expect(first[0]?.diff).toMatchObject({ count: { to: 1 } });

      // The next minute: one more row, which also reports the 50 attempts of the previous one.
      advance(61_000);
      await passwordLogin('ghost-again', 'whatever password');
      const second = await unknownRows();
      expect(second).toHaveLength(2);
      expect(second.map((r) => JSON.stringify(r.diff)).join()).toContain('"previousBucketCount"');
      const report = second
        .map((r) => r.diff as { previousBucketCount?: { to: number } })
        .find((d) => d.previousBucketCount);
      expect(report?.previousBucketCount?.to).toBe(50);
    });

    it('keeps a full row for every failure of a KNOWN account', async () => {
      await staffWithPassword();
      for (let i = 0; i < 3; i += 1) await passwordLogin('alice', 'wrong password here');
      const rows = await t.prisma.auditLog.findMany({
        where: { action: 'AUTH_SIGN_IN_FAILED', entityType: 'USER' },
      });
      expect(rows).toHaveLength(3);
    });

    it('writes the session and its audit row in ONE transaction: a failing audit leaves no session', async () => {
      await staffWithPassword();
      const audit = t.get(AuditService);
      const spy = vi.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit down'));
      try {
        const res = await passwordLogin('alice', GOOD_PASSWORD);
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain('audit down');
      } finally {
        spy.mockRestore();
      }
      expect(await t.prisma.staffSession.count()).toBe(0);
      expect((await passwordLogin('alice', GOOD_PASSWORD)).status).toBe(200);
    });

    it('writes the credentials and their audit row in ONE transaction', async () => {
      const boss = await admin();
      const person = await makeStaff();
      const spy = vi
        .spyOn(t.get(AuditService), 'record')
        .mockRejectedValueOnce(new Error('audit down'));
      try {
        const res = await setCredentials(boss, person.id, {
          login: 'alice',
          password: GOOD_PASSWORD,
        });
        expect(res.status).toBe(500);
      } finally {
        spy.mockRestore();
      }
      expect(await t.prisma.staffCredential.count()).toBe(0);
    });

    it('counts a wrong password and records it together (no counted failure without an audit row)', async () => {
      await staffWithPassword();
      const spy = vi
        .spyOn(t.get(AuditService), 'recordSystem')
        .mockRejectedValueOnce(new Error('audit down'));
      try {
        expect((await passwordLogin('alice', 'wrong password here')).status).toBe(500);
      } finally {
        spy.mockRestore();
      }
      expect((await t.prisma.staffCredential.findFirstOrThrow()).failedAttempts).toBe(0);
    });
  });

  describe('database guards', () => {
    it('refuses to change what identifies a session or to un-revoke one', async () => {
      await staffWithPassword();
      await signedIn();
      const row = await t.prisma.staffSession.findFirstOrThrow();
      await expect(
        t.prisma
          .$executeRaw`UPDATE staff_sessions SET expires_at = expires_at + interval '1 day' WHERE id = ${row.id}::uuid`,
      ).rejects.toThrow(/only last_seen_at and revoked_at/);
      await expect(
        t.prisma.$executeRaw`DELETE FROM staff_sessions WHERE id = ${row.id}::uuid`,
      ).rejects.toThrow(/cannot be deleted/);
      await t.prisma
        .$executeRaw`UPDATE staff_sessions SET revoked_at = now() WHERE id = ${row.id}::uuid`;
      await expect(
        t.prisma
          .$executeRaw`UPDATE staff_sessions SET revoked_at = NULL WHERE id = ${row.id}::uuid`,
      ).rejects.toThrow(/revoked staff session cannot be changed/);
    });

    it('accepts only a well-formed login and a scrypt-shaped hash', async () => {
      const person = await makeStaff();
      const create = (login: string, passwordHash: string) =>
        t.prisma.staffCredential.create({
          data: {
            userId: person.id,
            scope: 'STAFF',
            login,
            passwordHash,
            passwordChangedAt: t.clock.now(),
          },
        });
      await expect(create('Bad Login', await hasher.hash(GOOD_PASSWORD))).rejects.toThrow(
        /login_format/,
      );
      await expect(create('fine', 'plaintext-password')).rejects.toThrow(/hash_format/);
    });
  });
});
