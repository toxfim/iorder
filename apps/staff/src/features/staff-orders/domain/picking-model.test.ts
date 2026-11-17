import type { PickingLine, PickingResponse } from '@iorder/shared/staff-orders';
import { describe, expect, it } from 'vitest';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  NetworkError,
} from '@core/lib/api-errors';
import { demoImei } from '../api/fake-picking';
import {
  describeScanError,
  displayCode,
  lineViews,
  nextSlot,
  pickingProgress,
  precheckScan,
  showsPicking,
  slotKey,
} from './picking-model';
import { describeOrderError, incompleteItems } from './order-errors';

const AT = '2026-10-19T04:30:00.000Z';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function line(
  n: number,
  rule: Pick<PickingLine, 'trackingType' | 'markingRequired'>,
  units: PickingLine['units'],
): PickingLine {
  return {
    itemId: uuid(100 + n),
    allocations: [],
    stockTracked: true,
    productId: uuid(200 + n),
    productCode: `1049${n}`,
    name: `Product ${n}`,
    unit: 'dona',
    quantity: String(units.length),
    ...rule,
    units,
    incompleteUnits: units.filter((u) => u.missing.length > 0).length,
  };
}

const unit = (n: number): PickingLine['units'][number] => ({
  unitId: uuid(n),
  unitNo: n % 10,
  codes: [],
  missing: [],
});

// Two phones (IMEI + marking), one TV (serial), one cable (nothing to scan).
function picking(): PickingResponse {
  const phoneRule = { trackingType: 'IMEI' as const, markingRequired: true };
  const missingPhone = [
    { kind: 'IMEI' as const, slot: 1 },
    { kind: 'MARKING' as const, slot: 1 },
  ];
  return {
    orderId: uuid(1),
    orderNumber: 'IO-10500',
    status: 'ACCOUNTING_CLEARED',
    rowVersion: 3,
    editable: true,
    complete: false,
    lines: [
      line(1, phoneRule, [
        { ...unit(11), missing: missingPhone },
        { ...unit(12), missing: missingPhone },
      ]),
      line(2, { trackingType: 'SERIAL', markingRequired: false }, [
        { ...unit(21), missing: [{ kind: 'SERIAL', slot: 1 }] },
      ]),
      line(3, { trackingType: 'NONE', markingRequired: false }, [unit(31), unit(32)]),
    ],
  };
}

function withCode(
  view: PickingResponse,
  unitId: string,
  kind: 'IMEI' | 'MARKING' | 'SERIAL',
  value: string,
): PickingResponse {
  return {
    ...view,
    lines: view.lines.map((l) => ({
      ...l,
      units: l.units.map((u) =>
        u.unitId === unitId
          ? {
              ...u,
              codes: [...u.codes, { kind, slot: 1, value, recordedAt: AT }],
              missing: u.missing.filter((m) => m.kind !== kind),
            }
          : u,
      ),
    })),
  };
}

describe('picking slots', () => {
  it('shows IMEI 1, the optional IMEI 2 and the marking per phone, the serial per TV, nothing for quantity goods', () => {
    const [phones, tv, cable] = lineViews(picking());
    expect(phones?.units[0]?.slots.map((s) => [s.kind, s.slot, s.required])).toEqual([
      ['IMEI', 1, true],
      ['IMEI', 2, false],
      ['MARKING', 1, true],
    ]);
    expect(tv?.units[0]?.slots.map((s) => s.kind)).toEqual(['SERIAL']);
    expect(cable?.scanless).toBe(true);
    expect(cable?.units[0]?.slots).toEqual([]);
  });

  it('counts only the units that need a code', () => {
    expect(pickingProgress(picking())).toEqual({ done: 0, total: 3 });
  });

  it('moves IMEI 1 -> marking of the same unit -> next unit, skipping IMEI 2 and busy slots', () => {
    const view = picking();
    const phone1 = uuid(11);
    const phone2 = uuid(12);
    const first = nextSlot(view, null);
    expect(first?.key).toBe(slotKey({ unitId: phone1, kind: 'IMEI', slot: 1 }));
    const afterImei = nextSlot(view, first?.key ?? null);
    expect(afterImei?.key).toBe(slotKey({ unitId: phone1, kind: 'MARKING', slot: 1 }));
    const afterMarking = nextSlot(view, afterImei?.key ?? null);
    expect(afterMarking?.key).toBe(slotKey({ unitId: phone2, kind: 'IMEI', slot: 1 }));
    // A scan still on its way counts as filled.
    const busy = new Set([slotKey({ unitId: phone2, kind: 'IMEI', slot: 1 })]);
    expect(nextSlot(view, afterImei?.key ?? null, busy)?.key).toBe(
      slotKey({ unitId: phone2, kind: 'MARKING', slot: 1 }),
    );
  });

  it('wraps round to an earlier empty slot and ends with null when everything is scanned', () => {
    let view = withCode(picking(), uuid(12), 'IMEI', demoImei(1));
    const tvSlot = slotKey({ unitId: uuid(21), kind: 'SERIAL', slot: 1 });
    expect(nextSlot(view, tvSlot)?.key).toBe(slotKey({ unitId: uuid(11), kind: 'IMEI', slot: 1 }));
    view = withCode(view, uuid(11), 'IMEI', demoImei(2));
    view = withCode(view, uuid(11), 'MARKING', 'M-1');
    view = withCode(view, uuid(12), 'MARKING', 'M-2');
    view = withCode(view, uuid(21), 'SERIAL', 'SN0001');
    expect(nextSlot(view, null)).toBeNull();
  });
});

describe('scan pre-check and refusals', () => {
  const target = { unitId: uuid(12), kind: 'IMEI' as const, slot: 1 };

  it('refuses a malformed code at once with the shared error', () => {
    expect(precheckScan(picking(), target, '35123')).toEqual({
      ok: false,
      refusal: { key: 'orders.picking.codeErrors.IMEI_FORMAT', reload: false },
    });
    const cyrillic = precheckScan(picking(), { ...target, kind: 'SERIAL' }, 'SNАБВ12');
    expect(cyrillic.ok === false && cyrillic.refusal.key).toBe(
      'orders.picking.codeErrors.NOT_ASCII',
    );
  });

  it('refuses a code already on another unit of the order, accepts the same slot again', () => {
    const imei = demoImei(7);
    const view = withCode(picking(), uuid(11), 'IMEI', imei);
    const result = precheckScan(view, target, imei);
    expect(result.ok === false && result.refusal.key).toBe('orders.picking.errors.duplicateHere');
    expect(precheckScan(view, { ...target, unitId: uuid(11) }, imei)).toEqual({
      ok: true,
      value: imei,
    });
  });

  it('maps server refusals to words, never the server text', () => {
    const invalid = new ApiValidationError('x', 'VALIDATION_FAILED', [
      { path: 'value', message: 'IMEI_CHECKSUM' },
    ]);
    expect(describeScanError(invalid).key).toBe('orders.picking.codeErrors.IMEI_CHECKSUM');
    const unknown = new ApiValidationError('x', 'VALIDATION_FAILED', [
      { path: 'value', message: '?' },
    ]);
    expect(describeScanError(unknown).key).toBe('orders.picking.codeErrors.invalid');
    const dup = new ApiConflictError(
      'x',
      'CONFLICT',
      { kind: 'IMEI', orderNumber: 'IO-1' },
      'UNIT_CODE_DUPLICATE',
    );
    expect(describeScanError(dup)).toEqual({
      key: 'orders.picking.errors.duplicateIn',
      params: { orderNumber: 'IO-1' },
      reload: false,
    });
    const raced = new ApiConflictError(
      'x',
      'CONFLICT',
      { kind: 'IMEI', orderNumber: null },
      'UNIT_CODE_DUPLICATE',
    );
    expect(describeScanError(raced).key).toBe('orders.picking.errors.duplicate');
    const locked = new ApiConflictError('x', 'CONFLICT', {}, 'UNIT_CODES_NOT_EDITABLE');
    expect(describeScanError(locked)).toMatchObject({ reload: true });
    expect(describeScanError(new ApiNotFoundError('x', 'NOT_FOUND')).reload).toBe(true);
    expect(describeScanError(new NetworkError()).key).toBe('apiErrors.network');
  });

  it('names the lines a refused release still misses', () => {
    const error = new ApiConflictError(
      'x',
      'CONFLICT',
      { items: [{ itemId: uuid(1), productCode: '10491', incompleteUnits: 2 }, { bad: true }] },
      'UNIT_CODES_INCOMPLETE',
    );
    expect(incompleteItems(error.details)).toEqual([
      { itemId: uuid(1), productCode: '10491', incompleteUnits: 2 },
    ]);
    expect(describeOrderError(error)).toEqual({
      key: 'orders.picking.errors.incompleteList',
      params: { products: '10491' },
      reload: false,
    });
  });

  it('shows the group separator of a marking code and the picking from approval on', () => {
    expect(displayCode('0104600\u001d93ab')).toBe('0104600␝93ab');
    expect(showsPicking('SUBMITTED')).toBe(false);
    expect(showsPicking('MANAGER_APPROVED')).toBe(true);
    expect(showsPicking('ACCOUNTING_CLEARED')).toBe(true);
    expect(showsPicking('CANCELLED')).toBe(false);
  });
});
