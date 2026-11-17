import { meResponseSchema, staffPersonCardSchema, type StaffRole } from '@iorder/shared';
import {
  ownStaffProfileResponseSchema,
  staffCurrentSessionResponseSchema,
  staffSignInResponseSchema,
} from '@iorder/shared/staff-auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityModule } from '../src/modules/identity/index.js';
import { PasswordHasher } from '../src/modules/identity/password-hasher.js';
import { OrganizationsModule } from '../src/modules/organizations/index.js';
import {
  customerActor,
  makeMember,
  makeOrganization,
  makeUser,
  staffActor,
} from './support/identity-fixtures.js';
import { FAKE_BOT_TOKEN, signedInitData, tma } from './support/init-data.js';
import {
  createTestApp,
  rejectedByResolver,
  STAFF_VIEWER,
  type TestApp,
} from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';

const PATH = '/staff/me/profile';
const STAFF_ROLES: readonly StaffRole[] = [
  'ADMIN',
  'MANAGER',
  'ACCOUNTANT',
  'WAREHOUSE_MANAGER',
  'DRIVER',
  'PURCHASING_MANAGER',
];

const error = (body: unknown): { code: string; reason?: string } =>
  (body as { error: { code: string; reason?: string } }).error;
const issuePaths = (body: unknown): string[] =>
  (body as { error: { details: { path: string }[] } }).error.details.map((issue) => issue.path);

// A staff member's own name and phone [C, 2026-11-09]: `GET/PUT /staff/me/profile`.
describe('own staff profile (real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([IdentityModule, OrganizationsModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetIdentity(t.prisma);
  });

  const auditRows = () => t.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
  const rowOf = (id: string) => t.prisma.user.findUniqueOrThrow({ where: { id } });
  const body = { fullName: '  Sardor Aliyev ', phone: '+998 (90) 123-45-67' };

  async function staff(role: StaffRole, phone: string | null = '+998931112233') {
    const person = await makeUser(t.prisma, { name: `Old ${role}`, phone, staff: [role] });
    return { person, actor: staffActor(person.id, role) };
  }

  describe('who may use it', () => {
    it('401 without an actor; 403 for customers, a person without roles and a staff viewer', async () => {
      for (const method of ['GET', 'PUT']) {
        const sent = method === 'GET' ? undefined : body;
        expect((await t.request(method, PATH, { body: sent })).status).toBe(401);
        const org = await makeOrganization(t.prisma);
        const owner = await makeUser(t.prisma, { name: 'Owner', phone: '+998901112233' });
        await makeMember(t.prisma, org.id, owner.id, 'SHOP_OWNER');
        const loner = await makeUser(t.prisma, { name: 'Loner' });
        const viewer = await makeUser(t.prisma, { name: 'Viewer', staff: ['MANAGER'] });
        for (const actor of [
          customerActor(owner.id, org.id, 'SHOP_OWNER'),
          customerActor(owner.id, org.id, 'SELLER'),
          { userId: loner.id, staffRoles: [] },
          // What a staff member is on the customer routes: no staff role, so no staff grant.
          { ...STAFF_VIEWER, userId: viewer.id },
        ]) {
          const res = await t.request(method, PATH, { actor, body: sent });
          expect(res.status, JSON.stringify(actor)).toBe(403);
        }
        expect((await rowOf(owner.id)).fullName).toBe('Owner');
        expect((await rowOf(viewer.id)).fullName).toBe('Viewer');
      }
      expect(await auditRows()).toEqual([]);
    });

    it('every staff role reads and changes its own name and phone', async () => {
      for (const role of STAFF_ROLES) {
        const { person, actor } = await staff(role);
        const read = await t.request('GET', PATH, { actor });
        expect(read.status, role).toBe(200);
        expect(read.headers.get('cache-control')).toBe('no-store');
        expect(ownStaffProfileResponseSchema.parse(read.body)).toEqual({
          fullName: `Old ${role}`,
          phone: '+998931112233',
        });

        const res = await t.request('PUT', PATH, { actor, body });
        expect(res.status, role).toBe(200);
        expect(ownStaffProfileResponseSchema.parse(res.body)).toEqual({
          fullName: 'Sardor Aliyev',
          phone: '+998901234567',
        });
        const row = await rowOf(person.id);
        expect([row.fullName, row.phone]).toEqual(['Sardor Aliyev', '+998901234567']);
      }
    });

    it('a blocked staff member is turned away (401) and nothing is written', async () => {
      const { person, actor } = await staff('MANAGER');
      await t.prisma.user.update({ where: { id: person.id }, data: { status: 'BLOCKED' } });
      for (const method of ['GET', 'PUT']) {
        const res = await t.request(method, PATH, {
          actor: rejectedByResolver(actor, 'BLOCKED'),
          body: method === 'GET' ? undefined : body,
        });
        expect(res.status).toBe(401);
      }
      expect((await rowOf(person.id)).fullName).toBe('Old MANAGER');
      expect(await auditRows()).toEqual([]);
    });

    it('a block that lands after the request was authenticated still wins (403)', async () => {
      const { person, actor } = await staff('DRIVER');
      await t.prisma.user.update({ where: { id: person.id }, data: { status: 'BLOCKED' } });
      const res = await t.request('PUT', PATH, { actor, body });
      expect(res.status).toBe(403);
      expect((await rowOf(person.id)).fullName).toBe('Old DRIVER');
      expect(await auditRows()).toEqual([]);
    });
  });

  describe('what a change does', () => {
    it('writes one audit row by the person, with only the changed fields from/to', async () => {
      const { person, actor } = await staff('ACCOUNTANT');
      await t.request('PUT', PATH, { actor, body });
      await t.request('PUT', PATH, {
        actor,
        body: { fullName: 'Sardor Aliyev', phone: '+998935550000' },
      });
      const audits = await auditRows();
      expect(audits.map((a) => a.action)).toEqual([
        'USER_OWN_PROFILE_UPDATED',
        'USER_OWN_PROFILE_UPDATED',
      ]);
      for (const audit of audits) {
        expect(audit).toMatchObject({
          actorUserId: person.id,
          entityType: 'USER',
          entityId: person.id,
        });
      }
      expect(audits[0]?.diff).toEqual({
        fullName: { from: 'Old ACCOUNTANT', to: 'Sardor Aliyev' },
        phone: { from: '+998931112233', to: '+998901234567' },
      });
      // The later change did not rewrite the earlier row.
      expect(audits[1]?.diff).toEqual({ phone: { from: '+998901234567', to: '+998935550000' } });
    });

    it('the same values again change nothing and write no audit row', async () => {
      const { person, actor } = await staff('MANAGER');
      const before = await rowOf(person.id);
      const res = await t.request('PUT', PATH, {
        actor,
        body: { fullName: 'Old MANAGER', phone: '+998931112233' },
      });
      expect(res.status).toBe(200);
      expect(await rowOf(person.id)).toEqual(before);
      expect(await auditRows()).toEqual([]);
    });

    it('a staff phone can be added and removed; each is audited', async () => {
      const { person, actor } = await staff('WAREHOUSE_MANAGER', null);
      expect(
        ownStaffProfileResponseSchema.parse((await t.request('GET', PATH, { actor })).body).phone,
      ).toBeNull();
      const name = 'Old WAREHOUSE_MANAGER';
      await t.request('PUT', PATH, { actor, body: { fullName: name, phone: '+998901234567' } });
      const removed = await t.request('PUT', PATH, {
        actor,
        body: { fullName: name, phone: null },
      });
      expect(removed.status).toBe(200);
      expect(ownStaffProfileResponseSchema.parse(removed.body)).toEqual({
        fullName: name,
        phone: null,
      });
      expect((await rowOf(person.id)).phone).toBeNull();
      expect((await auditRows()).map((a) => a.diff)).toEqual([
        { phone: { from: null, to: '+998901234567' } },
        { phone: { from: '+998901234567', to: null } },
      ]);
    });

    it('the new name is what the rest of the staff app shows, and `/me` has no stale copy', async () => {
      const { person, actor } = await staff('DRIVER');
      const manager = await staff('MANAGER');
      await t.request('PUT', PATH, { actor, body });
      const me = meResponseSchema.parse((await t.request('GET', '/me', { actor })).body);
      expect(me.fullName).toBe('Sardor Aliyev');
      // A staff phone still never rides in `/me`, the answer both apps read.
      expect(me.contact).toBeNull();
      const card = await t.request('GET', `/staff/people/${person.id}`, { actor: manager.actor });
      expect(staffPersonCardSchema.parse(card.body)).toMatchObject({
        fullName: 'Sardor Aliyev',
        phone: '+998901234567',
      });
    });
  });

  describe('what it can never do', () => {
    it('rejects a bad phone or name at the right field, and every field but the two', async () => {
      const { person, actor } = await staff('MANAGER');
      const ok = { fullName: 'Sardor', phone: '+998901234567' };
      for (const [bad, field] of [
        [{ ...ok, phone: '901234567' }, 'phone'],
        [{ ...ok, phone: '' }, 'phone'],
        [{ fullName: 'Sardor' }, 'phone'],
        [{ ...ok, fullName: '   ' }, 'fullName'],
        [{ ...ok, fullName: 'x'.repeat(201) }, 'fullName'],
        [{ ...ok, fullName: 'Sar‮dor' }, 'fullName'],
        [{ ...ok, userId: person.id }, null],
        [{ ...ok, id: person.id }, null],
        [{ ...ok, staffRoles: ['ADMIN'] }, null],
        [{ ...ok, login: 'boss' }, null],
        [{ ...ok, password: 'correct horse battery staple' }, null],
        [{ ...ok, telegramUserId: '777' }, null],
        [{ ...ok, organizationId: person.id }, null],
        [{ ...ok, status: 'BLOCKED' }, null],
        [{ ...ok, language: 'RU' }, null],
      ] as const) {
        const res = await t.request('PUT', PATH, { actor, body: bad });
        expect(res.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(error(res.body).code).toBe('VALIDATION_FAILED');
        if (field !== null) expect(issuePaths(res.body), JSON.stringify(bad)).toContain(field);
      }
      const row = await rowOf(person.id);
      expect([row.fullName, row.phone]).toEqual(['Old MANAGER', '+998931112233']);
      expect(await auditRows()).toEqual([]);
    });

    it('cannot target another person: no id is read from the path, the query or the body', async () => {
      const { actor } = await staff('MANAGER');
      const admin = await staff('ADMIN');
      const ok = { fullName: 'Hacked', phone: '+998901234567' };
      expect(
        (await t.request('PUT', `${PATH}/${admin.person.id}`, { actor, body: ok })).status,
      ).toBe(404);
      const queried = await t.request('PUT', `${PATH}?userId=${admin.person.id}`, {
        actor,
        body: ok,
      });
      expect(queried.status).toBe(200);
      const row = await rowOf(admin.person.id);
      expect([row.fullName, row.phone]).toEqual(['Old ADMIN', '+998931112233']);
      expect((await auditRows()).map((a) => a.entityId)).toEqual([actor.userId]);
    });

    it('moves nothing but the caller name and phone: roles, Telegram id, status, other people', async () => {
      const { person, actor } = await staff('MANAGER');
      await staff('ADMIN');
      const org = await makeOrganization(t.prisma);
      const owner = await makeUser(t.prisma, { name: 'Owner', phone: '+998901112233' });
      await makeMember(t.prisma, org.id, owner.id, 'SHOP_OWNER');
      const people = () =>
        t.prisma.user.findMany({ orderBy: { id: 'asc' }, include: { roles: true } });
      const members = () => t.prisma.organizationMember.findMany({ orderBy: { userId: 'asc' } });
      const before = await people();
      const membersBefore = await members();

      expect((await t.request('PUT', PATH, { actor, body })).status).toBe(200);

      const after = await people();
      for (const [index, row] of after.entries()) {
        const old = before[index];
        if (row.id === person.id) {
          expect(row).toEqual({
            ...old,
            fullName: 'Sardor Aliyev',
            phone: '+998901234567',
            updatedAt: row.updatedAt,
          });
        } else {
          expect(row).toEqual(old);
        }
      }
      expect(await members()).toEqual(membersBefore);
    });

    it('a manager still cannot rename another staff member through the user edit', async () => {
      const { actor } = await staff('MANAGER');
      const other = await staff('ACCOUNTANT');
      const res = await t.request('PATCH', `/staff/users/${other.person.id}`, {
        actor,
        body: { fullName: 'Hacked' },
      });
      expect(res.status).toBe(403);
      expect((await rowOf(other.person.id)).fullName).toBe('Old ACCOUNTANT');
    });

    it('is rate limited per person (429); another person is not held back', async () => {
      const { actor } = await staff('MANAGER');
      const other = await staff('DRIVER');
      let last = 0;
      for (let i = 0; i < 12; i += 1) {
        last = (await t.request('PUT', PATH, { actor, body })).status;
      }
      expect(last).toBe(429);
      expect((await t.request('PUT', PATH, { actor: other.actor, body })).status).toBe(200);
    });
  });
});

// The same routes behind the production guard and resolver: a website session and the Mini App.
describe('own staff profile with real sign-in (real PostgreSQL)', () => {
  let t: TestApp;
  const hasher = new PasswordHasher({ N: 1024, r: 8, p: 1 });
  const PASSWORD = 'correct horse battery staple';

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
    // A fresh hour: the in-process throttle windows start empty.
    t.clock.set(new Date(t.clock.now().getTime() + 3_600_000));
  });

  const tmaOf = (user: { telegramUserId: bigint }): Record<string, string> =>
    tma(signedInitData({ telegramUserId: user.telegramUserId, now: t.clock.now() }));

  async function signedInStaff(role: StaffRole) {
    const boss = await makeUser(t.prisma, { staff: ['ADMIN'] });
    const person = await makeUser(t.prisma, { name: 'Old Name', staff: [role] });
    const set = await t.request('PUT', `/staff/users/${person.id}/credentials`, {
      headers: tmaOf(boss),
      body: { login: 'alice', password: PASSWORD },
    });
    expect(set.status).toBe(200);
    const res = await t.request('POST', '/auth/password-login', {
      body: { login: 'alice', password: PASSWORD },
    });
    expect(res.status).toBe(200);
    const signIn = staffSignInResponseSchema.parse(res.body);
    return { person, headers: { authorization: `Bearer ${signIn.token}` } };
  }

  it('a website session is not ended and shows the new name at once (nothing is cached in it)', async () => {
    const { person, headers } = await signedInStaff('WAREHOUSE_MANAGER');
    const res = await t.request('PUT', PATH, {
      headers,
      body: { fullName: 'New Name', phone: '+998901234567' },
    });
    expect(res.status).toBe(200);

    const session = await t.request('GET', '/auth/session', { headers });
    expect(session.status).toBe(200);
    expect(staffCurrentSessionResponseSchema.parse(session.body).me).toMatchObject({
      userId: person.id,
      fullName: 'New Name',
      staffRoles: ['WAREHOUSE_MANAGER'],
    });
    const me = await t.request('GET', '/me', { headers });
    expect(meResponseSchema.parse(me.body).fullName).toBe('New Name');
    // The login and the roles are exactly what they were.
    const credential = await t.prisma.staffCredential.findUniqueOrThrow({
      where: { userId: person.id },
    });
    expect(credential.login).toBe('alice');
  });

  it('works from the Mini App (init data) for a staff member', async () => {
    const person = await makeUser(t.prisma, { name: 'Old Name', staff: ['DRIVER'] });
    const res = await t.request('PUT', PATH, {
      headers: tmaOf(person),
      body: { fullName: 'Driver Name', phone: null },
    });
    expect(res.status).toBe(200);
    expect(ownStaffProfileResponseSchema.parse(res.body)).toEqual({
      fullName: 'Driver Name',
      phone: null,
    });
  });

  it('a blocked staff member with a live session is refused (401) and nothing is written', async () => {
    const { person, headers } = await signedInStaff('MANAGER');
    await t.prisma.user.update({ where: { id: person.id }, data: { status: 'BLOCKED' } });
    const res = await t.request('PUT', PATH, {
      headers,
      body: { fullName: 'New Name', phone: '+998901234567' },
    });
    expect(res.status).toBe(401);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: person.id } })).fullName).toBe(
      'Old Name',
    );
  });

  it('a customer in the Mini App is refused on the staff route and uses the customer one', async () => {
    const org = await makeOrganization(t.prisma);
    const seller = await makeUser(t.prisma, { name: 'Telegram Name' });
    await makeMember(t.prisma, org.id, seller.id, 'SELLER');
    const headers = tmaOf(seller);
    const refused = await t.request('PUT', PATH, {
      headers,
      body: { fullName: 'Ali Valiyev', phone: '+998935550147' },
    });
    expect(refused.status).toBe(403);

    // `needsContact` is the first-order question: true until a phone exists, false afterwards.
    const before = meResponseSchema.parse((await t.request('GET', '/me', { headers })).body);
    expect(before).toMatchObject({ contact: null, needsContact: true });
    const set = await t.request('PUT', '/me/contact', {
      headers,
      body: { fullName: 'Ali Valiyev', phone: '+998935550147' },
    });
    expect(meResponseSchema.parse(set.body)).toMatchObject({ needsContact: false });
    const changed = await t.request('PUT', '/me/contact', {
      headers,
      body: { fullName: 'Ali Valiyev', phone: '+998901234567' },
    });
    expect(meResponseSchema.parse(changed.body)).toMatchObject({
      contact: { fullName: 'Ali Valiyev', phone: '+998901234567' },
      needsContact: false,
    });
  });

  it('a staff member cannot use the customer route, with a session or in the Mini App', async () => {
    const { person, headers } = await signedInStaff('MANAGER');
    for (const auth of [headers, tmaOf(person)]) {
      const res = await t.request('PUT', '/me/contact', {
        headers: auth,
        body: { fullName: 'New Name', phone: '+998901234567' },
      });
      expect(res.status).toBe(403);
    }
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: person.id } })).fullName).toBe(
      'Old Name',
    );
  });
});
