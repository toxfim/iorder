import type {
  CustomerGoodsGroup,
  CustomerGoodsProduct,
  CustomerGoodsSummary,
  CustomerMilestones,
  CustomerOrder,
  CustomerReceivedUnit,
} from '@iorder/shared';
import { fakeUuid } from '@core/lib/fake-ids';
import { ApiNotFoundError } from '@core/lib/api-errors';
import type { CustomerGoodsApi, GoodsQuery } from './customer-goods-api';
export interface FakeGoodsSource {
  order: CustomerOrder;
  milestones: CustomerMilestones;
  receivedAt: string | null;
}
export function createFakeCustomerGoodsApi(
  source: () => Promise<FakeGoodsSource[]>,
  identity: () => string,
): CustomerGoodsApi & { markFirstReceipt: () => void } {
  const pending = new Set<string>(),
    seen = new Set<string>();
  async function rows(): Promise<{ product: CustomerGoodsGroup; unit: CustomerReceivedUnit }[]> {
    const answer: { product: CustomerGoodsGroup; unit: CustomerReceivedUnit }[] = [];
    for (const { order, milestones, receivedAt } of await source()) {
      for (const item of order.items) {
        // Fixtures model whole physical units. Real eligibility/counts are decided by the API.
        if (!/^\d+$/.test(item.quantity)) continue;
        const count = Number(item.quantity);
        for (let i = 1; i <= count; i++) {
          const kind = item.productCode.includes('TECNO') ? ('IMEI' as const) : ('SERIAL' as const);
          const value =
            kind === 'IMEI'
              ? '353918' + String(100000000 + i).padStart(9, '0')
              : item.productCode + '-' + order.orderNumber + '-' + String(i).padStart(3, '0');
          answer.push({
            product: {
              productId: item.productId,
              productCode: item.productCode,
              name: item.name,
              icon: kind === 'IMEI' ? 'phone' : 'box',
              unitCount: 0,
              codeCount: 0,
              codeKinds: [kind],
              lastDeliveredAt: milestones.deliveredAt ?? order.submittedAt,
            },
            unit: {
              id: fakeUuid('received-unit:' + order.id + ':' + item.id + ':' + i),
              unitNumber: i,
              codes: [{ kind, slot: 1, value }],
              orderId: order.id,
              orderNumber: order.orderNumber,
              milestones,
              receivedAt,
            },
          });
        }
      }
    }
    return answer;
  }
  async function groups(): Promise<CustomerGoodsGroup[]> {
    const map = new Map<string, CustomerGoodsGroup>();
    for (const row of await rows()) {
      const group = map.get(row.product.productId) ?? { ...row.product };
      group.unitCount += 1;
      group.codeCount += row.unit.codes.length;
      if (row.product.lastDeliveredAt > group.lastDeliveredAt)
        group.lastDeliveredAt = row.product.lastDeliveredAt;
      map.set(group.productId, group);
    }
    return [...map.values()].sort(
      (a, b) =>
        b.lastDeliveredAt.localeCompare(a.lastDeliveredAt) ||
        a.productId.localeCompare(b.productId),
    );
  }
  function matches(
    row: { product: CustomerGoodsGroup; unit: CustomerReceivedUnit },
    search: string,
  ): boolean {
    return [row.product.name, row.product.productCode, ...row.unit.codes.map((c) => c.value)].some(
      (value) => value.toLowerCase().includes(search),
    );
  }
  function page<T>(items: T[], query: GoodsQuery): { items: T[]; nextCursor: string | null } {
    const start = Math.max(0, Number(query.cursor) || 0),
      limit = query.limit ?? 20;
    return {
      items: items.slice(start, start + limit),
      nextCursor: start + limit < items.length ? String(start + limit) : null,
    };
  }
  const api: CustomerGoodsApi & { markFirstReceipt: () => void } = {
    markFirstReceipt: () => {
      pending.add(identity());
    },
    summary: async (): Promise<CustomerGoodsSummary> => {
      const products = await groups(),
        key = identity();
      return {
        hasProducts: products.length > 0,
        productCount: products.length,
        unitCount: products.reduce((sum, p) => sum + p.unitCount, 0),
        discoveryPending: pending.has(key) && !seen.has(key) && products.length > 0,
      };
    },
    list: async (query = {}) => {
      const search = query.search?.trim().toLowerCase() ?? '';
      const matchingIds = new Set(
        (await rows()).filter((row) => matches(row, search)).map((row) => row.product.productId),
      );
      const result = page(
        (await groups()).filter((p) => matchingIds.has(p.productId)),
        query,
      );
      return { products: result.items, nextCursor: result.nextCursor };
    },
    product: async (productId, query = {}): Promise<CustomerGoodsProduct> => {
      const product = (await groups()).find((p) => p.productId === productId);
      if (!product) throw new ApiNotFoundError('Not found', 'NOT_FOUND');
      const search = query.search?.trim().toLowerCase() ?? '';
      const result = page(
        (await rows())
          .filter((row) => row.product.productId === productId && matches(row, search))
          .map((row) => row.unit),
        query,
      );
      return { product, units: result.items, nextCursor: result.nextCursor };
    },
    unit: async (productId, unitId) => {
      const product = (await groups()).find((p) => p.productId === productId);
      const unit = (await rows()).find(
        (row) => row.product.productId === productId && row.unit.id === unitId,
      )?.unit;
      if (!product || !unit) throw new ApiNotFoundError('Not found', 'NOT_FOUND');
      return { product, unit };
    },
    acknowledgeDiscovery: async () => {
      await source();
      seen.add(identity());
    },
  };
  return api;
}
