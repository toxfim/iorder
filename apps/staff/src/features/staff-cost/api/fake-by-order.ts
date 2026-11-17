import type { StaffRole } from '@iorder/shared';
import {
  BY_ORDER_OPEN_STATUSES,
  type ByOrderOpenOrder,
  type ByOrderOpenStatus,
  type ByOrderProduct,
  type ByOrderProductsResponse,
} from '@iorder/shared/staff-cost';
import { ApiError, PermissionDeniedError } from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { canViewCost } from '@/features/staff-shell/price-access';
import { addQuantities } from '../domain/decimal';
import type { ByOrderApi } from './by-order-api';

// The in-memory twin of GET /staff/by-order-products (dev, tests, VITE_USE_FAKE_API). Its products
// are its own fixtures; the orders that wait for them are the orders fake's, read live, so an
// order that is released or cancelled there stops counting here, as on the server. Must never
// reach a production bundle: scripts/check-bundle.mjs looks for the marker and the names.

export const FAKE_BY_ORDER_MARKER = 'iorder-fake-by-order';

interface ProductSeed {
  readonly code: string;
  readonly name: string;
  readonly brandName: string | null;
  readonly category: string | null;
  readonly basePrice: string | null;
  readonly deferredPrice: string | null;
  readonly isActive: boolean;
  /** Lines of the orders fake's orders: [order number, pieces]. */
  readonly lines: readonly (readonly [orderNumber: string, quantity: string])[];
}

export const FAKE_BY_ORDER_PRODUCTS: readonly ProductSeed[] = [
  {
    code: 'IO-900001',
    name: 'Ugreen HiTune T6 quloqchin',
    brandName: 'Ugreen',
    category: 'Quloqchinlar',
    basePrice: '18.50',
    deferredPrice: '19.40',
    isActive: true,
    lines: [
      ['IO-10491', '6.000'],
      ['IO-10489', '4.000'],
      // Released: its goods have left, so it is never counted.
      ['IO-10488', '9.000'],
    ],
  },
  {
    code: 'IO-900002',
    name: 'Baseus Bowie 30 Max naushnik',
    brandName: 'Baseus',
    category: 'Quloqchinlar',
    basePrice: '32.00',
    deferredPrice: null,
    isActive: true,
    lines: [['IO-10490', '2.000']],
  },
  {
    code: 'IO-900003',
    name: 'Yesido avtomobil ushlagichi C192',
    brandName: null,
    category: null,
    basePrice: '4.20',
    deferredPrice: '4.50',
    isActive: true,
    lines: [],
  },
  {
    code: 'IO-900004',
    name: 'Remax simsiz zaryadlovchi 15W',
    brandName: null,
    category: 'Zaryadlovchilar',
    basePrice: null,
    deferredPrice: null,
    // Merged into a sheet product; listed only while the order below still waits for it.
    isActive: false,
    lines: [['IO-10484', '3.000']],
  },
];

/** What the fake needs to know about an order of the orders fake. */
export interface FakeOrderFacts {
  readonly id: string;
  readonly orderNumber: string;
  readonly organizationName: string;
  readonly status: string;
  readonly submittedAt: string;
}

export interface FakeByOrderOptions {
  /** Every order the signed-in role may see (the orders fake's summaries). */
  readonly orders: () => readonly FakeOrderFacts[];
  readonly roles: () => readonly StaffRole[];
  readonly latencyMs?: number;
  readonly scenario?: () => FakeScenario;
}

const isOpen = (status: string): status is ByOrderOpenStatus =>
  (BY_ORDER_OPEN_STATUSES as readonly string[]).includes(status);

export function createFakeByOrderApi(options: FakeByOrderOptions): ByOrderApi {
  const latencyMs = options.latencyMs ?? 0;
  const scenario = options.scenario ?? (() => 'ready');

  function toProduct(seed: ProductSeed, orders: readonly FakeOrderFacts[]): ByOrderProduct | null {
    const waiting = seed.lines
      .flatMap(([orderNumber, quantity]): ByOrderOpenOrder[] => {
        const order = orders.find((candidate) => candidate.orderNumber === orderNumber);
        return order !== undefined && isOpen(order.status)
          ? [
              {
                orderId: order.id,
                orderNumber: order.orderNumber,
                organizationName: order.organizationName,
                status: order.status,
                quantity,
                submittedAt: order.submittedAt,
              },
            ]
          : [];
      })
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
    // A product out of sale stays only while an order waits for it.
    if (!seed.isActive && waiting.length === 0) return null;
    const priced = seed.basePrice !== null;
    return {
      productId: fakeUuid(`by-order:${seed.code}`),
      productCode: seed.code,
      name: seed.name,
      brandName: seed.brandName,
      category: seed.category,
      isActive: seed.isActive,
      basePrice: seed.basePrice,
      deferredPrice: seed.deferredPrice,
      currency: priced ? 'USD' : null,
      openQuantity: addQuantities(waiting.map((order) => order.quantity)),
      openOrderCount: waiting.length,
      orders: waiting,
    };
  }

  /** The server's order: needed now first (the longest wait at the top), then the rest by name. */
  function sorted(items: ByOrderProduct[]): ByOrderProduct[] {
    const since = (item: ByOrderProduct): string => item.orders[0]?.submittedAt ?? '';
    return items.sort((a, b) => {
      const needed = Number(b.openOrderCount > 0) - Number(a.openOrderCount > 0);
      if (needed !== 0) return needed;
      return since(a).localeCompare(since(b)) || a.name.localeCompare(b.name);
    });
  }

  return {
    async list(): Promise<ByOrderProductsResponse> {
      const current = scenario();
      if (current === 'loading') return new Promise<never>(() => undefined);
      if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      if (current === 'denied' || !canViewCost(options.roles())) throw new PermissionDeniedError();
      if (current === 'error') throw new ApiError(`${FAKE_BY_ORDER_MARKER}: simulated failure`);
      if (current === 'empty') return { items: [] };
      const orders = options.orders();
      return {
        items: sorted(
          FAKE_BY_ORDER_PRODUCTS.flatMap((seed) => {
            const product = toProduct(seed, orders);
            return product === null ? [] : [product];
          }),
        ),
      };
    },
  };
}
