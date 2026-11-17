import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityModule } from '../src/modules/identity/index.js';
import { OrganizationsModule } from '../src/modules/organizations/index.js';
import { PasswordHasher } from '../src/modules/identity/password-hasher.js';
import { makeMember, makeOrganization, makeUser } from './support/identity-fixtures.js';
import { FAKE_BOT_TOKEN, signedInitData, tma } from './support/init-data.js';
import { signedLoginWidget } from './support/login-widget.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';

const password = 'customer secret password';
describe('customer website authentication (real PostgreSQL)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp([IdentityModule, OrganizationsModule], {
      botToken: FAKE_BOT_TOKEN,
      overrides: [{ token: PasswordHasher, value: new PasswordHasher({ N: 1024, r: 8, p: 1 }) }],
    });
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetIdentity(t.prisma);
    t.clock.set(new Date(t.clock.now().getTime() + 3_600_000));
  });
  async function customer() {
    const user = await makeUser(t.prisma);
    const org = await makeOrganization(t.prisma);
    await makeMember(t.prisma, org.id, user.id);
    return {
      user,
      org,
      headers: tma(signedInitData({ telegramUserId: user.telegramUserId, now: t.clock.now() })),
    };
  }
  function tokenFrom(body: unknown): string {
    expect(body).toHaveProperty('token');
    return (body as { token: string }).token;
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  it('creates credentials via Telegram, signs in by password and resolves only the own organization', async () => {
    const { user, org, headers } = await customer();
    const saved = await t.request('PUT', '/customer/auth/credentials', {
      headers,
      body: { login: 'my.shop', password },
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(password);
    const signedIn = await t.request('POST', '/customer/auth/password-login', {
      body: { login: 'MY.SHOP', password },
    });
    expect(signedIn.status).toBe(200);
    const auth = bearer(tokenFrom(signedIn.body));
    const me = await t.request('GET', '/me', { headers: auth });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ userId: user.id, membership: { organizationId: org.id } });
    expect((await t.request('GET', '/staff/users', { headers: auth })).status).toBe(403);
    expect(
      (
        await t.request('PUT', '/customer/auth/credentials', {
          headers: auth,
          body: { login: 'other', password },
        })
      ).status,
    ).toBe(403);
    await t.prisma.organizationMember.updateMany({
      where: { userId: user.id },
      data: { status: 'LEFT', leftAt: t.clock.now() },
    });
    expect((await t.request('GET', '/me', { headers: auth })).status).toBe(401);
  });
  it('keeps customer and staff logins in separate namespaces: no "taken" answer about staff logins [C, 2026-10-28]; the staff door opens for staff logins only, the customer door lets a staff login in as a viewer [C, 2026-11-09]', async () => {
    const { headers } = await customer();
    const manager = await makeUser(t.prisma, { staff: ['MANAGER'] });
    const staffPassword = 'manager secret password';
    await t.prisma.staffCredential.create({
      data: {
        userId: manager.id,
        scope: 'STAFF',
        login: 'shared.login',
        passwordHash: await t.get(PasswordHasher).hash(staffPassword),
        passwordChangedAt: t.clock.now(),
      },
    });

    // The customer may take the very login a staff member holds: nothing is revealed.
    const saved = await t.request('PUT', '/customer/auth/credentials', {
      headers,
      body: { login: 'shared.login', password },
    });
    expect(saved.status).toBe(200);

    const customerDoor = (p: string) =>
      t.request('POST', '/customer/auth/password-login', {
        body: { login: 'shared.login', password: p },
      });
    const staffDoor = (p: string) =>
      t.request('POST', '/auth/password-login', { body: { login: 'shared.login', password: p } });
    // The customer door tries the customer login first: the customer, in their organization.
    const asCustomer = await customerDoor(password);
    expect(asCustomer.status).toBe(200);
    expect(
      (await t.request('GET', '/me', { headers: bearer(tokenFrom(asCustomer.body)) })).body,
    ).toMatchObject({ membership: { role: 'SELLER' }, staffViewer: null });
    // Then the staff login ([C] 2026-11-09, this reverses "the customer door looks only among
    // customer logins"): the staff member comes in as a VIEWER, with no staff power and no
    // organization.
    const asStaff = await customerDoor(staffPassword);
    expect(asStaff.status).toBe(200);
    const viewer = bearer(tokenFrom(asStaff.body));
    expect((await t.request('GET', '/me', { headers: viewer })).body).toMatchObject({
      userId: manager.id,
      staffRoles: [],
      membership: null,
      staffViewer: { canOrder: false, organizationName: null },
    });
    expect((await t.request('GET', '/staff/users', { headers: viewer })).status).toBe(403);
    // The staff door is unchanged: staff logins only, whatever the password.
    expect((await staffDoor(staffPassword)).status).toBe(200);
    expect((await staffDoor(password)).status).toBe(401);

    // Two customers still cannot share a login.
    const other = await customer();
    const clash = await t.request('PUT', '/customer/auth/credentials', {
      headers: other.headers,
      body: { login: 'shared.login', password },
    });
    expect(clash.status).toBe(422);
  });
  it('accepts a signed Telegram widget and rejects replay and forgery; a staff member comes in as a viewer only [C, 2026-11-09]', async () => {
    const { user } = await customer();
    const proof = signedLoginWidget({ telegramUserId: user.telegramUserId, now: t.clock.now() });
    expect(
      (
        await t.request('POST', '/customer/auth/telegram-widget', {
          body: { ...proof, hash: '0'.repeat(64) },
        })
      ).status,
    ).toBe(401);
    const result = await t.request('POST', '/customer/auth/telegram-widget', { body: proof });
    expect(result.status).toBe(200);
    const auth = bearer(tokenFrom(result.body));
    expect(
      (
        await t.request('PUT', '/customer/auth/credentials', {
          headers: auth,
          body: { login: 'my.shop', password },
        })
      ).status,
    ).toBe(200);
    expect((await t.request('GET', '/me', { headers: auth })).status).toBe(401);
    expect(
      (await t.request('POST', '/customer/auth/telegram-widget', { body: proof })).status,
    ).toBe(401);
    // A staff member's proof used to be refused here; since [C] 2026-11-09 it opens a VIEWER
    // session: no staff role, no organization, and the customer credential routes stay closed.
    const staff = await makeUser(t.prisma, { staff: ['MANAGER'] });
    const staffIn = await t.request('POST', '/customer/auth/telegram-widget', {
      body: signedLoginWidget({ telegramUserId: staff.telegramUserId, now: t.clock.now() }),
    });
    expect(staffIn.status).toBe(200);
    const viewer = bearer(tokenFrom(staffIn.body));
    expect((await t.request('GET', '/me', { headers: viewer })).body).toMatchObject({
      staffRoles: [],
      membership: null,
      staffViewer: { canOrder: false, organizationName: null },
    });
    expect((await t.request('GET', '/staff/users', { headers: viewer })).status).toBe(403);
    expect(
      (
        await t.request('PUT', '/customer/auth/credentials', {
          headers: viewer,
          body: { login: 'staff.as.customer', password },
        })
      ).status,
    ).toBe(403);
    // Staff whose roles do not open the customer app are still refused, like anyone unknown.
    const driver = await makeUser(t.prisma, { staff: ['DRIVER'] });
    expect(
      (
        await t.request('POST', '/customer/auth/telegram-widget', {
          body: signedLoginWidget({ telegramUserId: driver.telegramUserId, now: t.clock.now() }),
        })
      ).status,
    ).toBe(401);
  });
  it('keeps credentials unique, rejects anonymous writes and revokes password sessions on reset', async () => {
    const first = await customer();
    const second = await customer();
    const body = { login: 'my.shop', password };
    expect((await t.request('PUT', '/customer/auth/credentials', { body })).status).toBe(401);
    expect(
      (await t.request('PUT', '/customer/auth/credentials', { headers: first.headers, body }))
        .status,
    ).toBe(200);
    expect(
      (await t.request('PUT', '/customer/auth/credentials', { headers: second.headers, body }))
        .status,
    ).toBe(422);
    const login = await t.request('POST', '/customer/auth/password-login', { body });
    const auth = bearer(tokenFrom(login.body));
    expect(
      (
        await t.request('PUT', '/customer/auth/credentials', {
          headers: first.headers,
          body: { ...body, password: 'another customer secret' },
        })
      ).status,
    ).toBe(200);
    expect((await t.request('GET', '/me', { headers: auth })).status).toBe(401);
    expect((await t.request('POST', '/customer/auth/password-login', { body })).status).toBe(401);
  });
});
