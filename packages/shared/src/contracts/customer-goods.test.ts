import { describe, expect, it } from 'vitest';
import {
  customerGoodsSummarySchema,
  customerUnitCodeSchema,
  customerGoodsGroupSchema,
} from './customer-goods.js';
describe('customer goods allow-listed contracts', () => {
  it('keeps code content exact and supports multiple IMEI slots', () => {
    expect(
      customerUnitCodeSchema.parse({ kind: 'IMEI', slot: 2, value: '001234567890123' }).value,
    ).toBe('001234567890123');
    expect(customerUnitCodeSchema.safeParse({ kind: 'IMEI', slot: 0, value: 'x' }).success).toBe(
      false,
    );
  });
  it('refuses additional fields and missing discovery state', () => {
    const summary = { hasProducts: false, productCount: 0, unitCount: 0, discoveryPending: false };
    expect(customerGoodsSummarySchema.safeParse({ ...summary, supplier: 'secret' }).success).toBe(
      false,
    );
    expect(customerGoodsSummarySchema.safeParse({ hasProducts: false }).success).toBe(false);
  });
  it('does not permit cost or inventory fields in a received product group', () => {
    const group = {
      productId: '11111111-1111-4111-8111-111111111111',
      productCode: 'A',
      name: 'Phone',
      icon: 'phone',
      unitCount: 4,
      codeCount: 8,
      codeKinds: ['IMEI'],
      lastDeliveredAt: '2026-10-24T10:00:00Z',
    };
    expect(customerGoodsGroupSchema.safeParse(group).success).toBe(true);
    expect(customerGoodsGroupSchema.safeParse({ ...group, costUsd: '10.00' }).success).toBe(false);
  });
});
