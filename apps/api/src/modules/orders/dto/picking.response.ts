import type { PickingResponse } from '@iorder/shared/staff-orders';
import { formatQuantity } from '../order-lines.js';
import type { PickingView } from '../picking.service.js';
import { toItemAllocation } from './order.response.js';

/** Explicit allow-list: no prices, no cost, no recorder ids. Staff-only (picking screen). */
export function toPickingResponse(view: PickingView): PickingResponse {
  return {
    orderId: view.order.id,
    orderNumber: view.order.orderNumber,
    status: view.order.status,
    rowVersion: view.order.rowVersion,
    editable: view.editable,
    complete: view.complete,
    lines: view.lines.map((line) => ({
      itemId: line.item.id,
      productId: line.item.productId,
      productCode: line.item.productCodeSnapshot,
      name: line.item.nameSnapshot,
      unit: line.item.unitSnapshot,
      quantity: formatQuantity(line.item.quantity),
      trackingType: line.trackingType,
      markingRequired: line.markingRequired,
      allocations: line.allocations.map(toItemAllocation),
      stockTracked: line.item.stockTracked,
      incompleteUnits: line.incompleteUnits,
      units: line.units.map(({ unit, missing }) => ({
        unitId: unit.id,
        unitNo: unit.unitNo,
        codes: unit.codes.map((code) => ({
          kind: code.kind,
          slot: code.slot,
          value: code.codeValue,
          recordedAt: code.recordedAt.toISOString(),
        })),
        missing: missing.map((slot) => ({ kind: slot.kind, slot: slot.slot })),
      })),
    })),
  };
}
