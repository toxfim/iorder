import type {
  CustomerGoodsGroup,
  CustomerGoodsList,
  CustomerGoodsProduct,
  CustomerGoodsSummary,
  CustomerGoodsUnit,
  CustomerReceivedUnit,
} from '@iorder/shared';
import type { GoodsGroupRecord, GoodsUnitRecord } from '../customer-goods.repository.js';
import type {
  GoodsListView,
  GoodsProductView,
  GoodsSummaryView,
} from '../customer-goods.service.js';

// Explicit allow-lists (hard rule 7): no price, cost, supplier, staff ids or event payloads.

function toGroup(group: GoodsGroupRecord): CustomerGoodsGroup {
  return {
    productId: group.productId,
    productCode: group.productCode,
    name: group.name,
    // A presentation hint only: phones carry IMEI codes, everything else gets the generic box.
    icon: group.codeKinds.includes('IMEI') ? 'phone' : 'box',
    unitCount: group.unitCount,
    codeCount: group.codeCount,
    codeKinds: group.codeKinds,
    lastDeliveredAt: group.lastDeliveredAt.toISOString(),
  };
}

function toUnit(unit: GoodsUnitRecord): CustomerReceivedUnit {
  return {
    id: unit.id,
    unitNumber: unit.unitNo,
    codes: unit.codes.map((code) => ({ kind: code.kind, slot: code.slot, value: code.value })),
    orderId: unit.orderId,
    orderNumber: unit.orderNumber,
    milestones: {
      orderedAt: unit.orderedAt.toISOString(),
      confirmedAt: unit.confirmedAt?.toISOString() ?? null,
      deliveredAt: unit.deliveredAt?.toISOString() ?? null,
    },
    receivedAt: unit.receivedAt?.toISOString() ?? null,
  };
}

export function toCustomerGoodsSummary(view: GoodsSummaryView): CustomerGoodsSummary {
  return {
    hasProducts: view.unitCount > 0,
    productCount: view.productCount,
    unitCount: view.unitCount,
    discoveryPending: view.discoveryPending,
  };
}

export function toCustomerGoodsList(view: GoodsListView): CustomerGoodsList {
  return { products: view.groups.map(toGroup), nextCursor: view.nextCursor };
}

export function toCustomerGoodsProduct(view: GoodsProductView): CustomerGoodsProduct {
  return {
    product: toGroup(view.group),
    units: view.units.map(toUnit),
    nextCursor: view.nextCursor,
  };
}

export function toCustomerGoodsUnit(view: {
  group: GoodsGroupRecord;
  unit: GoodsUnitRecord;
}): CustomerGoodsUnit {
  return { product: toGroup(view.group), unit: toUnit(view.unit) };
}
