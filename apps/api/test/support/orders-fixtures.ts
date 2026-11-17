import { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaService } from '../../src/common/database/prisma.service.js';
import type { OrderStatus } from '@iorder/shared';
import type { PricingService } from '../../src/modules/pricing/index.js';
import { staffActor } from './identity-fixtures.js';

let counter = 0;

/** The rate setting of every orders test world, and of the raw orders: UZS per 1 USD. */
export const WORLD_USD_RATE = '12000.0000';

/** Direct fixture of the `usd_rate` setting (an order needs a known rate since the debt is USD). */
export async function setUsdRateSetting(
  prisma: PrismaService,
  rate: string,
  setBy: string,
): Promise<void> {
  const value = { rate, source: 'MANUAL', rateDate: null, setBy, followsCentralBank: false };
  await prisma.appSetting.upsert({
    where: { key: 'usd_rate' },
    create: { key: 'usd_rate', value, updatedAt: new Date('2026-10-20T08:00:00Z') },
    update: { value, updatedAt: new Date('2026-10-20T08:00:00Z') },
  });
}

export interface ProductSpec {
  code: string;
  names?: { UZ?: string; RU?: string; EN?: string };
  unit?: string;
  active?: boolean;
}

/** Direct fixture: a product with translations (goes around the catalog service on purpose). */
export async function makeProduct(prisma: PrismaService, spec: ProductSpec): Promise<string> {
  const names = spec.names ?? { UZ: `${spec.code} uz`, RU: `${spec.code} ru` };
  const product = await prisma.product.create({
    data: {
      productCode: spec.code,
      unit: spec.unit ?? 'box',
      isActive: spec.active ?? true,
      translations: {
        create: (Object.entries(names) as ['UZ' | 'RU' | 'EN', string][]).map(([lang, name]) => ({
          lang,
          name,
        })),
      },
    },
  });
  return product.id;
}

/**
 * Publishes a price list through the real pricing service. Returns the version id. The prices are
 * UZS amounts by default, stored like a list priced before the switch to USD (2026-10-29), so order
 * tests do not depend on a USD rate; the USD conversion has its own tests in pricing.int-spec.
 */
export async function publishPriceList(
  pricing: PricingService,
  prices: Record<string, string>,
  db: PrismaService,
  currency: 'UZS' | 'USD' = 'UZS',
  deferredPrices: Record<string, string> = {},
  /** Recommended retail prices by product id, in the same currency; a product left out has none. */
  rrps: Record<string, string> = {},
): Promise<string> {
  const manager = staffActor('price-fixture-manager', 'MANAGER');
  const { draft } = await pricing.createDraft(manager, { copyFromCurrent: false, note: null });
  await pricing.upsertDraftItems(manager, draft.id, {
    items: Object.entries(prices).map(([productId, basePrice]) => ({
      productId,
      basePrice: new Prisma.Decimal(basePrice),
      deferredPrice:
        deferredPrices[productId] === undefined
          ? null
          : new Prisma.Decimal(deferredPrices[productId]),
      rrp: rrps[productId] === undefined ? null : new Prisma.Decimal(rrps[productId]),
    })),
  });
  await db.$executeRaw`UPDATE price_list_items SET currency = ${currency} WHERE version_id = ${draft.id}::uuid`;
  await pricing.publish(manager, draft.id);
  return draft.id;
}

/** The legal moves from SUBMITTED to `target` (a cancelled order may have passed accounting). */
function pathTo(target: OrderStatus, cleared: boolean): OrderStatus[] {
  const cleared_ = ['MANAGER_APPROVED', 'ACCOUNTING_CLEARED'] as const;
  switch (target) {
    case 'SUBMITTED':
      return [];
    case 'MANAGER_APPROVED':
      return ['MANAGER_APPROVED'];
    case 'ACCOUNTING_CLEARED':
      return [...cleared_];
    case 'RELEASED':
      return [...cleared_, 'RELEASED'];
    case 'DELIVERED':
      return [...cleared_, 'RELEASED', 'DELIVERED'];
    case 'RECEIVED':
      return [...cleared_, 'RELEASED', 'DELIVERED', 'RECEIVED'];
    case 'REJECTED':
      return ['REJECTED'];
    case 'CANCELLED':
      return cleared ? [...cleared_, 'CANCELLED'] : ['CANCELLED'];
  }
}

export interface RawOrderOptions {
  organizationId: string;
  placedByUserId: string;
  priceListVersionId: string;
  productIds: [string, string];
  status?: OrderStatus;
  /** Needed for RELEASED, DELIVERED and RECEIVED. */
  driverUserId?: string;
  cleared?: boolean;
}

/**
 * An order inserted straight into the database (two lines: 2 x 1500.00 and 1 x 750.50, total
 * 3750.50), in any status. For the database-guard tests; the service tests use the service.
 */
export async function insertRawOrder(
  prisma: PrismaService,
  options: RawOrderOptions,
): Promise<{ id: string; itemIds: string[] }> {
  counter += 1;
  const cleared = options.cleared ?? false;
  const order = await prisma.order.create({
    data: {
      orderNumber: `RAW-${Date.now()}-${counter}`,
      organizationId: options.organizationId,
      placedByUserId: options.placedByUserId,
      priceListVersionId: options.priceListVersionId,
      idempotencyKey: `raw-key-${Date.now()}-${counter}`,
      totalAmount: new Prisma.Decimal('3750.50'),
      usdRate: new Prisma.Decimal(WORLD_USD_RATE),
      totalUsd: new Prisma.Decimal('0.312542'), // 3000 / 12000 + 750.50 / 12000, half up
      submittedAt: new Date('2026-10-20T08:00:00Z'),
      updatedAt: new Date('2026-10-20T08:00:00Z'),
      items: {
        create: [
          {
            productId: options.productIds[0],
            productCodeSnapshot: 'RAW-A',
            nameSnapshot: 'Raw A',
            unitSnapshot: 'box',
            quantity: new Prisma.Decimal('2'),
            unitPrice: new Prisma.Decimal('1500.00'),
            fullUnitPrice: new Prisma.Decimal('1500.00'),
            lineTotal: new Prisma.Decimal('3000.00'),
          },
          {
            productId: options.productIds[1],
            productCodeSnapshot: 'RAW-B',
            nameSnapshot: 'Raw B',
            unitSnapshot: 'box',
            quantity: new Prisma.Decimal('1'),
            unitPrice: new Prisma.Decimal('750.50'),
            fullUnitPrice: new Prisma.Decimal('750.50'),
            lineTotal: new Prisma.Decimal('750.50'),
          },
        ],
      },
    },
    include: { items: true },
  });
  // Lines can only be inserted while the order is SUBMITTED (trigger), so it moves on afterwards,
  // along legal moves only and with an order_events row per move (database guards).
  const status = options.status ?? 'SUBMITTED';
  const path = pathTo(status, cleared);
  if (path.length > 0) {
    await prisma.$transaction(async (tx) => {
      let from: OrderStatus = 'SUBMITTED';
      for (const to of path) {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: to,
            ...(to === 'MANAGER_APPROVED'
              ? { managerApprovedAt: new Date('2026-10-20T08:00:00Z') }
              : {}),
            ...(to === 'ACCOUNTING_CLEARED'
              ? {
                  accountingMode: 'APPROVED',
                  accountingClearedAt: new Date('2026-10-20T09:00:00Z'),
                }
              : {}),
            ...(to === 'RELEASED' ? { driverUserId: options.driverUserId ?? null } : {}),
            // Received fixtures must satisfy the debt-ledger timestamp constraint as well.
            ...(to === 'RECEIVED' ? { receivedAt: new Date('2026-10-20T09:00:00Z') } : {}),
          },
        });
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: 'STATUS_CHANGED',
            fromStatus: from,
            toStatus: to,
            actorRole: 'ADMIN',
            comment: to === 'REJECTED' || to === 'CANCELLED' ? 'raw fixture' : null,
            payload: { before: { status: from }, after: { status: to } },
            createdAt: new Date('2026-10-20T09:00:00Z'),
          },
        });
        from = to;
      }
    });
  }
  return { id: order.id, itemIds: order.items.map((item) => item.id) };
}
