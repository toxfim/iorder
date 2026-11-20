import { CURRENCY, productImageMediaUrl } from '@iorder/shared';
import type {
  NewOrderCatalogResponse,
  NewOrderCustomer,
  NewOrderCustomersResponse,
} from '@iorder/shared/staff-orders';
import type { OrderCustomer } from '../../organizations/index.js';
import { toPieceCount } from '../../pricing/index.js';
import { formatAmount } from '../order-lines.js';
import type { NewOrderCatalog } from '../staff-new-order.service.js';

// STAFF-ONLY mappers of the manager's new order. Explicit allow-lists, nothing spread.

function toCustomer(customer: OrderCustomer): NewOrderCustomer {
  return {
    organizationId: customer.id,
    name: customer.name,
    type: customer.type,
    label: customer.label,
    members: customer.members.map((member) => ({
      userId: member.userId,
      fullName: member.fullName,
      phone: member.phone,
    })),
  };
}

export function toNewOrderCustomersResponse(result: {
  items: readonly OrderCustomer[];
  recent: readonly OrderCustomer[];
}): NewOrderCustomersResponse {
  return { items: result.items.map(toCustomer), recent: result.recent.map(toCustomer) };
}

export function toNewOrderCatalogResponse(catalog: NewOrderCatalog): NewOrderCatalogResponse {
  return {
    organizationId: catalog.organizationId,
    priceTier: catalog.priceTier,
    currency: CURRENCY,
    items: catalog.items.map((item) => ({
      productId: item.productId,
      productCode: item.productCode,
      name: item.name,
      category: item.category,
      brand: item.brand,
      imageUrl: item.imageId === null ? null : productImageMediaUrl(item.imageId, 'thumb'),
      imageLargeUrl: item.imageId === null ? null : productImageMediaUrl(item.imageId, 'large'),
      unitPrice: formatAmount(item.unitPrice),
      deferredUnitPrice:
        item.deferredUnitPrice === null ? null : formatAmount(item.deferredUnitPrice),
      stock: toPieceCount(item.stock),
    })),
  };
}
