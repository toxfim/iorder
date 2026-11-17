import type {
  SupplyRemovalDecisionResponse,
  SupplyRemovalListResponse,
} from '@iorder/shared/staff-cost';
import type { PendingRemoval } from './supply-removal.service.js';
import type { RemovalRequestRow } from './supply-removal.repository.js';

// STAFF-ONLY explicit allow-list mappers (shapes live in @iorder/shared/staff-cost).

export function toRemovalListResponse(pending: {
  total: number;
  items: readonly PendingRemoval[];
}): SupplyRemovalListResponse {
  return {
    total: pending.total,
    items: pending.items.map(({ request, productCode, line }) => ({
      id: request.id,
      productId: request.productId,
      productCode,
      deliveryRef: request.deliveryRef,
      detectedAt: request.detectedAt.toISOString(),
      line: {
        deliveredAt: line.deliveredAt.toISOString(),
        supplier: line.supplier,
        deliveredQuantity: line.deliveredQuantity.toFixed(3),
        availableQuantity: line.availableQuantity.toFixed(3),
        costUsd: line.costUsd?.toFixed(4) ?? null,
        usdRateUsed: line.usdRateUsed?.toFixed(4) ?? null,
        costUzs: line.costUzs?.toFixed(2) ?? null,
      },
    })),
  };
}

export function toDecisionResponse(
  request: RemovalRequestRow,
  deciderName: string | null,
): SupplyRemovalDecisionResponse {
  return {
    id: request.id,
    // A decided request always has a status other than PENDING and a time.
    status: request.status === 'CONFIRMED' ? 'CONFIRMED' : 'DISMISSED',
    decidedAt: (request.decidedAt ?? new Date(0)).toISOString(),
    decidedBy: deciderName,
  };
}
