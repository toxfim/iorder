import {
  staffAccountListResponseSchema,
  staffAccountResponseSchema,
  staffSignInResponseSchema,
  type StaffAccountResponse,
} from '@iorder/shared/staff-auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/modules/audit/index.js';
import { IdentityModule, StaffAccountsService } from '../src/modules/identity/index.js';
import { PasswordHasher } from '../src/modules/identity/password-hasher.js';
import { OrganizationsModule } from '../src/modules/organizations/index.js';
import { makeMember, makeOrganization, makeUser } from './support/identity-fixtures.js';
import { FAKE_BOT_TOKEN, signedInitData, tma } from './support/init-data.js';
import { signedLoginWidget } from './support/login-widget.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';

const HOUR = 3_600_000;
const GOOD_PASSWORD = 'correct horse battery staple';

// Staff accounts created by a manager or admin, the Telegram link, and the bootstrap of the first
// administrator, on a real database through the production guard and resolver chain.
describe('staff accounts (real PostgreSQL)', () => {
  let t: TestApp;
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
    t.clock.set(new Date(t.clock.now().getTime() + HOUR));
  });

  const tmaOf = (user: { telegramUserId: bigint }): Record<string, string> =>
    tma(signedInitData({ telegramUserId: user.telegramUserId, now: t.clock.now() }));
  const staff = (role: Parameters<typeof makeUser>[1] = { staff: ['MANAGER'] }) =>
    makeUser(t.prisma, role);
  const create = (as: { telegramUserId: bigint }, body: Record<string, unknown>) =>
    t.request('POST', '/staff/users', { headers: tmaOf(as), body });
  // The Telegram id is mandatory and unique: every body gets a fresh one unless a test picks its own.
  let telegramSeq = 555_100_000;
  const accountBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    fullName: 'Dilnoza Karimova',
    login: 'dilnoza@iorder.uz',
    password: GOOD_PASSWORD,
    roles: ['ACCOUNTANT'],
    telegramUserId: String((telegramSeq += 1)),
    ...overrides,
  });
  const passwordLogin = (login: string, password: string) =>
    t.request('POST', '/auth/password-login', { body: { login, password } });
  const setTelegram = (as: { telegramUserId: bigint }, id: string, telegramUserId: string | null) =>
    t.request('PUT', `/staff/users/${id}/telegram`, {
      headers: tmaOf(as),
      body: { telegramUserId },
    });
  const created = async (as: { telegramUserId: bigint }, overrides = {}) => {
    const res = await create(as, accountBody(overrides));
    expect(res.status).toBe(201);
    return staffAccountResponseSchema.parse(res.body);
  };

  describe('who may create', () => {
    it('lets an admin and a manager create a staff account', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const manager = await staff({ staff: ['MANAGER'] });
      const first = await created(boss, {
        login: 'one@iorder.uz',
        roles: ['DRIVER', 'WAREHOUSE_MANAGER'],
      });
      expect(first).toMatchObject({
        fullName: 'Dilnoza Karimova',
        login: 'one@iorder.uz',
        roles: ['DRIVER', 'WAREHOUSE_MANAGER'],
        status: 'ACTIVE',
        hasPassword: true,
        telegramLinked: true,
        lastSignInAt: null,
      });
      const second = await created(manager, { login: 'two@iorder.uz', roles: ['MANAGER'] });
      expect(second.roles).toEqual(['MANAGER']);
      expect(await t.prisma.staffCredential.count()).toBe(2);
    });

    it('refuses accountant, warehouse, driver, customer and anonymous callers', async () => {
      const org = await makeOrganization(t.prisma);
      const customer = await makeUser(t.prisma);
      await makeMember(t.prisma, org.id, customer.id, 'SHOP_OWNER');
      const callers = [
        await staff({ staff: ['ACCOUNTANT'] }),
        await staff({ staff: ['WAREHOUSE_MANAGER'] }),
        await staff({ staff: ['DRIVER'] }),
        customer,
      ];
      for (const caller of callers) {
        expect((await create(caller, accountBody())).status, caller.id).toBe(403);
        expect((await t.request('GET', '/staff/accounts', { headers: tmaOf(caller) })).status).toBe(
          403,
        );
      }
      expect((await t.request('POST', '/staff/users', { body: accountBody() })).status).toBe(401);
      expect(await t.prisma.staffCredential.count()).toBe(0);
      expect(await t.prisma.user.count()).toBe(callers.length);
    });

    it('lets only an admin grant ADMIN: a manager is refused and nothing is created', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const manager = await staff({ staff: ['MANAGER'] });
      const before = await t.prisma.user.count();
      expect((await create(manager, accountBody({ roles: ['ADMIN'] }))).status).toBe(403);
      expect((await create(manager, accountBody({ roles: ['MANAGER', 'ADMIN'] }))).status).toBe(
        403,
      );
      expect(await t.prisma.user.count()).toBe(before);
      expect((await created(boss, { roles: ['ADMIN'] })).roles).toEqual(['ADMIN']);
    });

    it('never creates a customer: roles are required', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      for (const roles of [[], undefined, ['CUSTOMER'], ['MANAGER', 'MANAGER']]) {
        const res = await create(boss, accountBody({ roles }));
        expect(res.status, JSON.stringify(roles)).toBe(422);
      }
      expect(await t.prisma.user.count()).toBe(1);
    });
  });

  describe('validation', () => {
    it('refuses a weak password, a bad login, an unknown field and a password equal to the login', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const bad: Record<string, unknown>[] = [
        { password: 'short-7' },
        { password: 'x'.repeat(129) },
        { login: 'Dilnoza@iorder.uz' },
        { login: 'dilnoza@iorder' },
        { login: 'a..b@iorder.uz' },
        { login: 'ab' },
        { role: 'ADMIN' },
        { telegramUserId: '12' + 'x' },
        // Mandatory since 2026-10-28: an unlinked staff member would pass for a customer in a group.
        { telegramUserId: undefined },
        { phone: '12345' },
        { login: 'longlonglonglogin1@iorder.uz', password: 'longlonglonglogin1@iorder.uz' },
      ];
      for (const overrides of bad) {
        const res = await create(boss, accountBody(overrides));
        expect(res.status, JSON.stringify(overrides)).toBe(422);
        expect(JSON.stringify(res.body)).not.toContain(GOOD_PASSWORD);
      }
      expect(await t.prisma.user.count()).toBe(1);
    });

    it('refuses a duplicate login and a Telegram id that belongs to someone else, creating nothing', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      await created(boss, { telegramUserId: '555000111' });
      const users = await t.prisma.user.count();

      const login = await create(boss, accountBody({ fullName: 'Other' }));
      expect(login.status).toBe(422);
      expect(JSON.stringify(login.body)).toMatch(/login/);
      const telegram = await create(
        boss,
        accountBody({ login: 'other@iorder.uz', telegramUserId: '555000111' }),
      );
      expect(telegram.status).toBe(422);
      expect(JSON.stringify(telegram.body)).toMatch(/telegramUserId/);
      expect(await t.prisma.user.count()).toBe(users);
    });
  });

  describe('the created account', () => {
    it('signs in by password and carries exactly the roles it was given', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      await created(boss, {
        roles: ['ACCOUNTANT', 'DRIVER'],
        phone: '+998901234567',
        language: 'RU',
      });
      const res = await passwordLogin('Dilnoza@iorder.uz', GOOD_PASSWORD);
      expect(res.status).toBe(200);
      const signIn = staffSignInResponseSchema.parse(res.body);
      expect(signIn.me).toMatchObject({
        fullName: 'Dilnoza Karimova',
        locale: 'RU',
        staffRoles: ['ACCOUNTANT', 'DRIVER'],
        membership: null,
      });
      const stored = await t.prisma.user.findFirstOrThrow({ where: { id: signIn.me.userId } });
      expect(stored.telegramUserId).toBeTypeOf('bigint');
      expect(stored.phone).toBe('+998901234567');
    });

    it('never puts the password or the hash in a response or an audit row', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const res = await create(boss, accountBody({ telegramUserId: '555000222' }));
      const list = await t.request('GET', '/staff/accounts', { headers: tmaOf(boss) });
      const linked = await setTelegram(
        boss,
        staffAccountResponseSchema.parse(res.body).id,
        '555000223',
      );
      for (const text of [
        res.raw,
        list.raw,
        linked.raw,
        JSON.stringify(await t.prisma.auditLog.findMany()),
      ]) {
        expect(text).not.toContain(GOOD_PASSWORD);
        expect(text).not.toContain('scrypt');
        expect(text).not.toContain('passwordHash');
        expect(text).not.toContain('password_hash');
      }
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('writes the account, its roles, its credential and the audit row in ONE transaction', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const users = await t.prisma.user.count();
      const spy = vi
        .spyOn(t.get(AuditService), 'record')
        .mockRejectedValueOnce(new Error('audit down'));
      try {
        const res = await create(boss, accountBody());
        expect(res.status).toBe(500);
        expect(res.raw).not.toContain('audit down');
      } finally {
        spy.mockRestore();
      }
      expect(await t.prisma.user.count()).toBe(users);
      expect(await t.prisma.userRole.count()).toBe(1);
      expect(await t.prisma.staffCredential.count()).toBe(0);
      expect((await create(boss, accountBody())).status).toBe(201);
    });

    it('records who created whom, with what, and no secret', async () => {
      const manager = await staff({ staff: ['MANAGER'] });
      const account = await created(manager, { roles: ['DRIVER'] });
      const row = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'STAFF_ACCOUNT_CREATED' },
      });
      expect(row).toMatchObject({
        actorUserId: manager.id,
        entityType: 'USER',
        entityId: account.id,
      });
      expect(row.diff).toMatchObject({
        staffRoles: { from: null, to: ['DRIVER'] },
        login: { from: null, to: 'dilnoza@iorder.uz' },
        telegramLinked: { from: null, to: true },
      });
    });
  });

  describe('Telegram link', () => {
    it('keeps Telegram sign-in closed for a different Telegram id and opens it once that id is linked', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const account = await created(boss);
      const telegramId = 555000333n;
      const widget = () =>
        t.request('POST', '/auth/telegram-widget', {
          body: signedLoginWidget({
            telegramUserId: telegramId,
            now: t.clock.now(),
            ageSeconds: 0,
          }),
        });
      expect((await widget()).status).toBe(401);

      const linked = await setTelegram(boss, account.id, telegramId.toString());
      expect(linked.status).toBe(200);
      expect(staffAccountResponseSchema.parse(linked.body).telegramLinked).toBe(true);
      expect((await widget()).status).toBe(401); // the proof above was already used (replay)
      t.clock.set(new Date(t.clock.now().getTime() + 1000));
      expect(
        (await t.request('GET', '/me', { headers: tmaOf({ telegramUserId: telegramId }) })).status,
      ).toBe(200);
      const me = (await t.request('GET', '/me', { headers: tmaOf({ telegramUserId: telegramId }) }))
        .body as { staffRoles: string[] };
      expect(me.staffRoles).toEqual(['ACCOUNTANT']);
    });

    it('stops resolving the staff actor for the old id once another id is linked, and ends the sessions', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const account = await created(boss, { telegramUserId: '555000444' });
      const telegram = { telegramUserId: 555000444n };
      expect((await t.request('GET', '/staff/accounts', { headers: tmaOf(telegram) })).status).toBe(
        403,
      );
      const session = staffSignInResponseSchema.parse(
        (await passwordLogin('dilnoza@iorder.uz', GOOD_PASSWORD)).body,
      );

      expect((await setTelegram(boss, account.id, '555000445')).status).toBe(200);
      const me = await t.request('GET', '/me', { headers: tmaOf(telegram) });
      expect(JSON.stringify(me.body)).not.toContain('ACCOUNTANT');
      // The password session was ended by the change; the password itself still works.
      expect(
        (await t.request('GET', '/me', { headers: { authorization: `Bearer ${session.token}` } }))
          .status,
      ).toBe(401);
      expect((await passwordLogin('dilnoza@iorder.uz', GOOD_PASSWORD)).status).toBe(200);

      const rows = await t.prisma.auditLog.findMany({
        where: { action: { startsWith: 'STAFF_TELEGRAM_' } },
      });
      expect(rows.map((r) => r.action)).toEqual(['STAFF_TELEGRAM_LINKED']);
      expect(rows[0]?.actorUserId).toBe(boss.id);
      expect(rows[0]?.diff).toMatchObject({
        telegramUserId: { from: '555000444', to: '555000445' },
      });
    });

    it('cannot remove the id: null is refused by the contract and the link stays [C, 2026-10-28]', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const account = await created(boss, { telegramUserId: '555000446' });
      expect((await setTelegram(boss, account.id, null)).status).toBe(422);
      const stored = await t.prisma.user.findUniqueOrThrow({ where: { id: account.id } });
      expect(stored.telegramUserId).toBe(555000446n);
      expect(
        await t.prisma.auditLog.count({ where: { action: { startsWith: 'STAFF_TELEGRAM_' } } }),
      ).toBe(0);
    });

    it('is idempotent and writes no audit row when nothing changes', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const account = await created(boss, { telegramUserId: '555000666' });
      expect((await setTelegram(boss, account.id, '555000666')).status).toBe(200);
      expect(
        await t.prisma.auditLog.count({ where: { action: { startsWith: 'STAFF_TELEGRAM_' } } }),
      ).toBe(0);
    });

    it('refuses an id that belongs to another person, a customer target, and a manager touching an admin', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const manager = await staff({ staff: ['MANAGER'] });
      const account = await created(boss);
      const customer = await makeUser(t.prisma);
      expect((await setTelegram(boss, account.id, manager.telegramUserId.toString())).status).toBe(
        422,
      );
      expect((await setTelegram(boss, customer.id, '555000555')).status).toBe(422);
      expect((await setTelegram(manager, boss.id, '555000556')).status).toBe(403);
      expect((await setTelegram(manager, boss.id, '555000558')).status).toBe(403);
      expect((await setTelegram(manager, account.id, '555000557')).status).toBe(200);
      const target = await t.prisma.user.findUniqueOrThrow({ where: { id: boss.id } });
      expect(target.telegramUserId).toBe(boss.telegramUserId);
    });
  });

  describe('uniform refusal and rate limit', () => {
    it('answers a manager the same for a missing id as for an administrator id', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const manager = await staff({ staff: ['MANAGER'] });
      const missing = await setTelegram(
        manager,
        '11111111-1111-4111-8111-111111111111',
        '555000600',
      );
      const admin = await setTelegram(manager, boss.id, '555000600');
      expect(missing.status).toBe(403);
      expect(missing.body).toEqual(admin.body);
      const asAdmin = await setTelegram(boss, '11111111-1111-4111-8111-111111111111', '555000600');
      expect(asAdmin.status).toBe(404);
    });

    it('limits account creation and Telegram links per actor with 429 and Retry-After', async () => {
      const manager = await staff({ staff: ['MANAGER'] });
      const other = await staff({ staff: ['MANAGER'] });
      for (let i = 0; i < 10; i += 1) {
        const res = await create(manager, accountBody({ login: `user${i}@iorder.uz` }));
        expect(res.status).toBe(201);
      }
      const limited = await create(manager, accountBody({ login: 'user11@iorder.uz' }));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      const link = await setTelegram(manager, other.id, '555000700');
      expect(link.status).toBe(429);
      // Another actor has their own budget; the window ends with time.
      expect((await create(other, accountBody({ login: 'user12@iorder.uz' }))).status).toBe(201);
      t.clock.set(new Date(t.clock.now().getTime() + 61_000));
      expect((await create(manager, accountBody({ login: 'user13@iorder.uz' }))).status).toBe(201);
    });
  });

  describe('list', () => {
    it('lists staff only, with login, roles, status, telegramLinked and the last sign-in', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      await makeUser(t.prisma); // a customer-like user with no role
      const account = await created(boss, { roles: ['DRIVER'] });
      let list = staffAccountListResponseSchema.parse(
        (await t.request('GET', '/staff/accounts', { headers: tmaOf(boss) })).body,
      );
      expect(list.items.map((i) => i.id).sort()).toEqual([boss.id, account.id].sort());
      const find = (id: string): StaffAccountResponse => {
        const item = list.items.find((i) => i.id === id);
        if (!item) throw new Error('missing');
        return item;
      };
      expect(find(boss.id)).toMatchObject({
        login: null,
        hasPassword: false,
        telegramLinked: true,
      });
      expect(find(account.id)).toMatchObject({ login: 'dilnoza@iorder.uz', lastSignInAt: null });

      await passwordLogin('dilnoza@iorder.uz', GOOD_PASSWORD);
      list = staffAccountListResponseSchema.parse(
        (await t.request('GET', '/staff/accounts', { headers: tmaOf(boss) })).body,
      );
      expect(find(account.id).lastSignInAt).toBe(t.clock.now().toISOString());
      expect(Object.keys(find(account.id)).sort()).toEqual([
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

  describe('database guards', () => {
    it('accepts email-like and legacy logins and refuses malformed ones', async () => {
      const person = await staff();
      const hash = await hasher.hash(GOOD_PASSWORD);
      const insert = (login: string) =>
        t.prisma
          .$executeRaw`INSERT INTO staff_credentials (user_id, scope, login, password_hash, password_changed_at)
          VALUES (${person.id}::uuid, 'STAFF', ${login}, ${hash}, now())
          ON CONFLICT (user_id) DO UPDATE SET login = EXCLUDED.login`;
      for (const ok of ['legacy.login', 'a.b+c@sub.iorder.uz', `${'a'.repeat(50)}@iorder.uz`]) {
        await expect(insert(ok), ok).resolves.toBeDefined();
      }
      for (const bad of [
        'A@iorder.uz',
        'a@iorder',
        'a..b@iorder.uz',
        '.a@iorder.uz',
        'a@-x.uz',
        'a@iorder.u1',
        `${'a'.repeat(60)}@iorder.uz`,
      ]) {
        await expect(insert(bad), bad).rejects.toThrow(/login_format/);
      }
    });

    it('refuses a person with neither a Telegram id nor a staff role', async () => {
      await expect(
        t.prisma.user.create({ data: { telegramUserId: null, fullName: 'Nobody' } }),
      ).rejects.toThrow(/telegram_id_required/);
      // With a role in the same transaction the same row is fine.
      await expect(
        t.prisma.user.create({
          data: {
            telegramUserId: null,
            fullName: 'Staff',
            roles: { create: [{ role: 'DRIVER' }] },
          },
        }),
      ).resolves.toBeDefined();
    });

    it('refuses to unlink a customer, and to remove the last role of an unlinked staff member', async () => {
      const customer = await makeUser(t.prisma);
      await expect(
        t.prisma.user.update({ where: { id: customer.id }, data: { telegramUserId: null } }),
      ).rejects.toThrow(/telegram_id_required/);

      const unlinked = await t.prisma.user.create({
        data: { telegramUserId: null, fullName: 'Staff', roles: { create: [{ role: 'DRIVER' }] } },
      });
      await expect(
        t.prisma.userRole.delete({
          where: { userId_role: { userId: unlinked.id, role: 'DRIVER' } },
        }),
      ).rejects.toThrow(/telegram_id_required/);
    });

    it('answers a clean 409 when the last role of an unlinked staff member is removed through the API', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      // An account from before the mandatory id (the api can no longer create or produce one).
      const account = await t.prisma.user.create({
        data: { telegramUserId: null, fullName: 'Legacy', roles: { create: [{ role: 'DRIVER' }] } },
      });
      const res = await t.request('DELETE', `/staff/users/${account.id}/roles/DRIVER`, {
        headers: tmaOf(boss),
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { reason: 'TELEGRAM_ID_REQUIRED' } });
      expect(await t.prisma.userRole.count({ where: { userId: account.id } })).toBe(1);
    });
  });

  describe('bootstrap of the administrator', () => {
    const accounts = () => t.get(StaffAccountsService);
    const input = { login: 'toxfim@iorder.uz', password: 'Dev-password-1' };
    it('tells whether a different login would add another administrator', async () => {
      await expect(accounts().otherActiveAdminsExist(input.login)).resolves.toBe(false);
      await accounts().bootstrapAdminAccount(input);
      await expect(accounts().otherActiveAdminsExist(input.login)).resolves.toBe(false);
      await expect(accounts().otherActiveAdminsExist('second@iorder.uz')).resolves.toBe(true);
    });

    it('creates the administrator, signs in, and audits it as BOOTSTRAP without secrets', async () => {
      await expect(accounts().bootstrapAdminAccount(input)).resolves.toEqual({
        userCreated: true,
        passwordSet: true,
      });
      const res = await passwordLogin('toxfim@iorder.uz', input.password);
      expect(res.status).toBe(200);
      expect(staffSignInResponseSchema.parse(res.body).me.staffRoles).toEqual(['ADMIN']);
      const rows = await t.prisma.auditLog.findMany({
        where: { action: { startsWith: 'BOOTSTRAP_' } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: null,
        action: 'BOOTSTRAP_ADMIN_ACCOUNT_CREATED',
      });
      const text = JSON.stringify(await t.prisma.auditLog.findMany());
      expect(text).not.toContain(input.password);
      expect(text).not.toContain('scrypt');
    });

    it('is idempotent: the same login and password again changes and audits nothing', async () => {
      await accounts().bootstrapAdminAccount(input);
      const audit = await t.prisma.auditLog.count();
      await expect(accounts().bootstrapAdminAccount(input)).resolves.toEqual({
        userCreated: false,
        passwordSet: false,
      });
      expect(await t.prisma.auditLog.count()).toBe(audit);
      expect(await t.prisma.user.count()).toBe(1);
    });

    it('replaces the password of the existing administrator and ends their sessions', async () => {
      await accounts().bootstrapAdminAccount(input);
      const session = staffSignInResponseSchema.parse(
        (await passwordLogin(input.login, input.password)).body,
      );
      const next = { ...input, password: 'A much longer real password' };
      await expect(accounts().bootstrapAdminAccount(next)).resolves.toEqual({
        userCreated: false,
        passwordSet: true,
      });
      expect((await passwordLogin(input.login, input.password)).status).toBe(401);
      expect((await passwordLogin(input.login, next.password)).status).toBe(200);
      expect(
        (await t.request('GET', '/me', { headers: { authorization: `Bearer ${session.token}` } }))
          .status,
      ).toBe(401);
      expect(await t.prisma.user.count()).toBe(1);
    });

    it('enforces the minimum length of 8', async () => {
      await expect(
        accounts().bootstrapAdminAccount({ login: 'second@iorder.uz', password: 'sevench' }),
      ).rejects.toMatchObject({ issues: [{ message: expect.stringMatching(/at least 8/) }] });
      await expect(
        accounts().bootstrapAdminAccount({ login: 'second@iorder.uz', password: 'eightchr' }),
      ).resolves.toMatchObject({ userCreated: true });
    });

    it('refuses a login of someone who is not an administrator, and a blocked administrator', async () => {
      const boss = await staff({ staff: ['ADMIN'] });
      const account = await created(boss, { login: 'driver@iorder.uz', roles: ['DRIVER'] });
      await expect(
        accounts().bootstrapAdminAccount({
          login: 'driver@iorder.uz',
          password: 'Another-pass-123',
        }),
      ).rejects.toMatchObject({
        issues: [{ message: expect.stringMatching(/not an administrator/) }],
      });
      const roles = await t.prisma.userRole.findMany({ where: { userId: account.id } });
      expect(roles.map((r) => r.role)).toEqual(['DRIVER']);

      await accounts().bootstrapAdminAccount(input);
      await t.prisma.user.updateMany({
        where: { fullName: 'Administrator' },
        data: { status: 'BLOCKED' },
      });
      await expect(
        accounts().bootstrapAdminAccount({ ...input, password: 'Another-pass-123' }),
      ).rejects.toThrow(/blocked/);
      await expect(accounts().bootstrapAdminAccount(input)).rejects.toThrow(/blocked/);
    });
  });
});
