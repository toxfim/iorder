import { CUSTOMER_HOME_ROUTES, customerHomeRecommendationsResponseSchema } from '@iorder/shared';
import {
  PRODUCT_SUCCESSION_ROUTES,
  findProductSuccessionsResponseSchema,
  productSuccessionListResponseSchema,
  productSuccessionSchema,
} from '@iorder/shared/staff-cost';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { RecommendationsModule } from '../src/modules/recommendations/index.js';
import {
  findForbiddenKeys,
  findStaffOnlyFieldsInCustomerHome,
} from './support/forbidden-fields.js';
import { makeUser, staffActor } from './support/identity-fixtures.js';
import { makeProduct, publishPriceList } from './support/orders-fixtures.js';
import {
  CUSTOMER_FORBIDDEN_KEYS,
  caller,
  expectError,
  expectParsed,
  type Reply,
} from './support/orders-http.js';
import { createWorld, orderAt, stockUp, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// The customer home recommendations [C, owner 2026-11-09] over real HTTP and a real PostgreSQL:
// what the organization bought (reorder), what matches it (same categories), and the "newer
// model" only from a pair staff confirmed. Two organizations, so isolation is tested, not assumed.

interface Shop {
  buds6: string;
  buds8: string;
  hocoCable: string;
  baseusCable: string;
  spark: string;
}

const AUDIO = 'Аудио';
const CABLES = 'Кабели';
const PHONES = 'Смартфоны';

describe('customer home recommendations (real PostgreSQL)', () => {
  let t: TestApp;
  let w: World;
  let shop: Shop;
  let call: ReturnType<typeof caller>;
  let purchasingManager: Actor;

  beforeAll(async () => {
    t = await createTestApp([OrdersModule, RecommendationsModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });

  const product = async (code: string, names: { UZ: string; RU: string }, category: string) => {
    const id = await makeProduct(w.prisma, { code, names });
    await w.prisma.product.update({ where: { id }, data: { category } });
    await stockUp(w.prisma, id, '1000');
    return id;
  };

  beforeEach(async () => {
    w = await createWorld(t);
    call = caller(w);
    purchasingManager = staffActor(
      (await makeUser(w.prisma, { name: 'Purchasing', staff: ['PURCHASING_MANAGER'] })).id,
      'PURCHASING_MANAGER',
    );
    shop = {
      buds6: await product('BUDS-6', { UZ: 'Redmi Buds 6', RU: 'Наушники Redmi Buds 6' }, AUDIO),
      buds8: await product('BUDS-8', { UZ: 'Redmi Buds 8', RU: 'Наушники Redmi Buds 8' }, AUDIO),
      hocoCable: await product('HOCO-C', { UZ: 'Hoco kabel', RU: 'Кабель Hoco' }, CABLES),
      baseusCable: await product('BASEUS-C', { UZ: 'Baseus kabel', RU: 'Кабель Baseus' }, CABLES),
      spark: await product('SPARK-20', { UZ: 'Tecno Spark 20', RU: 'Tecno Spark 20' }, PHONES),
    };
    await publishPriceList(
      w.pricing,
      {
        [w.products.p1]: '1500.00',
        [w.products.p2]: '750.50',
        [shop.buds6]: '100.00',
        [shop.buds8]: '150.00',
        [shop.hocoCable]: '20.00',
        [shop.baseusCable]: '25.00',
        [shop.spark]: '2000.00',
      },
      w.prisma,
    );
  });

  /** A received order of organization A (the owner confirms), at the given time. */
  async function receivedA(at: string, items: readonly [string, string][]): Promise<void> {
    t.clock.set(new Date(at));
    await orderAt(w, 'RECEIVED', { placedBy: w.actors.sellerA, items });
  }

  /** The two purchases of the tests: buds twice (10 then 20 pieces) and one cable, earlier. */
  async function buyAsA(): Promise<void> {
    await receivedA('2026-10-01T08:00:00Z', [
      [shop.buds6, '10'],
      [shop.hocoCable, '5'],
    ]);
    await receivedA('2026-10-10T08:00:00Z', [[shop.buds6, '20']]);
  }

  const home = async (actor: Actor): Promise<Reply> => {
    const reply = await call(CUSTOMER_HOME_ROUTES.getRecommendations, { actor });
    if (reply.status < 300) assertHomeSafe(reply.body);
    return reply;
  };

  function assertHomeSafe(body: unknown): void {
    expect(findForbiddenKeys(body)).toEqual([]);
    expect(findStaffOnlyFieldsInCustomerHome(body)).toEqual([]);
    const text = JSON.stringify(body);
    for (const key of CUSTOMER_FORBIDDEN_KEYS) expect(text).not.toContain(`"${key}"`);
    for (const id of [w.ids.manager, w.ids.admin, w.ids.accountant]) expect(text).not.toContain(id);
    for (const category of [AUDIO, CABLES, PHONES]) expect(text).not.toContain(category);
  }

  const parsedHome = async (actor: Actor) =>
    expectParsed(await home(actor), 200, customerHomeRecommendationsResponseSchema);

  describe('the three blocks', () => {
    it('reorder: bought products in the list, longest since the last receipt first, with the usual quantity', async () => {
      await buyAsA();
      const answer = await parsedHome(w.actors.ownerA);
      expect(
        answer.reorder.map((row) => [
          row.productCode,
          row.usualQuantity,
          row.timesOrdered,
          row.lastReceivedAt,
        ]),
      ).toEqual([
        ['HOCO-C', '5', 1, '2026-10-01T08:00:00.000Z'],
        ['BUDS-6', '20', 2, '2026-10-10T08:00:00.000Z'],
      ]);
      // A price list card like the customer list, with the stock figure and the photo fields.
      expect(answer.reorder[0]).toMatchObject({ price: '20.00', currency: 'UZS', imageUrl: null });
      expect(typeof answer.reorder[0]?.orderableStock).toBe('number');
    });

    it('matching: products of the bought categories that were not bought, never the bought ones', async () => {
      await buyAsA();
      const answer = await parsedHome(w.actors.ownerA);
      // Audio was bought last, so its match comes first; phones were never bought.
      expect(answer.matching.map((row) => [row.productCode, row.boughtProductName])).toEqual([
        ['BUDS-8', 'Redmi Buds 6'],
        ['BASEUS-C', 'Hoco kabel'],
      ]);
    });

    it('a product that left the price list is in no block', async () => {
      await buyAsA();
      await w.prisma.product.update({ where: { id: shop.hocoCable }, data: { isActive: false } });
      const answer = await parsedHome(w.actors.ownerA);
      expect(answer.reorder.map((row) => row.productCode)).toEqual(['BUDS-6']);
      expect(answer.matching.map((row) => row.productCode)).toEqual(['BUDS-8', 'BASEUS-C']);
    });

    it('only RECEIVED orders count as purchases', async () => {
      t.clock.set(new Date('2026-10-05T08:00:00Z'));
      await orderAt(w, 'DELIVERED', { placedBy: w.actors.sellerA, items: [[shop.spark, '1']] });
      expect(await parsedHome(w.actors.ownerA)).toEqual({
        reorder: [],
        matching: [],
        newerModel: null,
      });
    });

    it('a first visit (no received order) answers three empty blocks', async () => {
      expect(await parsedHome(w.actors.sellerA)).toEqual({
        reorder: [],
        matching: [],
        newerModel: null,
      });
    });
  });

  describe('isolation and audience', () => {
    it('an organization sees only its own purchases', async () => {
      await buyAsA();
      t.clock.set(new Date('2026-10-12T08:00:00Z'));
      // The world's RECEIVED step is owner A's; B's owner confirms B's order.
      const delivered = await orderAt(w, 'DELIVERED', {
        placedBy: w.actors.sellerB,
        items: [[shop.spark, '1']],
      });
      await w.step(w.actors.ownerB, delivered.id, { to: 'RECEIVED' });

      const a = await parsedHome(w.actors.sellerA);
      expect(a.reorder.map((row) => row.productCode)).toEqual(['HOCO-C', 'BUDS-6']);
      expect(a.matching.map((row) => row.productCode)).not.toContain('SPARK-20');

      const b = await parsedHome(w.actors.ownerB);
      expect(b.reorder.map((row) => row.productCode)).toEqual(['SPARK-20']);
      expect(b.matching).toEqual([]);
    });

    it('a staff member is the viewer here and gets empty blocks', async () => {
      await buyAsA();
      for (const actor of [w.actors.manager, w.actors.admin, w.actors.accountant]) {
        expect(await parsedHome(actor)).toEqual({ reorder: [], matching: [], newerModel: null });
      }
    });

    it('needs an authenticated caller', async () => {
      expectError(await call(CUSTOMER_HOME_ROUTES.getRecommendations), 401, 'UNAUTHENTICATED');
    });
  });

  describe('newer-model pairs', () => {
    const find = (actor: Actor) =>
      call(PRODUCT_SUCCESSION_ROUTES.findProductSuccessions, { actor });
    const list = (actor: Actor, status?: string) =>
      call(PRODUCT_SUCCESSION_ROUTES.listProductSuccessions, {
        actor,
        ...(status === undefined ? {} : { query: { status } }),
      });
    const decide = (actor: Actor, id: string, decision: string) =>
      call(PRODUCT_SUCCESSION_ROUTES.decideProductSuccession, {
        actor,
        params: { id },
        body: { decision },
      });

    async function proposeBuds(): Promise<string> {
      const found = expectParsed(
        await find(w.actors.manager),
        200,
        findProductSuccessionsResponseSchema,
      );
      expect(found.proposedCount).toBe(1);
      const proposed = expectParsed(
        await list(w.actors.manager),
        200,
        productSuccessionListResponseSchema,
      );
      expect(proposed.counts).toEqual({ PROPOSED: 1, CONFIRMED: 0, REJECTED: 0 });
      const [pair] = proposed.items;
      expect(pair).toMatchObject({
        status: 'PROPOSED',
        decidedAt: null,
        decidedBy: null,
        older: { productCode: 'BUDS-6', name: 'Redmi Buds 6', priced: true, isActive: true },
        newer: { productCode: 'BUDS-8', name: 'Redmi Buds 8', priced: true, isActive: true },
      });
      return pair!.id;
    }

    it('the generator proposes a bought older model with a newer one of the same line, once', async () => {
      await buyAsA();
      await proposeBuds();
      // The cables have no generation number; the phone was never bought. Running again adds nothing.
      const again = expectParsed(
        await find(w.actors.admin),
        200,
        findProductSuccessionsResponseSchema,
      );
      expect(again.proposedCount).toBe(0);
      const audit = await w.prisma.auditLog.findMany({
        where: { entityType: 'PRODUCT_SUCCESSION' },
      });
      expect(audit.map((row) => [row.action, row.actorUserId])).toEqual([
        ['PROPOSED', w.ids.manager],
      ]);
    });

    it('a proposed pair never reaches a customer; a confirmed one is the hero, a rejected one is not', async () => {
      await buyAsA();
      const id = await proposeBuds();
      expect((await parsedHome(w.actors.ownerA)).newerModel).toBeNull();

      t.clock.set(new Date('2026-10-20T09:00:00Z'));
      const confirmed = expectParsed(
        await decide(w.actors.manager, id, 'CONFIRMED'),
        200,
        productSuccessionSchema,
      );
      expect(confirmed).toMatchObject({
        status: 'CONFIRMED',
        decidedAt: '2026-10-20T09:00:00.000Z',
        decidedBy: 'Manager',
        decidedByUserId: w.ids.manager,
      });
      const withHero = await parsedHome(w.actors.ownerA);
      expect(withHero.newerModel).toMatchObject({
        productCode: 'BUDS-8',
        replacesProductName: 'Redmi Buds 6',
        replacesTimesOrdered: 2,
        price: '150.00',
      });
      // The hero is not repeated among the matching cards.
      expect(withHero.matching.map((row) => row.productCode)).toEqual(['BASEUS-C']);
      // Organization B never bought the older model: no hero for it.
      expect((await parsedHome(w.actors.ownerB)).newerModel).toBeNull();

      const rejected = expectParsed(
        await decide(w.actors.admin, id, 'REJECTED'),
        200,
        productSuccessionSchema,
      );
      expect(rejected.status).toBe('REJECTED');
      expect((await parsedHome(w.actors.ownerA)).newerModel).toBeNull();
      const counts = expectParsed(
        await list(w.actors.manager, 'REJECTED'),
        200,
        productSuccessionListResponseSchema,
      );
      expect(counts.counts).toEqual({ PROPOSED: 0, CONFIRMED: 0, REJECTED: 1 });
      expect(counts.items.map((item) => item.id)).toEqual([id]);

      const audit = await w.prisma.auditLog.findMany({
        where: { entityType: 'PRODUCT_SUCCESSION', entityId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((row) => [row.action, row.actorUserId])).toEqual([
        ['CONFIRMED', w.ids.manager],
        ['REJECTED', w.ids.admin],
      ]);
    });

    it('a newer model the organization already buys is not offered', async () => {
      await buyAsA();
      const id = await proposeBuds();
      await decide(w.actors.manager, id, 'CONFIRMED');
      await receivedA('2026-10-15T08:00:00Z', [[shop.buds8, '3']]);
      const answer = await parsedHome(w.actors.ownerA);
      expect(answer.newerModel).toBeNull();
      expect(answer.reorder.map((row) => row.productCode)).toEqual(['HOCO-C', 'BUDS-6', 'BUDS-8']);
    });

    it('the database refuses a decided pair going back to PROPOSED or changing its products', async () => {
      await buyAsA();
      const id = await proposeBuds();
      await decide(w.actors.manager, id, 'CONFIRMED');
      await expect(
        w.prisma
          .$executeRaw`UPDATE product_successions SET status = 'PROPOSED', decided_by = NULL, decided_at = NULL WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/cannot become a proposal again/);
      await expect(
        w.prisma
          .$executeRaw`UPDATE product_successions SET newer_product_id = ${shop.spark}::uuid WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/pair is fixed/);
      await expect(
        w.prisma.$executeRaw`DELETE FROM product_successions WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/cannot be deleted/);
    });

    it('roles: manager and admin decide, the purchasing manager reads, nobody else', async () => {
      await buyAsA();
      const id = await proposeBuds();
      expect((await list(purchasingManager)).status).toBe(200);
      expectError(await find(purchasingManager), 403, 'FORBIDDEN');
      expectError(await decide(purchasingManager, id, 'CONFIRMED'), 403, 'FORBIDDEN');
      for (const actor of [
        w.actors.accountant,
        w.actors.warehouse,
        w.actors.driver,
        w.actors.ownerA,
        w.actors.sellerB,
      ]) {
        expectError(await list(actor), 403, 'FORBIDDEN');
        expectError(await find(actor), 403, 'FORBIDDEN');
        expectError(await decide(actor, id, 'CONFIRMED'), 403, 'FORBIDDEN');
      }
      expectError(await decide(w.actors.manager, randomUUID(), 'CONFIRMED'), 404, 'NOT_FOUND');
      expectError(await decide(w.actors.manager, id, 'PROPOSED'), 422, 'VALIDATION_FAILED');
      expectError(await list(w.actors.manager, 'OPEN'), 422, 'VALIDATION_FAILED');
    });
  });
});
