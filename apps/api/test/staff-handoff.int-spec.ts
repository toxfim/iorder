import {
  customerHandoffPageResponseSchema,
  customerSignInResponseSchema,
  HANDOFF_CODE_PATTERN,
  HANDOFF_FRAGMENT_PARAM,
  meResponseSchema,
} from '@iorder/shared';
import {
  customerSiteHandoffResponseSchema,
  customerSiteResponseSchema,
  staffSignInResponseSchema,
} from '@iorder/shared/staff-auth';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/config/env.js';
import { IdentityModule } from '../src/modules/identity/index.js';
import { PasswordHasher } from '../src/modules/identity/password-hasher.js';
import { StaffHandoffService } from '../src/modules/identity/staff-handoff.service.js';
import {
  HANDOFF_CODE_TTL_SECONDS,
  HANDOFF_ISSUE_LIMIT_PER_ACTOR,
  SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER,
} from '../src/modules/identity/staff-auth.settings.js';
import { OrganizationsModule } from '../src/modules/organizations/index.js';
import { makeMember, makeOrganization, makeUser } from './support/identity-fixtures.js';
import { FAKE_BOT_TOKEN, signedInitData, tma } from './support/init-data.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';

// Staff continue on the customer site with their dashboard sign-in ([C] 2026-11-09): the dashboard
// asks for a one-time code with its STAFF session, the customer site exchanges it for a VIEWER
// session. Everything here goes through the production resolver over real HTTP and PostgreSQL.

type Headers = Record<string, string>;

const HOUR = 3_600_000;
const PASSWORD = 'correct horse battery staple';
const CUSTOMER_SITE = 'https://order.example.uz';
const STAFF_SITE = 'https://dashboard.example.uz';

const bearer = (token: string): Headers => ({ authorization: `Bearer ${token}` });
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function suite(env: Partial<Env>) {
  const state = {} as { t: TestApp };
  const hasher = new PasswordHasher({ N: 1024, r: 8, p: 1 });

  beforeAll(async () => {
    state.t = await createTestApp([IdentityModule, OrganizationsModule], {
      botToken: FAKE_BOT_TOKEN,
      env,
      overrides: [{ token: PasswordHasher, value: hasher }],
    });
    await state.t.prisma.$connect();
  });
  afterAll(async () => {
    await state.t.close();
  });
  beforeEach(async () => {
    await resetIdentity(state.t.prisma);
    // A fresh hour: the in-process throttle windows start empty.
    helpers.advance(HOUR);
  });

  const helpers = {
    advance(ms: number): void {
      state.t.clock.set(new Date(state.t.clock.now().getTime() + ms));
    },

    /** A staff member with a login, signed in at the STAFF door: a real dashboard session. */
    async dashboard(
      login: string,
      roles: Parameters<typeof makeUser>[1] = { staff: ['MANAGER'] },
    ): Promise<{ person: Awaited<ReturnType<typeof makeUser>>; headers: Headers; token: string }> {
      const person = await makeUser(state.t.prisma, roles);
      await state.t.prisma.staffCredential.create({
        data: {
          userId: person.id,
          scope: 'STAFF',
          login,
          passwordHash: await hasher.hash(PASSWORD),
          passwordChangedAt: state.t.clock.now(),
        },
      });
      const reply = await state.t.request('POST', '/auth/password-login', {
        body: { login, password: PASSWORD },
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const { token } = staffSignInResponseSchema.parse(reply.body);
      return { person, headers: bearer(token), token };
    },

    issue: (headers: Headers, body: unknown = {}) =>
      state.t.request('POST', '/staff/customer-site/handoff', { headers, body }),

    /** A code the dashboard just got: taken out of the fragment of the address to open. */
    async codeFor(headers: Headers): Promise<string> {
      const reply = await helpers.issue(headers);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const { url } = customerSiteHandoffResponseSchema.parse(reply.body);
      const code = new URLSearchParams(new URL(url).hash.slice(1)).get(HANDOFF_FRAGMENT_PARAM);
      if (code === null) throw new Error('no code in the fragment');
      return code;
    },

    exchange: (code: unknown, headers: Headers = {}) =>
      state.t.request('POST', '/customer/auth/handoff', { headers, body: { code } }),

    async exchanged(code: string): Promise<Headers> {
      const reply = await helpers.exchange(code);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return bearer(customerSignInResponseSchema.parse(reply.body).token);
    },

    tmaOf: (user: { telegramUserId: bigint }): Headers =>
      tma(signedInitData({ telegramUserId: user.telegramUserId, now: state.t.clock.now() })),

    get: (path: string, headers: Headers = {}) => state.t.request('GET', path, { headers }),
  };
  return { state, ...helpers };
}

describe('customer site handoff (real PostgreSQL)', () => {
  const s = suite({ WEB_APP_URL: CUSTOMER_SITE, STAFF_WEB_APP_URL: `${STAFF_SITE}/` });
  const { state } = s;

  describe('asking for a code on the dashboard', () => {
    it('answers the customer site with a 256-bit code in the fragment, stored only as a hash', async () => {
      const { t } = state;
      const { person, headers, token } = await s.dashboard('boss');

      const site = await s.get('/staff/customer-site', headers);
      expect(site.status).toBe(200);
      expect(customerSiteResponseSchema.parse(site.body)).toEqual({ url: CUSTOMER_SITE });

      const reply = await s.issue(headers);
      expect(reply.status).toBe(200);
      expect(reply.headers.get('cache-control')).toBe('no-store');
      const issued = customerSiteHandoffResponseSchema.parse(reply.body);
      const url = new URL(issued.url);
      // The code is in the fragment only: never in the query string, so it reaches no server log
      // and no referrer.
      expect(url.origin).toBe(CUSTOMER_SITE);
      expect(url.pathname).toBe('/');
      expect(url.search).toBe('');
      const fragment = new URLSearchParams(url.hash.slice(1));
      expect([...fragment.keys()]).toEqual([HANDOFF_FRAGMENT_PARAM]);
      const code = fragment.get(HANDOFF_FRAGMENT_PARAM) ?? '';
      // 43 base64url characters = 32 random bytes = 256 bits.
      expect(code).toMatch(HANDOFF_CODE_PATTERN);
      expect(Buffer.from(code, 'base64url')).toHaveLength(32);
      expect(Date.parse(issued.expiresAt)).toBe(
        t.clock.now().getTime() + HANDOFF_CODE_TTL_SECONDS * 1000,
      );
      expect(HANDOFF_CODE_TTL_SECONDS).toBeLessThanOrEqual(60);

      const rows = await t.prisma.staffHandoffCode.findMany();
      expect(rows).toHaveLength(1);
      const session = await t.prisma.staffSession.findFirstOrThrow({
        where: { userId: person.id },
      });
      expect(rows[0]).toMatchObject({
        userId: person.id,
        sessionId: session.id,
        codeHash: sha256(code),
        usedAt: null,
      });
      // Neither the code nor the session token is anywhere in the row or in history.
      const dump = JSON.stringify([rows, await t.prisma.auditLog.findMany()]);
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(token);

      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'STAFF_HANDOFF_ISSUED' },
      });
      expect(audit).toMatchObject({
        actorUserId: person.id,
        entityType: 'STAFF_HANDOFF',
        entityId: rows[0]?.id,
      });
      expect(audit.diff).toMatchObject({
        expiresAt: { from: null, to: issued.expiresAt },
        sessionId: { from: null, to: session.id },
      });
    });

    it('gives two requests two different codes', async () => {
      const { headers } = await s.dashboard('boss');
      expect(await s.codeFor(headers)).not.toBe(await s.codeFor(headers));
    });

    it.each(['MANAGER', 'ACCOUNTANT', 'ADMIN', 'PURCHASING_MANAGER'] as const)(
      'is open to a %s (the roles that may be viewers)',
      async (role) => {
        const { headers } = await s.dashboard('boss', { staff: [role] });
        expect((await s.issue(headers)).status).toBe(200);
      },
    );

    it.each(['WAREHOUSE_MANAGER', 'DRIVER'] as const)(
      'gives nothing to a %s: not a viewer role',
      async (role) => {
        const { t } = state;
        const { headers } = await s.dashboard('warehouse', { staff: [role] });
        expect((await s.get('/staff/customer-site', headers)).status).toBe(403);
        expect((await s.issue(headers)).status).toBe(403);
        expect(await t.prisma.staffHandoffCode.count()).toBe(0);
      },
    );

    it('gives nothing to a customer, to nobody, or to a blocked staff member', async () => {
      const { t } = state;
      const org = await makeOrganization(t.prisma);
      const customer = await makeUser(t.prisma);
      await makeMember(t.prisma, org.id, customer.id);
      expect((await s.issue(s.tmaOf(customer))).status).toBe(403);
      expect((await s.get('/staff/customer-site', s.tmaOf(customer))).status).toBe(403);
      expect((await s.issue({})).status).toBe(401);
      expect((await s.get('/staff/customer-site')).status).toBe(401);

      const { person, headers } = await s.dashboard('boss');
      await t.prisma.user.update({ where: { id: person.id }, data: { status: 'BLOCKED' } });
      expect((await s.issue(headers)).status).toBe(401);
      expect(await t.prisma.staffHandoffCode.count()).toBe(0);
    });

    it('needs a website session: Mini App init data of a manager gets no code and no entry', async () => {
      const { t } = state;
      const manager = await makeUser(t.prisma, { staff: ['MANAGER'] });
      const site = await s.get('/staff/customer-site', s.tmaOf(manager));
      expect(site.status).toBe(200);
      expect(site.body).toEqual({ url: null });
      expect((await s.issue(s.tmaOf(manager))).status).toBe(403);
      expect(await t.prisma.staffHandoffCode.count()).toBe(0);
    });

    // No open redirect: where the browser goes is the configured customer site, whatever the
    // request says.
    it('never takes the return address from the request', async () => {
      const { headers } = await s.dashboard('boss');
      const evil = 'https://evil.example';
      for (const body of [
        { returnTo: evil },
        { url: evil },
        { redirect: `${evil}/#x` },
        { origin: evil },
      ]) {
        expect((await s.issue(headers, body)).status, JSON.stringify(body)).toBe(422);
      }
      const spoofed = await state.t.request(
        'POST',
        `/staff/customer-site/handoff?returnTo=${encodeURIComponent(evil)}&url=${evil}`,
        {
          headers: {
            ...headers,
            origin: evil,
            referer: `${evil}/page`,
            'x-forwarded-host': 'evil.example',
            'x-forwarded-proto': 'http',
          },
          body: {},
        },
      );
      expect(spoofed.status).toBe(200);
      const { url } = customerSiteHandoffResponseSchema.parse(spoofed.body);
      expect(new URL(url).origin).toBe(CUSTOMER_SITE);
      expect(url).not.toContain('evil');
    });

    // Security review, 2026-11-10: codes are not history (the audit log is). Asking for a new one
    // removes this person's codes that were used, or expired, more than a day ago.
    it('prunes the person`s codes a day after they were used or expired, and nobody else`s', async () => {
      const { t } = state;
      const boss = await s.dashboard('boss');
      const other = await s.dashboard('other');
      await s.exchanged(await s.codeFor(boss.headers)); // used
      await s.codeFor(boss.headers); // never used: expires in a minute
      await s.codeFor(other.headers);
      expect(await t.prisma.staffHandoffCode.count()).toBe(3);

      s.advance(HOUR);
      await s.codeFor(boss.headers);
      // Less than a day: everything is still there (plus the new one).
      expect(await t.prisma.staffHandoffCode.count()).toBe(4);

      // A day and a bit after the never-used code expired.
      s.advance(24 * HOUR + 2 * 60_000);
      await s.codeFor(boss.headers);
      const left = await t.prisma.staffHandoffCode.findMany();
      // The other person's old code stays; of the boss's only the one just issued remains.
      expect(left.filter((row) => row.userId === other.person.id)).toHaveLength(1);
      expect(left.filter((row) => row.userId === boss.person.id)).toHaveLength(1);
      expect(left.find((row) => row.userId === boss.person.id)?.usedAt).toBeNull();
    });

    it('is throttled per person, with the usual 429 and Retry-After', async () => {
      const { headers } = await s.dashboard('boss');
      for (let i = 0; i < HANDOFF_ISSUE_LIMIT_PER_ACTOR; i += 1) {
        expect((await s.issue(headers)).status, `request ${i + 1}`).toBe(200);
      }
      const refused = await s.issue(headers);
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      // Another person is not affected.
      const other = await s.dashboard('second');
      expect((await s.issue(other.headers)).status).toBe(200);
    });
  });

  describe('exchanging the code on the customer site', () => {
    it('opens a VIEWER session of the person who asked, exactly like a staff sign-in at the customer door', async () => {
      const { t } = state;
      const { person, headers } = await s.dashboard('boss');
      const code = await s.codeFor(headers);

      const reply = await s.exchange(code);
      expect(reply.status).toBe(200);
      expect(reply.headers.get('cache-control')).toBe('no-store');
      const viewer = bearer(customerSignInResponseSchema.parse(reply.body).token);

      const me = meResponseSchema.parse((await s.get('/me', viewer)).body);
      expect(me).toMatchObject({
        userId: person.id,
        staffRoles: [],
        membership: null,
        staffViewer: { canOrder: false, organizationName: null },
      });
      // The person keeps working on the dashboard with the session they had.
      expect((await s.get('/staff/users', headers)).status).toBe(200);

      expect(await t.prisma.staffSession.count()).toBe(2);
      const dashboardSession = await t.prisma.staffSession.findFirstOrThrow({
        where: { staffViewer: false },
      });
      const viewerSession = await t.prisma.staffSession.findFirstOrThrow({
        where: { staffViewer: true },
      });
      expect(viewerSession).toMatchObject({ userId: person.id, revokedAt: null });
      // The same limits as every other session: two weeks without use, 90 days in all.
      expect(viewerSession.expiresAt.getTime()).toBe(t.clock.now().getTime() + 90 * 24 * HOUR);
      s.advance(14 * 24 * HOUR - 1000);
      expect((await s.get('/me', viewer)).status).toBe(200);
      s.advance(14 * 24 * HOUR);
      expect((await s.get('/me', viewer)).status).toBe(401);

      // History: issued by the person, exchanged into a customer-door session, marked as a viewer
      // and as a handoff.
      const code_ = await t.prisma.staffHandoffCode.findFirstOrThrow();
      expect(code_.usedAt).not.toBeNull();
      const created = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'CUSTOMER_SESSION_CREATED' },
      });
      expect(created).toMatchObject({ actorUserId: person.id, entityId: viewerSession.id });
      expect(created.diff).toMatchObject({
        staffViewer: { from: null, to: true },
        handoff: { from: null, to: code_.id },
      });
      // The dashboard session is untouched by the exchange.
      expect(dashboardSession.revokedAt).toBeNull();
      await expect(
        t.prisma.auditLog.count({ where: { action: 'STAFF_SESSION_CREATED' } }),
      ).resolves.toBe(1);
    });

    // The handoff goes one way only: staff session -> viewer session.
    it('cannot turn the viewer session back into a staff session', async () => {
      const { t } = state;
      const { headers } = await s.dashboard('boss');
      const viewer = await s.exchanged(await s.codeFor(headers));

      for (const path of ['/staff/users', '/staff/accounts', '/staff/customer-site']) {
        expect((await s.get(path, viewer)).status, path).toBe(403);
      }
      // A viewer cannot ask for a code, so it can never mint anything from its own session.
      const before = await t.prisma.staffHandoffCode.count();
      expect((await s.issue(viewer)).status).toBe(403);
      expect(await t.prisma.staffHandoffCode.count()).toBe(before);
      // Every session born from a code is a viewer session, however often the flow runs.
      const again = await s.exchanged(await s.codeFor(headers));
      expect((await s.get('/staff/users', again)).status).toBe(403);
      const rows = await t.prisma.staffSession.findMany();
      expect(rows.map((row) => row.staffViewer).sort()).toEqual([false, true, true]);
    });

    it('works once: the second exchange of the same code is refused', async () => {
      const { headers } = await s.dashboard('boss');
      const code = await s.codeFor(headers);
      expect((await s.exchange(code)).status).toBe(200);
      expect((await s.exchange(code)).status).toBe(401);
      expect(await state.t.prisma.staffSession.count({ where: { staffViewer: true } })).toBe(1);
    });

    it('two exchanges of one code at the same moment open exactly one session', async () => {
      const { headers } = await s.dashboard('boss');
      const code = await s.codeFor(headers);
      const replies = await Promise.all([s.exchange(code), s.exchange(code), s.exchange(code)]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 401, 401]);
      expect(await state.t.prisma.staffSession.count({ where: { staffViewer: true } })).toBe(1);
    });

    it('expires within a minute', async () => {
      const { headers } = await s.dashboard('boss');
      const late = await s.codeFor(headers);
      const inTime = await s.codeFor(headers);
      s.advance(HANDOFF_CODE_TTL_SECONDS * 1000 - 1);
      expect((await s.exchange(inTime)).status).toBe(200);
      s.advance(1);
      expect((await s.exchange(late)).status).toBe(401);
      // An expired code is used up as well: it does not come back to life.
      s.advance(-HOUR);
      expect((await s.exchange(late)).status).toBe(401);
    });

    it('answers one indistinguishable refusal for a used, expired, unknown or malformed code', async () => {
      const { headers } = await s.dashboard('boss');
      const used = await s.codeFor(headers);
      await s.exchanged(used);
      const expired = await s.codeFor(headers);
      s.advance((HANDOFF_CODE_TTL_SECONDS + 1) * 1000);
      const unknown = 'A'.repeat(43);
      const wrongPassword = await state.t.request('POST', '/customer/auth/password-login', {
        body: { login: 'boss', password: 'not the password' },
      });

      const answers = new Set<string>([`${wrongPassword.status} ${wrongPassword.raw}`]);
      // Nine codes: one fewer than the failures an address may make before the 429.
      for (const code of [
        used,
        expired,
        unknown,
        '',
        'short',
        `${used}x`,
        used.slice(0, -1),
        ' '.repeat(43),
        'x'.repeat(256),
      ]) {
        const reply = await s.exchange(code);
        expect(reply.status, JSON.stringify(code)).toBe(401);
        answers.add(`${reply.status} ${reply.raw}`);
      }
      // The same bytes as a wrong password at the customer door.
      expect(answers.size).toBe(1);
      expect(await state.t.prisma.staffSession.count({ where: { staffViewer: true } })).toBe(1);
    });

    it('rejects a body that is not a code at all, and unknown fields', async () => {
      for (const body of [{}, { code: 5 }, { code: null }, { code: 'x'.repeat(257) }]) {
        const reply = await state.t.request('POST', '/customer/auth/handoff', { body });
        expect(reply.status, JSON.stringify(body)).toBe(422);
      }
      const { headers } = await s.dashboard('boss');
      const code = await s.codeFor(headers);
      const extra = await state.t.request('POST', '/customer/auth/handoff', {
        body: { code, staffViewer: false, userId: 'someone-else' },
      });
      expect(extra.status).toBe(422);
    });

    it('gives nothing once the person is blocked, loses the viewer roles, or signs out of the dashboard', async () => {
      const { t } = state;
      const boss = await makeUser(t.prisma, { staff: ['ADMIN'] });

      const blocked = await s.dashboard('blocked');
      const blockedCode = await s.codeFor(blocked.headers);
      const block = await t.request('POST', `/staff/users/${blocked.person.id}/block`, {
        headers: s.tmaOf(boss),
      });
      expect(block.status).toBe(200);
      expect((await s.exchange(blockedCode)).status).toBe(401);

      // Still staff, but no longer in a role that may be a viewer.
      const moved = await s.dashboard('moved', { staff: ['MANAGER', 'DRIVER'] });
      const movedCode = await s.codeFor(moved.headers);
      const removed = await t.request('DELETE', `/staff/users/${moved.person.id}/roles/MANAGER`, {
        headers: s.tmaOf(boss),
      });
      expect(removed.status).toBe(200);
      expect((await s.exchange(movedCode)).status).toBe(401);

      // The code belongs to the session that asked for it and dies with it.
      const left = await s.dashboard('left');
      const leftCode = await s.codeFor(left.headers);
      expect((await t.request('POST', '/auth/logout', { headers: left.headers })).status).toBe(204);
      expect((await s.exchange(leftCode)).status).toBe(401);

      expect(await t.prisma.staffSession.count({ where: { staffViewer: true } })).toBe(0);
      // Each refusal of a known person is in history, as a failed sign-in, without the code.
      const failures = await t.prisma.auditLog.findMany({
        where: { action: 'AUTH_SIGN_IN_FAILED' },
      });
      expect(failures.map((row) => row.entityId).sort()).toEqual(
        [blocked.person.id, moved.person.id, left.person.id].sort(),
      );
      for (const row of failures) {
        expect(row.actorUserId).toBeNull();
        expect(row.diff).toMatchObject({ method: { from: null, to: 'STAFF_HANDOFF' } });
      }
    });

    it('a new password on the dashboard account ends the outstanding code with the sessions', async () => {
      const { t } = state;
      const boss = await makeUser(t.prisma, { staff: ['ADMIN'] });
      const { person, headers } = await s.dashboard('alice');
      const code = await s.codeFor(headers);
      const reset = await t.request('PUT', `/staff/users/${person.id}/credentials`, {
        headers: s.tmaOf(boss),
        body: { password: 'a brand new password' },
      });
      expect(reset.status).toBe(200);
      expect((await s.exchange(code)).status).toBe(401);
    });

    // A new password (or a block, or a lost role) ends every session of the person under the row
    // lock. A handoff that was already past its own check must not slip a new session in behind it.
    it('opens nothing when the dashboard session ends between the code check and the new session', async () => {
      const { t } = state;
      const { person, headers } = await s.dashboard('boss');
      const code = await s.codeFor(headers);
      const handoffs = t.get(StaffHandoffService);
      const claim = handoffs.claim.bind(handoffs);
      const spy = vi.spyOn(handoffs, 'claim').mockImplementation(async (value) => {
        const claimed = await claim(value);
        expect(claimed.kind).toBe('OK');
        await t.prisma.staffSession.updateMany({
          where: { userId: person.id, revokedAt: null },
          data: { revokedAt: t.clock.now() },
        });
        return claimed;
      });
      try {
        expect((await s.exchange(code)).status).toBe(401);
      } finally {
        spy.mockRestore();
      }
      expect(await t.prisma.staffSession.count({ where: { staffViewer: true } })).toBe(0);
      const failure = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'AUTH_SIGN_IN_FAILED', entityId: person.id },
      });
      expect(failure.diff).toMatchObject({
        method: { from: null, to: 'STAFF_HANDOFF' },
        reason: { from: null, to: 'SOURCE_SESSION_ENDED' },
      });
    });

    // Security review, 2026-11-10: the viewer session comes from the dashboard session and must
    // not outlive it.
    describe('the viewer session lives and dies with the dashboard session it came from', () => {
      it('records its source, and a sign-out of the dashboard ends it in the same transaction', async () => {
        const { t } = state;
        const { person, headers } = await s.dashboard('boss');
        const viewer = await s.exchanged(await s.codeFor(headers));
        const dashboardSession = await t.prisma.staffSession.findFirstOrThrow({
          where: { staffViewer: false },
        });
        const viewerSession = await t.prisma.staffSession.findFirstOrThrow({
          where: { staffViewer: true },
        });
        expect(viewerSession.sourceSessionId).toBe(dashboardSession.id);
        expect(dashboardSession.sourceSessionId).toBeNull();
        expect((await s.get('/me', viewer)).status).toBe(200);

        const out = await t.request('POST', '/auth/logout', { headers });
        expect(out.status).toBe(204);
        expect((await s.get('/me', viewer)).status).toBe(401);
        expect((await s.get('/auth/session', viewer)).status).toBe(401);
        const after = await t.prisma.staffSession.findMany({ where: { userId: person.id } });
        expect(after.every((row) => row.revokedAt !== null)).toBe(true);
        const audit = await t.prisma.auditLog.findFirstOrThrow({
          where: { action: 'STAFF_SESSION_REVOKED', entityId: dashboardSession.id },
        });
        expect(audit.diff).toMatchObject({
          reason: { from: null, to: 'LOGOUT' },
          handedOverSessionsRevoked: { from: null, to: 1 },
        });
      });

      it('ends when the dashboard session lapses, without any sign-out', async () => {
        const { headers } = await s.dashboard('boss');
        const viewer = await s.exchanged(await s.codeFor(headers));
        // The customer site is used every day; the dashboard is not opened again.
        for (let day = 0; day < 13; day += 1) {
          s.advance(24 * HOUR);
          expect((await s.get('/me', viewer)).status, `day ${day + 1}`).toBe(200);
        }
        s.advance(24 * HOUR + 1000);
        expect((await s.get('/me', viewer)).status).toBe(401);
      });

      it('a sign-out of the viewer session leaves the dashboard session alone', async () => {
        const { headers } = await s.dashboard('boss');
        const viewer = await s.exchanged(await s.codeFor(headers));
        expect((await state.t.request('POST', '/auth/logout', { headers: viewer })).status).toBe(
          204,
        );
        expect((await s.get('/me', viewer)).status).toBe(401);
        expect((await s.get('/staff/users', headers)).status).toBe(200);
      });

      it('a viewer session opened at the customer door has no source and is not touched', async () => {
        const { t } = state;
        const { person, headers } = await s.dashboard('boss');
        const door = await t.request('POST', '/customer/auth/password-login', {
          body: { login: 'boss', password: PASSWORD },
        });
        expect(door.status).toBe(200);
        const doorViewer = bearer(customerSignInResponseSchema.parse(door.body).token);
        expect((await t.request('POST', '/auth/logout', { headers })).status).toBe(204);
        expect((await s.get('/me', doorViewer)).status).toBe(200);
        const row = await t.prisma.staffSession.findFirstOrThrow({
          where: { userId: person.id, staffViewer: true },
        });
        expect(row.sourceSessionId).toBeNull();
      });

      it('the source of a session can never be rewritten, not even by the owner role', async () => {
        const { t } = state;
        const { headers } = await s.dashboard('boss');
        await s.exchanged(await s.codeFor(headers));
        const viewerSession = await t.prisma.staffSession.findFirstOrThrow({
          where: { staffViewer: true },
        });
        await expect(
          t.prisma
            .$executeRaw`UPDATE staff_sessions SET source_session_id = NULL WHERE id = ${viewerSession.id}::uuid`,
        ).rejects.toThrow(/only last_seen_at and revoked_at/);
      });
    });

    it('records unknown codes as failed sign-ins, aggregated, and never stores what was sent', async () => {
      const { t } = state;
      const guess = 'B'.repeat(43);
      for (let i = 0; i < 3; i += 1) expect((await s.exchange(guess)).status).toBe(401);
      const rows = await t.prisma.auditLog.findMany({ where: { action: 'AUTH_SIGN_IN_FAILED' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: null, entityType: 'AUTH_ATTEMPT' });
      expect(rows[0]?.diff).toMatchObject({
        method: { from: null, to: 'STAFF_HANDOFF' },
        reason: { from: null, to: 'BAD_CODE' },
      });
      expect(JSON.stringify(rows)).not.toContain(guess);
    });

    it('is throttled like a sign-in: failed exchanges from one address run into 429, successes do not count', async () => {
      const { headers } = await s.dashboard('boss');
      // Successful exchanges give their slot back.
      for (let i = 0; i < 3; i += 1) await s.exchanged(await s.codeFor(headers));
      const good = await s.codeFor(headers);
      for (let i = 0; i < SIGN_IN_LIMIT_PER_IP_AND_IDENTIFIER; i += 1) {
        expect((await s.exchange('C'.repeat(43))).status, `attempt ${i + 1}`).toBe(401);
      }
      const refused = await s.exchange('C'.repeat(43));
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      // Even a good code waits: the 429 says nothing about the code.
      expect((await s.exchange(good)).status).toBe(429);
    });

    it('ignores any credentials sent along: the code alone decides who signs in', async () => {
      const { t } = state;
      const first = await s.dashboard('first');
      const second = await s.dashboard('second');
      const code = await s.codeFor(first.headers);
      // Exchanged while presenting ANOTHER person's dashboard session.
      const reply = await s.exchange(code, second.headers);
      expect(reply.status).toBe(200);
      const viewer = bearer(customerSignInResponseSchema.parse(reply.body).token);
      const me = meResponseSchema.parse((await s.get('/me', viewer)).body);
      expect(me.userId).toBe(first.person.id);
      const row = await t.prisma.staffSession.findFirstOrThrow({ where: { staffViewer: true } });
      expect(row.userId).toBe(first.person.id);
    });
  });

  describe('the page the customer site sends a company employee to', () => {
    it('is the configured staff site, public, and never built from the request', async () => {
      const reply = await state.t.request(
        'GET',
        '/customer/auth/handoff?url=https://evil.example',
        {
          headers: {
            origin: 'https://evil.example',
            'x-forwarded-host': 'evil.example',
          },
        },
      );
      expect(reply.status).toBe(200);
      expect(customerHandoffPageResponseSchema.parse(reply.body)).toEqual({
        url: `${STAFF_SITE}/handoff`,
      });
    });
  });
});

describe('customer site handoff without the site addresses (local development)', () => {
  const s = suite({});

  it('hides the entry, issues nothing and sends nobody anywhere', async () => {
    const { t } = s.state;
    const { headers } = await s.dashboard('boss');
    const site = await s.get('/staff/customer-site', headers);
    expect(site.status).toBe(200);
    expect(site.body).toEqual({ url: null });
    expect((await s.issue(headers)).status).toBe(404);
    expect(await t.prisma.staffHandoffCode.count()).toBe(0);
    const page = await s.get('/customer/auth/handoff');
    expect(page.status).toBe(200);
    expect(page.body).toEqual({ url: null });
  });
});

describe('customer site handoff when both apps share one address', () => {
  const s = suite({ WEB_APP_URL: CUSTOMER_SITE });

  it('still hands over on a click, but there is no other site to send a visitor to', async () => {
    const { headers } = await s.dashboard('boss');
    await s.exchanged(await s.codeFor(headers));
    expect((await s.get('/customer/auth/handoff')).body).toEqual({ url: null });
  });
});
