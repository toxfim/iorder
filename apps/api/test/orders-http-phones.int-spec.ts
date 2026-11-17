import {
  staffOrderListResponseSchema,
  staffOrderSchema,
  staffTimelineResponseSchema,
  STAFF_ORDER_ROUTES,
} from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrdersModule } from '../src/modules/orders/index.js';
import { caller, expectParsed } from './support/orders-http.js';
import { createWorld, orderAt, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const PHONE = /\+998/;

describe('phone numbers in order views (real PostgreSQL)', () => {
  let t: TestApp;
  let w: World;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    t = await createTestApp([OrdersModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    w = await createWorld(t);
    call = caller(w);
    // Every person has a phone, so a leak cannot hide behind an empty column.
    let n = 0;
    for (const id of Object.values(w.ids)) {
      n += 1;
      await t.prisma.user.update({ where: { id }, data: { phone: `+99890000${1000 + n}` } });
    }
  });

  it('the accountant gets no phone in the detail, the list or the timeline (whole bodies scanned)', async () => {
    const order = await orderAt(w, 'RELEASED');
    const actor = w.actors.accountant;

    const detail = await call(STAFF_ORDER_ROUTES.getOrder, { actor, params: { id: order.id } });
    const parsed = expectParsed(detail, 200, staffOrderSchema);
    expect(parsed.detail).toBe('FULL');
    if (parsed.detail === 'FULL') expect(parsed.placedBy.phone).toBeNull();
    expect(parsed.driver?.phone).toBeNull();
    expect(JSON.stringify(detail.body)).not.toMatch(PHONE);

    const list = await call(STAFF_ORDER_ROUTES.listOrders, { actor });
    expectParsed(list, 200, staffOrderListResponseSchema);
    expect(JSON.stringify(list.body)).toContain(order.id);
    expect(JSON.stringify(list.body)).not.toMatch(PHONE);

    const timeline = await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
      actor,
      params: { id: order.id },
    });
    const events = expectParsed(timeline, 200, staffTimelineResponseSchema).events;
    expect(events.some((e) => e.driver !== null)).toBe(true);
    expect(JSON.stringify(timeline.body)).not.toMatch(PHONE);
  });

  it.each(['manager', 'admin', 'warehouse', 'driver'] as const)(
    'the %s sees the driver and delivery contact phones',
    async (role) => {
      const order = await orderAt(w, 'RELEASED');
      const actor = w.actors[role];
      const detail = await call(STAFF_ORDER_ROUTES.getOrder, { actor, params: { id: order.id } });
      const parsed = expectParsed(detail, 200, staffOrderSchema);
      expect(parsed.driver?.phone).toMatch(PHONE);
      expect(parsed.deliveryContact?.contacts.some((c) => c.phone !== null)).toBe(true);

      const timeline = await call(STAFF_ORDER_ROUTES.getOrderTimeline, {
        actor,
        params: { id: order.id },
      });
      const events = expectParsed(timeline, 200, staffTimelineResponseSchema).events;
      expect(events.find((e) => e.driver !== null)?.driver?.phone).toMatch(PHONE);
    },
  );

  it('the manager also sees the phone of the person who placed the order', async () => {
    const order = await orderAt(w, 'SUBMITTED');
    const detail = await call(STAFF_ORDER_ROUTES.getOrder, {
      actor: w.actors.manager,
      params: { id: order.id },
    });
    const parsed = expectParsed(detail, 200, staffOrderSchema);
    if (parsed.detail !== 'FULL') throw new Error('expected the full shape');
    expect(parsed.placedBy.phone).toMatch(PHONE);
  });
});
