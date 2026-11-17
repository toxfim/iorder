import {
  CUSTOMER_GOODS_ROUTES,
  ORDER_ROUTES,
  customerGoodsListSchema,
  customerGoodsProductSchema,
  customerGoodsSummarySchema,
  customerGoodsUnitSchema,
} from '@iorder/shared';
import {
  PRODUCT_TRACKING_ROUTES,
  productCategoryListResponseSchema,
  productCategoryResponseSchema,
  sheetCategoryListResponseSchema,
} from '@iorder/shared/staff-cost';
import {
  STAFF_ORDER_ROUTES,
  STAFF_PICKING_ROUTES,
  pickingResponseSchema,
  type PickingResponse,
} from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { OrdersModule, type OrderView } from '../src/modules/orders/index.js';
import {
  assertCustomerSafe,
  caller,
  expectError,
  expectParsed,
  type CallOptions,
  type Reply,
} from './support/orders-http.js';
import { createWorld, orderAt, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// Valid IMEIs (Luhn).
const IMEI_A = '490154203237518';
const IMEI_B = '356938035643809';
const IMEI_C = '353918000104287';
const IMEI_D = '352099001761481';

describe('unit codes: categories, picking, release gate, My Products (real PostgreSQL)', () => {
  let t: TestApp;
  let w: World;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    t = await createTestApp([OrdersModule, CatalogModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    w = await createWorld(t);
    call = caller(w);
  });

  const asCustomer = async (
    route: Parameters<typeof call>[0],
    options: CallOptions,
  ): Promise<Reply> => {
    const reply = await call(route, options);
    if (reply.status < 300) assertCustomerSafe(reply.body, w);
    return reply;
  };

  /** p1 becomes an IMEI phone with a required marking code, through a category. */
  async function makePhoneCategory(): Promise<void> {
    await w.prisma.product.update({
      where: { id: w.products.p1 },
      data: { category: 'Smartfonlar' },
    });
    const reply = await call(PRODUCT_TRACKING_ROUTES.createCategory, {
      actor: w.actors.manager,
      body: { name: ' smartfonlar ', trackingTypeDefault: 'IMEI', markingRequiredDefault: true },
    });
    const category = expectParsed(reply, 201, productCategoryResponseSchema);
    expect(category.productCount).toBe(1);
  }

  const picking = async (
    orderId: string,
    actor: Actor = w.actors.warehouse,
  ): Promise<PickingResponse> =>
    expectParsed(
      await call(STAFF_PICKING_ROUTES.getPicking, { actor, params: { id: orderId } }),
      200,
      pickingResponseSchema,
    );

  const scan = (
    orderId: string,
    unitId: string,
    body: unknown,
    actor: Actor = w.actors.warehouse,
  ) => call(STAFF_PICKING_ROUTES.recordUnitCode, { actor, params: { id: orderId, unitId }, body });

  const release = async (order: { id: string }): Promise<Reply> => {
    const { rowVersion } = await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    return call(STAFF_ORDER_ROUTES.releaseOrder, {
      actor: w.actors.warehouse,
      params: { id: order.id },
      body: { driverUserId: w.ids.driver, expectedRowVersion: rowVersion },
    });
  };

  /** Scans IMEI1 + marking for every unit of p1 in the order. */
  async function scanAll(order: OrderView, imeis: readonly string[]): Promise<PickingResponse> {
    const view = await picking(order.id);
    const phone = view.lines.find((line) => line.productId === w.products.p1);
    let last = view;
    for (const [index, unit] of (phone?.units ?? []).entries()) {
      expect(
        (await scan(order.id, unit.unitId, { kind: 'IMEI', value: imeis[index] })).status,
      ).toBe(200);
      const reply = await scan(order.id, unit.unitId, {
        kind: 'MARKING',
        value: `0104600000000017215mk${index}abc\u001d93AbCd`,
      });
      last = expectParsed(reply, 200, pickingResponseSchema);
    }
    return last;
  }

  describe('categories are templates', () => {
    it('a new category adopts matching unlinked products; a later change is not retroactive', async () => {
      await makePhoneCategory();
      const product = await w.prisma.product.findUniqueOrThrow({ where: { id: w.products.p1 } });
      expect(product.trackingType).toBe('IMEI');
      expect(product.markingRequired).toBe(true);

      const category = await w.prisma.productCategory.findFirstOrThrow();
      const updated = await call(PRODUCT_TRACKING_ROUTES.updateCategory, {
        actor: w.actors.admin,
        params: { id: category.id },
        body: { trackingTypeDefault: 'SERIAL' },
      });
      expect(updated.status).toBe(200);
      expect(
        (await w.prisma.product.findUniqueOrThrow({ where: { id: w.products.p1 } })).trackingType,
      ).toBe('IMEI');

      const audit = await w.prisma.auditLog.findMany({
        where: { action: 'PRODUCT_TRACKING_CHANGED' },
      });
      expect(audit).toHaveLength(1);
    });

    it('an explicit NONE is a decision: it is marked configured, audited, and never adopted later', async () => {
      await w.prisma.product.update({
        where: { id: w.products.p1 },
        data: { category: 'Smartfonlar' },
      });
      const fresh = await w.prisma.product.findUniqueOrThrow({ where: { id: w.products.p1 } });
      expect(fresh).toMatchObject({ trackingType: 'NONE', codeRuleConfigured: false });

      // The manager saves the stored default unchanged: still a decision, so it is recorded.
      const saved = await call(PRODUCT_TRACKING_ROUTES.updateProductTracking, {
        actor: w.actors.manager,
        params: { id: w.products.p1 },
        body: { trackingType: 'NONE', markingRequired: false },
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ trackingType: 'NONE', codeRuleConfigured: true });
      const audit = await w.prisma.auditLog.findMany({
        where: { action: 'PRODUCT_TRACKING_CHANGED', entityId: w.products.p1 },
      });
      expect(audit.map((a) => a.diff)).toEqual([{ codeRuleConfigured: { from: false, to: true } }]);

      // A category template of the same sheet name no longer adopts it.
      const reply = await call(PRODUCT_TRACKING_ROUTES.createCategory, {
        actor: w.actors.manager,
        body: { name: 'Smartfonlar', trackingTypeDefault: 'IMEI', markingRequiredDefault: true },
      });
      expect(expectParsed(reply, 201, productCategoryResponseSchema).productCount).toBe(0);
      expect(
        await w.prisma.product.findUniqueOrThrow({ where: { id: w.products.p1 } }),
      ).toMatchObject({ trackingType: 'NONE', markingRequired: false, categoryId: null });
    });

    it('duplicate names (ignoring case) and archived categories are refused; the warehouse may not manage', async () => {
      await makePhoneCategory();
      expectError(
        await call(PRODUCT_TRACKING_ROUTES.createCategory, {
          actor: w.actors.manager,
          body: { name: 'SMARTFONLAR', trackingTypeDefault: 'NONE', markingRequiredDefault: false },
        }),
        409,
        'CONFLICT',
        'DUPLICATE_CATEGORY_NAME',
      );
      expect(
        (
          await call(PRODUCT_TRACKING_ROUTES.createCategory, {
            actor: w.actors.warehouse,
            body: { name: 'X', trackingTypeDefault: 'NONE', markingRequiredDefault: false },
          })
        ).status,
      ).toBe(403);
      const category = await w.prisma.productCategory.findFirstOrThrow();
      await call(PRODUCT_TRACKING_ROUTES.updateCategory, {
        actor: w.actors.manager,
        params: { id: category.id },
        body: { isActive: false },
      });
      expectError(
        await call(PRODUCT_TRACKING_ROUTES.updateProductTracking, {
          actor: w.actors.manager,
          params: { id: w.products.p2 },
          body: { categoryId: category.id },
        }),
        409,
        'CONFLICT',
        'CATEGORY_ARCHIVED',
      );
    });
  });

  describe('classifying the sheet categories', () => {
    it('lists sheet categories without a staff category, one row per name ignoring case', async () => {
      await w.prisma.product.update({
        where: { id: w.products.p1 },
        data: { category: 'Telefonlar' },
      });
      await w.prisma.product.update({
        where: { id: w.products.p2 },
        data: { category: 'telefonlar' },
      });
      await w.prisma.product.update({
        where: { id: w.products.p3 },
        data: { category: 'Smartfonlar' },
      });
      await call(PRODUCT_TRACKING_ROUTES.createCategory, {
        actor: w.actors.manager,
        body: { name: 'Smartfonlar', trackingTypeDefault: 'IMEI', markingRequiredDefault: false },
      });

      const reply = await call(PRODUCT_TRACKING_ROUTES.listSheetCategories, {
        actor: w.actors.manager,
      });
      const list = expectParsed(reply, 200, sheetCategoryListResponseSchema);
      expect(list.items).toEqual([
        {
          name: 'Telefonlar',
          productCount: 2,
          suggestedTrackingType: 'IMEI',
          suggestedMarkingRequired: false,
        },
      ]);
      expect(
        (await call(PRODUCT_TRACKING_ROUTES.listSheetCategories, { actor: w.actors.warehouse }))
          .status,
      ).toBe(403);
    });

    it('creates several categories in one transaction, each adopting its products; all or nothing', async () => {
      await w.prisma.product.update({
        where: { id: w.products.p1 },
        data: { category: 'Telefonlar' },
      });
      await w.prisma.product.update({
        where: { id: w.products.p2 },
        data: { category: 'Changyutgichlar' },
      });

      const reply = await call(PRODUCT_TRACKING_ROUTES.createCategories, {
        actor: w.actors.admin,
        body: {
          items: [
            { name: 'Telefonlar', trackingTypeDefault: 'IMEI', markingRequiredDefault: true },
            {
              name: 'Changyutgichlar',
              trackingTypeDefault: 'SERIAL',
              markingRequiredDefault: false,
            },
          ],
        },
      });
      const created = expectParsed(reply, 201, productCategoryListResponseSchema);
      expect(created.items.map((c) => [c.name, c.productCount])).toEqual([
        ['Telefonlar', 1],
        ['Changyutgichlar', 1],
      ]);
      const p1 = await w.prisma.product.findUniqueOrThrow({ where: { id: w.products.p1 } });
      const p2 = await w.prisma.product.findUniqueOrThrow({ where: { id: w.products.p2 } });
      expect([p1.trackingType, p1.markingRequired, p2.trackingType]).toEqual([
        'IMEI',
        true,
        'SERIAL',
      ]);
      expect(await w.prisma.auditLog.count({ where: { action: 'PRODUCT_CATEGORY_CREATED' } })).toBe(
        2,
      );

      // The second name already exists: nothing of this batch is written.
      expectError(
        await call(PRODUCT_TRACKING_ROUTES.createCategories, {
          actor: w.actors.manager,
          body: {
            items: [
              { name: 'Yangi', trackingTypeDefault: 'NONE', markingRequiredDefault: false },
              { name: 'TELEFONLAR', trackingTypeDefault: 'NONE', markingRequiredDefault: false },
            ],
          },
        }),
        409,
        'CONFLICT',
        'DUPLICATE_CATEGORY_NAME',
      );
      expect(await w.prisma.productCategory.count()).toBe(2);
      expect(
        (
          await call(PRODUCT_TRACKING_ROUTES.createCategories, {
            actor: w.actors.manager,
            body: {
              items: [
                { name: 'A', trackingTypeDefault: 'NONE', markingRequiredDefault: false },
                { name: 'a', trackingTypeDefault: 'IMEI', markingRequiredDefault: false },
              ],
            },
          })
        ).status,
      ).toBe(422);
    });
  });

  describe('picking', () => {
    it('creates one unit per piece at ACCOUNTING_CLEARED and gates the release on the codes', async () => {
      await makePhoneCategory();
      const order = await orderAt(w, 'ACCOUNTING_CLEARED');
      const units = await w.prisma.orderUnit.findMany({ where: { orderId: order.id } });
      expect(units).toHaveLength(3); // 2 x p1 + 1 x p2 (quantity goods get rows too)

      const before = await picking(order.id);
      expect(before.editable).toBe(true);
      expect(before.complete).toBe(false);
      expectError(await release(order), 409, 'CONFLICT', 'UNIT_CODES_INCOMPLETE');

      const done = await scanAll(order, [IMEI_A, IMEI_B]);
      expect(done.complete).toBe(true);
      expect((await release(order)).status).toBe(200);

      const events = await w.prisma.orderEvent.findMany({
        where: { orderId: order.id, eventType: 'UNIT_CODE_RECORDED' },
      });
      expect(events).toHaveLength(4);
      const after = await picking(order.id);
      expect(after.editable).toBe(false);
      const phone = after.lines.find((line) => line.productId === w.products.p1);
      expectError(
        await scan(order.id, phone?.units[0]?.unitId ?? '', {
          kind: 'IMEI',
          slot: 2,
          value: IMEI_C,
        }),
        409,
        'CONFLICT',
        'UNIT_CODES_NOT_EDITABLE',
      );
    });

    it('rejects invalid codes, kinds the product does not take, and duplicates on another order', async () => {
      await makePhoneCategory();
      const first = await orderAt(w, 'ACCOUNTING_CLEARED');
      const second = await orderAt(w, 'ACCOUNTING_CLEARED', { placedBy: w.actors.ownerB });
      const unitOf = async (orderId: string) =>
        (await picking(orderId)).lines.find((l) => l.productId === w.products.p1)?.units[0]
          ?.unitId ?? '';
      const nonPhoneUnit =
        (await picking(first.id)).lines.find((l) => l.productId === w.products.p2)?.units[0]
          ?.unitId ?? '';

      expectError(
        await scan(first.id, await unitOf(first.id), { kind: 'IMEI', value: '490154203237519' }),
        422,
        'VALIDATION_FAILED',
      );
      expectError(
        await scan(first.id, nonPhoneUnit, { kind: 'SERIAL', value: 'SN12345' }),
        409,
        'CONFLICT',
        'UNIT_CODE_NOT_REQUIRED',
      );

      expect(
        (await scan(first.id, await unitOf(first.id), { kind: 'IMEI', value: IMEI_A })).status,
      ).toBe(200);
      const dup = expectError(
        await scan(second.id, await unitOf(second.id), { kind: 'IMEI', slot: 2, value: IMEI_A }),
        409,
        'CONFLICT',
        'UNIT_CODE_DUPLICATE',
      );
      expect(dup.details).toMatchObject({ kind: 'IMEI', orderNumber: first.orderNumber });
    });

    it('a rescan voids the old value (never overwritten); a cancel frees the codes', async () => {
      await makePhoneCategory();
      const order = await orderAt(w, 'ACCOUNTING_CLEARED');
      const unitId =
        (await picking(order.id)).lines.find((l) => l.productId === w.products.p1)?.units[0]
          ?.unitId ?? '';
      await scan(order.id, unitId, { kind: 'IMEI', value: IMEI_A });
      await scan(order.id, unitId, { kind: 'IMEI', value: IMEI_C });
      const rows = await w.prisma.unitCode.findMany({
        where: { unitId },
        orderBy: { recordedAt: 'asc' },
      });
      expect(rows.map((r) => [r.codeValue, r.voidReason])).toEqual([
        [IMEI_A, 'REPLACED'],
        [IMEI_C, null],
      ]);
      await expect(
        w.prisma.unitCode.update({ where: { id: rows[1]?.id }, data: { codeValue: IMEI_D } }),
      ).rejects.toThrow();

      const { rowVersion } = await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      await w.orders.transition(w.actors.manager, order.id, {
        to: 'CANCELLED',
        reason: 'customer asked',
        expectedRowVersion: rowVersion,
      });
      expect(await w.prisma.unitCode.count({ where: { orderId: order.id, voidedAt: null } })).toBe(
        0,
      );
      // The freed IMEI can go on another order.
      const next = await orderAt(w, 'ACCOUNTING_CLEARED');
      const nextUnit =
        (await picking(next.id)).lines.find((l) => l.productId === w.products.p1)?.units[0]
          ?.unitId ?? '';
      expect((await scan(next.id, nextUnit, { kind: 'IMEI', value: IMEI_C })).status).toBe(200);
    });

    it('only the warehouse scans; the driver cannot even read the codes', async () => {
      await makePhoneCategory();
      const order = await orderAt(w, 'ACCOUNTING_CLEARED');
      const unitId = (await picking(order.id)).lines[0]?.units[0]?.unitId ?? '';
      expect(
        (await scan(order.id, unitId, { kind: 'IMEI', value: IMEI_A }, w.actors.manager)).status,
      ).toBe(403);
      expect((await picking(order.id, w.actors.manager)).editable).toBe(false);
      expect(
        (
          await call(STAFF_PICKING_ROUTES.getPicking, {
            actor: w.actors.driver,
            params: { id: order.id },
          })
        ).status,
      ).toBe(403);
    });
  });

  describe('My Products', () => {
    async function receivedPhoneOrder(): Promise<OrderView> {
      await makePhoneCategory();
      const order = await orderAt(w, 'ACCOUNTING_CLEARED');
      await scanAll(order, [IMEI_A, IMEI_B]);
      expect((await release(order)).status).toBe(200);
      await w.step(w.actors.driver, order.id, { to: 'DELIVERED' });
      return w.step(w.actors.ownerA, order.id, { to: 'RECEIVED' });
    }

    it('shows only RECEIVED goods of the own organization, grouped by product, with real milestones', async () => {
      const empty = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.summary, { actor: w.actors.ownerA }),
        200,
        customerGoodsSummarySchema,
      );
      expect(empty).toEqual({
        hasProducts: false,
        productCount: 0,
        unitCount: 0,
        discoveryPending: false,
      });

      const order = await receivedPhoneOrder();
      // Delivered but not received yet (a quantity-goods order): not shown.
      const pending = await submitOrder(w, w.actors.ownerA, { items: [[w.products.p2, '3']] });
      await w.step(w.actors.manager, pending.id, { to: 'MANAGER_APPROVED' });
      await w.step(w.actors.accountant, pending.id, { to: 'ACCOUNTING_CLEARED' });
      await w.step(w.actors.warehouse, pending.id, { to: 'RELEASED', driverUserId: w.ids.driver });
      await w.step(w.actors.driver, pending.id, { to: 'DELIVERED' });

      const summary = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.summary, { actor: w.actors.sellerA }),
        200,
        customerGoodsSummarySchema,
      );
      expect(summary).toEqual({
        hasProducts: true,
        productCount: 2,
        unitCount: 3,
        discoveryPending: true,
      });

      const list = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.list, { actor: w.actors.ownerA }),
        200,
        customerGoodsListSchema,
      );
      const phone = list.products.find((p) => p.productId === w.products.p1);
      expect(phone).toMatchObject({
        unitCount: 2,
        codeCount: 4,
        codeKinds: ['IMEI', 'MARKING'],
        icon: 'phone',
      });

      const page = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.product, {
          actor: w.actors.ownerA,
          params: { productId: w.products.p1 },
        }),
        200,
        customerGoodsProductSchema,
      );
      expect(page.units).toHaveLength(2);
      const unit = page.units[0];
      expect(unit?.orderNumber).toBe(order.orderNumber);
      expect(unit?.milestones.confirmedAt).not.toBeNull();
      expect(unit?.milestones.deliveredAt).not.toBeNull();
      expect(unit?.receivedAt).not.toBeNull();

      const one = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.unit, {
          actor: w.actors.ownerA,
          params: { productId: w.products.p1, unitId: unit?.id ?? '' },
        }),
        200,
        customerGoodsUnitSchema,
      );
      expect(one.unit.codes.map((c) => c.kind)).toEqual(['IMEI', 'MARKING']);
    });

    it('isolation: another organization sees nothing, a foreign code finds nothing, foreign ids are 404', async () => {
      await receivedPhoneOrder();
      const list = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.list, {
          actor: w.actors.ownerB,
          query: { search: IMEI_A },
        }),
        200,
        customerGoodsListSchema,
      );
      expect(list.products).toEqual([]);
      expect(
        (
          await asCustomer(CUSTOMER_GOODS_ROUTES.product, {
            actor: w.actors.ownerB,
            params: { productId: w.products.p1 },
          })
        ).status,
      ).toBe(404);
      const unit = await w.prisma.orderUnit.findFirstOrThrow({
        where: { productId: w.products.p1 },
      });
      expect(
        (
          await asCustomer(CUSTOMER_GOODS_ROUTES.unit, {
            actor: w.actors.sellerB,
            params: { productId: w.products.p1, unitId: unit.id },
          })
        ).status,
      ).toBe(404);
      // Staff on this customer route [C, 2026-11-09]: a role that may see prices is a viewer and
      // gets the empty answer, never an organization's goods (received units exist here); a role
      // that is not a viewer is still refused.
      const viewer = await call(CUSTOMER_GOODS_ROUTES.summary, { actor: w.actors.manager });
      expect(viewer.status).toBe(200);
      expect(viewer.body).toEqual({
        hasProducts: false,
        productCount: 0,
        unitCount: 0,
        discoveryPending: false,
      });
      expect((await call(CUSTOMER_GOODS_ROUTES.summary, { actor: w.actors.driver })).status).toBe(
        403,
      );
    });

    it('searches by IMEI (spaces allowed) and keeps whole groups; pagination is query-bound', async () => {
      await receivedPhoneOrder();
      const found = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.list, {
          actor: w.actors.ownerA,
          query: { search: '4901 5420 3237 518' },
        }),
        200,
        customerGoodsListSchema,
      );
      expect(found.products.map((p) => [p.productId, p.unitCount])).toEqual([[w.products.p1, 2]]);
      const filtered = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.product, {
          actor: w.actors.ownerA,
          params: { productId: w.products.p1 },
          query: { search: IMEI_B },
        }),
        200,
        customerGoodsProductSchema,
      );
      expect(filtered.units).toHaveLength(1);

      const first = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.list, {
          actor: w.actors.ownerA,
          query: { limit: 1 },
        }),
        200,
        customerGoodsListSchema,
      );
      expect(first.products).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.list, {
          actor: w.actors.ownerA,
          query: { limit: 1, cursor: first.nextCursor },
        }),
        200,
        customerGoodsListSchema,
      );
      expect(second.products.map((p) => p.productId)).not.toContain(first.products[0]?.productId);
      expect(second.nextCursor).toBeNull();
      expect(
        (
          await call(CUSTOMER_GOODS_ROUTES.list, {
            actor: w.actors.ownerA,
            query: { limit: 1, cursor: first.nextCursor, search: 'Olma' },
          })
        ).status,
      ).toBe(422);
    });

    it('the discovery acknowledgement is per person, idempotent and audited once', async () => {
      await receivedPhoneOrder();
      for (let i = 0; i < 2; i += 1) {
        expect(
          (await call(CUSTOMER_GOODS_ROUTES.acknowledgeDiscovery, { actor: w.actors.ownerA }))
            .status,
        ).toBe(204);
      }
      const mine = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.summary, { actor: w.actors.ownerA }),
        200,
        customerGoodsSummarySchema,
      );
      expect(mine.discoveryPending).toBe(false);
      const colleague = expectParsed(
        await asCustomer(CUSTOMER_GOODS_ROUTES.summary, { actor: w.actors.sellerA }),
        200,
        customerGoodsSummarySchema,
      );
      expect(colleague.discoveryPending).toBe(true);
      expect(
        await w.prisma.auditLog.count({
          where: { action: 'CUSTOMER_GOODS_DISCOVERY_ACKNOWLEDGED' },
        }),
      ).toBe(1);
    });
  });

  it('orders whole pieces only', async () => {
    const reply = await call(ORDER_ROUTES.setCartItem, {
      actor: w.actors.sellerA,
      params: { productId: w.products.p1 },
      body: { quantity: '1.5' },
    });
    expect(reply.status).toBe(422);
    await expect(
      submitOrder(w, w.actors.sellerA, { items: [[w.products.p1, '2']] }),
    ).resolves.toBeDefined();
  });
});
