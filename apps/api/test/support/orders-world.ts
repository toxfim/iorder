import type { OrderStatus, PaymentPlan, StaffRole, SubmitOrderRequest } from '@iorder/shared';
import type { Actor } from '../../src/common/auth/actor.js';
import type { PrismaService } from '../../src/common/database/prisma.service.js';
import { CartService } from '../../src/modules/orders/cart.service.js';
import type {
  EditItemsCommand,
  OrderView,
  TransitionCommand,
} from '../../src/modules/orders/index.js';
import { OrdersService } from '../../src/modules/orders/orders.service.js';
import { OrganizationPaymentsService } from '../../src/modules/orders/organization-payments.service.js';
import { PricingService } from '../../src/modules/pricing/index.js';
import {
  customerActor,
  makeMember,
  makeOrganization,
  makeUser,
  staffActor,
} from './identity-fixtures.js';
import {
  makeProduct,
  publishPriceList,
  setUsdRateSetting,
  WORLD_USD_RATE,
} from './orders-fixtures.js';
import type { TestApp } from './test-app.js';
import { resetCatalogPricingAudit, resetIdentity } from './test-db.js';

/** Everything an orders test needs: two organizations, staff of every role, priced products. */
export interface World {
  t: TestApp;
  prisma: PrismaService;
  orders: OrdersService;
  payments: OrganizationPaymentsService;
  carts: CartService;
  pricing: PricingService;
  orgA: string;
  orgB: string;
  ids: Record<
    | 'ownerA'
    | 'sellerA'
    | 'sellerA2'
    | 'ownerB'
    | 'sellerB'
    | 'manager'
    | 'manager2'
    | 'accountant'
    | 'warehouse'
    | 'driver'
    | 'driver2'
    | 'admin',
    string
  >;
  actors: Record<keyof World['ids'], Actor>;
  /** p1 1500.00 (UZ, RU, EN names), p2 750.50 (UZ, RU), p3 exists but has no price. */
  products: { p1: string; p2: string; p3: string };
  versionId: string | null;
  /**
   * Performs a transition the way a client does: staff send the row_version they read (the
   * service requires it); customers send what the caller gave. Use `orders.transition` directly
   * to test the missing-version rules.
   */
  step: (actor: Actor, orderId: string, command: TransitionCommand) => Promise<OrderView>;
  /** Same for a manager edit. */
  edit: (actor: Actor, orderId: string, command: EditItemsCommand) => Promise<OrderView>;
}

export async function createWorld(t: TestApp, options: { publish?: boolean } = {}): Promise<World> {
  const { prisma } = t;
  await resetIdentity(prisma);
  await resetCatalogPricingAudit(prisma);
  t.clock.set(new Date('2026-10-20T08:00:00Z'));

  const orgA = await makeOrganization(prisma, { name: 'Alpha shop' });
  const orgB = await makeOrganization(prisma, { name: 'Beta shop' });
  // Customers have entered their contact (the first order asks for it, owner decision 2026-10-23).
  let phoneCounter = 0;
  const person = async (name: string, staff?: StaffRole[]) =>
    (
      await makeUser(prisma, {
        name,
        ...(staff
          ? { staff }
          : { phone: `+99871000${String((phoneCounter += 1)).padStart(4, '0')}` }),
      })
    ).id;

  const ids = {
    ownerA: await person('Owner A'),
    sellerA: await person('Seller A'),
    sellerA2: await person('Seller A2'),
    ownerB: await person('Owner B'),
    sellerB: await person('Seller B'),
    manager: await person('Manager', ['MANAGER']),
    manager2: await person('Manager 2', ['MANAGER']),
    accountant: await person('Accountant', ['ACCOUNTANT']),
    warehouse: await person('Warehouse', ['WAREHOUSE_MANAGER']),
    driver: await person('Driver', ['DRIVER']),
    driver2: await person('Driver 2', ['DRIVER']),
    admin: await person('Admin', ['ADMIN']),
  };
  await makeMember(prisma, orgA.id, ids.ownerA, 'SHOP_OWNER');
  await makeMember(prisma, orgA.id, ids.sellerA, 'SELLER');
  await makeMember(prisma, orgA.id, ids.sellerA2, 'SELLER');
  await makeMember(prisma, orgB.id, ids.ownerB, 'SHOP_OWNER');
  await makeMember(prisma, orgB.id, ids.sellerB, 'SELLER');

  const actors = {
    ownerA: customerActor(ids.ownerA, orgA.id, 'SHOP_OWNER'),
    sellerA: customerActor(ids.sellerA, orgA.id, 'SELLER'),
    sellerA2: customerActor(ids.sellerA2, orgA.id, 'SELLER'),
    ownerB: customerActor(ids.ownerB, orgB.id, 'SHOP_OWNER'),
    sellerB: customerActor(ids.sellerB, orgB.id, 'SELLER'),
    manager: staffActor(ids.manager, 'MANAGER'),
    manager2: staffActor(ids.manager2, 'MANAGER'),
    accountant: staffActor(ids.accountant, 'ACCOUNTANT'),
    warehouse: staffActor(ids.warehouse, 'WAREHOUSE_MANAGER'),
    driver: staffActor(ids.driver, 'DRIVER'),
    driver2: staffActor(ids.driver2, 'DRIVER'),
    admin: staffActor(ids.admin, 'ADMIN'),
  };

  const products = {
    p1: await makeProduct(prisma, {
      code: 'P-1',
      names: { UZ: 'Olma', RU: 'Яблоко', EN: 'Apple' },
    }),
    p2: await makeProduct(prisma, { code: 'P-2', names: { UZ: 'Nok', RU: 'Груша' } }),
    p3: await makeProduct(prisma, { code: 'P-3' }),
  };

  // Plenty of stock: an approval needs delivery lines to hold ([C] 2026-10-30). Tests about stock
  // change these lines or add their own.
  for (const productId of Object.values(products)) await stockUp(prisma, productId, '100000');

  const pricing = t.get(PricingService);
  const versionId =
    options.publish === false
      ? null
      : await publishPriceList(
          pricing,
          { [products.p1]: '1500.00', [products.p2]: '750.50' },
          prisma,
        );

  // After the publish, so the version itself stays "published without a rate" like before.
  await setUsdRateSetting(prisma, WORLD_USD_RATE, ids.manager);

  const orders = t.get(OrdersService);
  // The version is read straight from the table so the helper works for roles that cannot see
  // the order yet (the warehouse before accounting).
  const currentVersion = async (orderId: string): Promise<number> =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { rowVersion: true } }))
      .rowVersion;
  const isStaff = (actor: Actor): boolean => actor.staffRoles.length > 0;

  return {
    t,
    prisma,
    orders,
    step: async (actor, orderId, rawCommand) => {
      // Approval needs a payment method ([C] 2026-10-24); tests that are not about it get CASH.
      const withMethod =
        rawCommand.to === 'MANAGER_APPROVED' && !('paymentMethod' in rawCommand)
          ? { ...rawCommand, paymentMethod: 'CASH' as const }
          : rawCommand;
      // So does a plan; tests that are not about holds take the FIFO the manager would be shown.
      const command =
        withMethod.to === 'MANAGER_APPROVED' && !('allocationMode' in withMethod)
          ? { ...withMethod, ...(await fifoPlanOf(orders, actors.manager, orderId)) }
          : withMethod;
      return orders.transition(
        actor,
        orderId,
        isStaff(actor) && command.expectedRowVersion === undefined
          ? { ...command, expectedRowVersion: await currentVersion(orderId) }
          : command,
      );
    },
    edit: async (actor, orderId, command) =>
      orders.editItems(
        actor,
        orderId,
        isStaff(actor) && command.expectedRowVersion === undefined
          ? { ...command, expectedRowVersion: await currentVersion(orderId) }
          : command,
      ),
    payments: t.get(OrganizationPaymentsService),
    carts: t.get(CartService),
    pricing,
    orgA: orgA.id,
    orgB: orgB.id,
    ids,
    actors,
    products,
    versionId,
  };
}

/** One delivery line of a product, and the stock aggregate summed over its lines. */
export async function stockUp(
  prisma: PrismaService,
  productId: string,
  quantity: string,
  options: { deliveryRef?: string; deliveredAt?: Date } = {},
): Promise<string> {
  const syncedAt = new Date('2026-10-01T00:00:00Z');
  const line = await prisma.priceReference.create({
    data: {
      productId,
      deliveryRef: options.deliveryRef ?? 'REF-WORLD',
      supplier: 'Test supplier',
      purchaseMethod: 'Bank',
      category: 'Test',
      deliveredQuantity: quantity,
      availableQuantity: quantity,
      costUsd: '1.0000',
      usdRateUsed: '12000.0000',
      costUzs: '12000.00',
      deliveredAt: options.deliveredAt ?? new Date('2026-09-01T00:00:00Z'),
      syncedAt,
    },
  });
  const sum = await prisma.priceReference.aggregate({
    where: { productId, removedAt: null },
    _sum: { availableQuantity: true },
  });
  const total = sum._sum.availableQuantity ?? '0';
  await prisma.stockCache.upsert({
    where: { productId },
    create: { productId, quantity: total, syncedAt },
    update: { quantity: total, syncedAt },
  });
  return line.id;
}

/**
 * What the manager's dialog sends for the proposal it shows. An order the preview refuses (a closed
 * status) gets an empty plan: the move itself then answers, as it does for a real client.
 */
export async function fifoPlanOf(
  orders: OrdersService,
  manager: Actor,
  orderId: string,
): Promise<{
  allocationMode: 'FIFO';
  allocations: { orderItemId: string; supplyLineId: string; quantity: string }[];
}> {
  try {
    const preview = await orders.allocationPreview(manager, orderId);
    return {
      allocationMode: 'FIFO',
      allocations: preview.items.flatMap((item) =>
        item.fifo.map((row) => ({
          orderItemId: item.orderItemId,
          supplyLineId: row.supplyLineId,
          quantity: row.quantity,
        })),
      ),
    };
  } catch {
    return { allocationMode: 'FIFO', allocations: [] };
  }
}

let keyCounter = 0;
export const nextKey = (): string => `test-key-${Date.now()}-${(keyCounter += 1)}`;

/** Fills the actor's cart (replacing the quantities of the given products). */
export async function fillCart(
  world: World,
  actor: Actor,
  items: readonly [productId: string, quantity: string][],
): Promise<void> {
  for (const [productId, quantity] of items) {
    await world.carts.setItemQuantity(actor, productId, quantity);
  }
}

export interface SubmitOptions {
  items?: readonly [string, string][];
  key?: string;
  paymentPlan?: PaymentPlan;
}

/** Submits an order as `actor` (default: seller of organization A): 2 x p1 + 1 x p2 = 3750.50. */
export async function submitOrder(
  world: World,
  actor: Actor = world.actors.sellerA,
  options: SubmitOptions = {},
): Promise<OrderView> {
  await fillCart(
    world,
    actor,
    options.items ?? [
      [world.products.p1, '2'],
      [world.products.p2, '1'],
    ],
  );
  const organizationId = actor.membership?.organizationId;
  if (organizationId === undefined) throw new Error('submitOrder needs a customer actor');
  return placeCart(
    world,
    actor,
    organizationId,
    options.key ?? nextKey(),
    options.paymentPlan ?? 'FULL',
  );
}

/** What a client sends: the plan and the total the cart shows for it right now. */
export async function shownCartRequest(
  world: World,
  actor: Actor,
  paymentPlan: PaymentPlan,
): Promise<SubmitOrderRequest> {
  const cart = await world.carts.getCart(actor);
  const total = paymentPlan === 'FULL' ? cart.totalAmount : cart.deferredTotalAmount;
  return { paymentPlan, expectedTotalAmount: total?.toFixed(2) ?? '0.00' };
}

/** `orders.submitCart` the way a client calls it, at the total the cart shows. */
export async function placeCart(
  world: World,
  actor: Actor,
  organizationId: string,
  key: string,
  paymentPlan: PaymentPlan,
): Promise<OrderView> {
  const request = await shownCartRequest(world, actor, paymentPlan);
  return world.orders.submitCart(actor, organizationId, key, request);
}

const PATH: readonly OrderStatus[] = [
  'SUBMITTED',
  'MANAGER_APPROVED',
  'ACCOUNTING_CLEARED',
  'RELEASED',
  'DELIVERED',
  'RECEIVED',
];

/**
 * A fresh order moved forward through the real service to `status`. REJECTED and CANCELLED are
 * reached from SUBMITTED; `cancelAfter` cancels after reaching an earlier status (for example
 * 'ACCOUNTING_CLEARED' to get a cleared-then-cancelled order).
 */
export async function orderAt(
  world: World,
  status: OrderStatus,
  options: {
    placedBy?: Actor;
    cancelAfter?: OrderStatus;
    items?: readonly [string, string][];
    paymentPlan?: PaymentPlan;
  } = {},
): Promise<OrderView> {
  const { actors, ids } = world;
  let order = await submitOrder(world, options.placedBy ?? actors.sellerA, {
    ...(options.items === undefined ? {} : { items: options.items }),
    ...(options.paymentPlan === undefined ? {} : { paymentPlan: options.paymentPlan }),
  });
  const target = status === 'REJECTED' || status === 'CANCELLED' ? 'SUBMITTED' : status;
  const walk = status === 'CANCELLED' ? (options.cancelAfter ?? 'SUBMITTED') : target;

  const steps: Record<string, () => Promise<OrderView>> = {
    MANAGER_APPROVED: () => world.step(actors.manager, order.id, { to: 'MANAGER_APPROVED' }),
    ACCOUNTING_CLEARED: () => world.step(actors.accountant, order.id, { to: 'ACCOUNTING_CLEARED' }),
    RELEASED: () =>
      world.step(actors.warehouse, order.id, { to: 'RELEASED', driverUserId: ids.driver }),
    DELIVERED: () => world.step(actors.driver, order.id, { to: 'DELIVERED' }),
    RECEIVED: () => world.step(actors.ownerA, order.id, { to: 'RECEIVED' }),
  };
  for (const next of PATH.slice(1, PATH.indexOf(walk) + 1)) {
    const step = steps[next];
    if (step === undefined) throw new Error(`no step to ${next}`);
    order = await step();
  }
  if (status === 'REJECTED') {
    return world.step(actors.manager, order.id, { to: 'REJECTED', reason: 'out of stock' });
  }
  if (status === 'CANCELLED') {
    return world.step(actors.manager, order.id, {
      to: 'CANCELLED',
      reason: 'customer asked',
    });
  }
  return order;
}

/** Plain JSON view of a value (Decimals and dates become strings), for leak scans. */
export function toPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
