import { staffPersonCardSchema } from '@iorder/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { IdentityModule } from '../src/modules/identity/index.js';
import { OrganizationsModule } from '../src/modules/organizations/index.js';
import { PricingModule } from '../src/modules/pricing/index.js';
import {
  customerActor,
  makeMember,
  makeOrganization,
  makeUser,
  staffActor,
} from './support/identity-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetCatalogPricingAudit, resetIdentity } from './support/test-db.js';

type Body = Record<string, unknown>;

describe('person names and the person card (real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([IdentityModule, OrganizationsModule, CatalogModule, PricingModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetCatalogPricingAudit(t.prisma);
    await resetIdentity(t.prisma);
  });

  async function world() {
    const manager = await makeUser(t.prisma, {
      name: 'Aziza Yusupova',
      phone: '+998901112233',
      staff: ['MANAGER'],
    });
    const org = await makeOrganization(t.prisma, { name: 'Alpha shop' });
    const owner = await makeUser(t.prisma, { name: 'Owner', phone: '+998905556677' });
    await makeMember(t.prisma, org.id, owner.id, 'SHOP_OWNER');
    return { manager, org, owner, asManager: staffActor(manager.id, 'MANAGER') };
  }

  const card = (id: string, actor: Actor | undefined) =>
    t.request('GET', `/staff/people/${id}`, { actor });

  describe('authors are names, never ids', () => {
    it('the USD rate names who set it', async () => {
      const w = await world();
      const put = await t.request('PUT', '/staff/usd-rate', {
        actor: w.asManager,
        body: { rate: '12650.5' },
      });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({
        updatedBy: 'Aziza Yusupova',
        updatedByUserId: w.manager.id,
      });
      expect(JSON.stringify((put.body as Body).updatedBy)).not.toContain(w.manager.id);
    });

    it('a published version and the price history name the publisher', async () => {
      const w = await world();
      const product = await t.prisma.product.create({
        data: {
          productCode: '10482',
          translations: { create: [{ lang: 'UZ', name: 'Olma' }] },
        },
      });
      const published = await t.request('POST', '/staff/price-list/publish', {
        actor: w.asManager,
        body: { baseVersionNumber: null, upserts: [{ productId: product.id, basePrice: '10.00' }] },
      });
      expect(published.status).toBe(200);
      expect(published.body).toMatchObject({
        publishedBy: 'Aziza Yusupova',
        publishedByUserId: w.manager.id,
      });

      const history = await t.request('GET', `/staff/products/${product.id}/price-history`, {
        actor: w.asManager,
      });
      expect((history.body as { entries: Body[] }).entries[0]).toMatchObject({
        publishedBy: 'Aziza Yusupova',
        publishedByUserId: w.manager.id,
      });
    });
  });

  describe('the person card', () => {
    it('gives name, phone and roles of a staff member', async () => {
      const w = await world();
      const r = await card(w.manager.id, w.asManager);
      expect(r.status).toBe(200);
      expect(staffPersonCardSchema.parse(r.body)).toEqual({
        id: w.manager.id,
        fullName: 'Aziza Yusupova',
        phone: '+998901112233',
        status: 'ACTIVE',
        staffRoles: ['MANAGER'],
        membership: null,
      });
    });

    it('gives the organization and role of a customer, and no Telegram id', async () => {
      const w = await world();
      const accountant = await makeUser(t.prisma, { name: 'Acc', staff: ['ACCOUNTANT'] });
      const r = await card(w.owner.id, staffActor(accountant.id, 'ACCOUNTANT'));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        staffRoles: [],
        membership: { organizationName: 'Alpha shop', role: 'SHOP_OWNER' },
      });
      expect(Object.keys(r.body as Body)).not.toContain('telegramUserId');
    });

    it('finds a person by Telegram id, and 404 for a Telegram id nobody has', async () => {
      const w = await world();
      const found = await t.request(
        'GET',
        `/staff/people/by-telegram/${w.owner.telegramUserId.toString()}`,
        { actor: w.asManager },
      );
      expect(found.body).toMatchObject({ id: w.owner.id });
      const missing = await t.request('GET', '/staff/people/by-telegram/987654321', {
        actor: w.asManager,
      });
      expect(missing.status).toBe(404);
    });

    it('is refused to the warehouse, the driver and customers', async () => {
      const w = await world();
      const warehouse = await makeUser(t.prisma, { name: 'W', staff: ['WAREHOUSE_MANAGER'] });
      const driver = await makeUser(t.prisma, { name: 'D', staff: ['DRIVER'] });
      for (const actor of [
        staffActor(warehouse.id, 'WAREHOUSE_MANAGER'),
        staffActor(driver.id, 'DRIVER'),
        customerActor(w.owner.id, w.org.id, 'SHOP_OWNER'),
      ]) {
        expect((await card(w.manager.id, actor)).status).toBe(403);
      }
      expect((await card(w.manager.id, undefined)).status).toBe(401);
    });
  });
});
