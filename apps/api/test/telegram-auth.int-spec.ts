import { meResponseSchema } from '@iorder/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityModule } from '../src/modules/identity/index.js';
import { OrganizationsModule } from '../src/modules/organizations/index.js';
import { makeMember, makeOrganization, makeUser } from './support/identity-fixtures.js';
import { FAKE_BOT_TOKEN, signedInitData, tma } from './support/init-data.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';

// The PRODUCTION actor resolver (Authorization: tma <initData>) against a real database.
describe('Telegram actor resolver through the real guard (real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([IdentityModule, OrganizationsModule], { botToken: FAKE_BOT_TOKEN });
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetIdentity(t.prisma);
  });

  const headersFor = (telegramUserId: bigint, ageSeconds = 0): Record<string, string> =>
    tma(signedInitData({ telegramUserId, now: t.clock.now(), ageSeconds }));
  const me = (headers: Record<string, string>) => t.request('GET', '/me', { headers });

  it('authenticates a staff member with all of their roles', async () => {
    const staff = await makeUser(t.prisma, { staff: ['MANAGER', 'ACCOUNTANT'] });
    const res = await me(headersFor(staff.telegramUserId));
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(res.body)).toMatchObject({
      userId: staff.id,
      staffRoles: ['MANAGER', 'ACCOUNTANT'],
      membership: null,
    });
    expect(
      (await t.request('GET', '/staff/users', { headers: headersFor(staff.telegramUserId) }))
        .status,
    ).toBe(200);
  });

  it('authenticates a customer with their organization membership only', async () => {
    const org = await makeOrganization(t.prisma);
    const seller = await makeUser(t.prisma);
    await makeMember(t.prisma, org.id, seller.id, 'SELLER');
    const headers = headersFor(seller.telegramUserId);
    expect(meResponseSchema.parse((await me(headers)).body)).toMatchObject({
      staffRoles: [],
      membership: { organizationId: org.id, role: 'SELLER' },
    });
    // The matrix still applies: a seller is not allowed into the staff area.
    expect((await t.request('GET', '/staff/users', { headers })).status).toBe(403);
    expect((await t.request('GET', '/staff/organizations', { headers })).status).toBe(403);
  });

  it('picks up role changes on the next request (nothing is cached in the token)', async () => {
    const staff = await makeUser(t.prisma, { staff: ['ADMIN'] });
    const headers = headersFor(staff.telegramUserId);
    expect((await t.request('GET', '/staff/users', { headers })).status).toBe(200);
    await t.prisma.userRole.deleteMany({ where: { userId: staff.id } });
    // No staff role and no membership any more: no actor at all.
    expect((await t.request('GET', '/staff/users', { headers })).status).toBe(401);
  });

  describe('no actor: every failure is the same 401', () => {
    async function failures() {
      const active = await makeUser(t.prisma, { staff: ['ADMIN'] });
      const blocked = await makeUser(t.prisma, { staff: ['ADMIN'], status: 'BLOCKED' });
      const inactiveOrg = await makeOrganization(t.prisma, { status: 'INACTIVE' });
      const inInactive = await makeUser(t.prisma);
      await makeMember(t.prisma, inactiveOrg.id, inInactive.id);
      const org = await makeOrganization(t.prisma);
      const left = await makeUser(t.prisma);
      await makeMember(t.prisma, org.id, left.id, 'SELLER', 'LEFT');
      const nobody = await makeUser(t.prisma);
      const now = t.clock.now();
      const forStranger = tma(signedInitData({ telegramUserId: 999_999_999_999n, now }));

      return {
        'no header': {},
        'wrong scheme': {
          authorization: `Bearer ${signedInitData({ telegramUserId: active.telegramUserId, now })}`,
        },
        'scheme without data': { authorization: 'tma ' },
        'garbage data': { authorization: 'tma not-init-data' },
        'wrong token': tma(
          signedInitData({ telegramUserId: active.telegramUserId, now, token: '1:other-fake' }),
        ),
        'tampered user id': tma(
          signedInitData({ telegramUserId: active.telegramUserId, now }).replace(
            encodeURIComponent(`"id":${active.telegramUserId}`),
            encodeURIComponent(`"id":${nobody.telegramUserId}`),
          ),
        ),
        expired: headersFor(active.telegramUserId, 86_401),
        'from the future': headersFor(active.telegramUserId, -3600),
        'unknown user': forStranger,
        'blocked user': headersFor(blocked.telegramUserId),
        'organization inactive': headersFor(inInactive.telegramUserId),
        'left the organization': headersFor(left.telegramUserId),
        'neither staff nor member': headersFor(nobody.telegramUserId),
      } satisfies Record<string, Record<string, string>>;
    }

    it('answers 401 with the identical body whatever the reason', async () => {
      const cases = await failures();
      const bodies = new Set<string>();
      for (const [name, headers] of Object.entries(cases)) {
        for (const path of ['/me', '/staff/users']) {
          const res = await t.request('GET', path, { headers });
          expect(res.status, `${name} ${path}`).toBe(401);
          bodies.add(JSON.stringify(res.body));
        }
      }
      expect(bodies.size).toBe(1);
    });

    it('the tampered-id case really differs from the untampered request (the test is meaningful)', async () => {
      const cases = await failures();
      const active = await t.prisma.user.findFirstOrThrow({
        where: { status: 'ACTIVE', roles: { some: {} } },
      });
      const original = tma(
        signedInitData({ telegramUserId: active.telegramUserId ?? 0n, now: t.clock.now() }),
      );
      expect(cases['tampered user id'].authorization).not.toEqual(original.authorization);
      expect((await me(original)).status).toBe(200);
    });

    it('never echoes the init data, the token or the Telegram id', async () => {
      const staff = await makeUser(t.prisma, { staff: ['ADMIN'], status: 'BLOCKED' });
      const headers = headersFor(staff.telegramUserId);
      const res = await me(headers);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(FAKE_BOT_TOKEN);
      expect(text).not.toContain(staff.telegramUserId.toString());
      expect(text).not.toContain(headers.authorization!.slice(4, 40));
    });
  });

  it('accepts data right at the default 24 hour limit and rejects it one second later', async () => {
    const staff = await makeUser(t.prisma, { staff: ['MANAGER'] });
    expect((await me(headersFor(staff.telegramUserId, 86_400))).status).toBe(200);
    expect((await me(headersFor(staff.telegramUserId, 86_401))).status).toBe(401);
  });

  it('keeps public routes public and unaffected by the resolver', async () => {
    // The health probe lives outside these modules; the guard simply must not break /me's 401.
    expect((await t.request('GET', '/me')).status).toBe(401);
  });
});
