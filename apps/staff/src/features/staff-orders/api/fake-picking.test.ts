import { fifoPlanOf } from './fake-allocation';
import type { StaffRole } from '@iorder/shared';
import { pickingResponseSchema, type PickingResponse } from '@iorder/shared/staff-orders';
import { describe, expect, it } from 'vitest';
import type { ApiConflictError } from '@core/lib/api-errors';
import { ApiValidationError, PermissionDeniedError } from '@core/lib/api-errors';
import { fakeOrderId } from '@core/lib/fake-ids';
import { FAKE_CODE_RULES } from '@/features/pricing/api/fake-price-fixtures';
import { createFakeStaffOrders } from './fake-staff-orders-backend';
import { demoImei } from './fake-picking';

// The picking half of the fake must decide like the api's PickingService: who reads and who
// scans, the shared validator, uniqueness over live units, and the release gate.

const WHO = {
  manager: { name: 'Aziza Yusupova', roles: ['MANAGER'] },
  warehouse: { name: 'Rustam Qodirov', roles: ['WAREHOUSE_MANAGER'] },
  driver: { name: 'Bekzod Tursunov', roles: ['DRIVER'] },
} as const satisfies Record<string, { name: string; roles: readonly StaffRole[] }>;
type Who = keyof typeof WHO;

const DEMO = fakeOrderId('IO-10500');
const RELEASED = fakeOrderId('IO-10488');
const SUBMITTED_PHONES = fakeOrderId('IO-10491');

function setup(pickingDemo = true) {
  let current: Who = 'warehouse';
  const fake = createFakeStaffOrders({
    clock: { now: () => new Date('2026-10-19T04:30:00.000Z') },
    actor: () => WHO[current],
    productRule: (code) =>
      FAKE_CODE_RULES[code] ?? { trackingType: 'NONE', markingRequired: false },
    pickingDemo,
  });
  const as = <T>(who: Who, work: () => Promise<T>): Promise<T> => {
    current = who;
    return work();
  };
  return { ...fake, as };
}

const unitsOf = (view: PickingResponse, productCode: string) =>
  view.lines.find((l) => l.productCode === productCode)?.units ?? [];
const caught = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => null,
    (e) => e,
  );

describe('fake picking: reading', () => {
  it('adds the demo order only when asked, so the seeded counts stay', async () => {
    const plain = setup(false);
    const list = await plain.as('manager', () => plain.ordersApi.listOrders({ limit: 100 }));
    expect(list.orders.some((o) => o.orderNumber === 'IO-10500')).toBe(false);
    const demo = setup();
    const withDemo = await demo.as('manager', () => demo.ordersApi.listOrders({ limit: 100 }));
    expect(withDemo.orders.some((o) => o.orderNumber === 'IO-10500')).toBe(true);
  });

  it('answers the strict shared schema with one unit per piece and the slots the rule asks for', async () => {
    const { ordersApi, as } = setup();
    const view = await as('warehouse', () => ordersApi.getPicking(DEMO));
    expect(() => pickingResponseSchema.parse(view)).not.toThrow();
    expect(view.editable).toBe(true);
    expect(view.complete).toBe(false);
    const phone = view.lines.find((l) => l.trackingType === 'IMEI');
    expect(phone?.markingRequired).toBe(true);
    expect(phone?.units.map((u) => u.missing)).toEqual([
      [
        { kind: 'IMEI', slot: 1 },
        { kind: 'MARKING', slot: 1 },
      ],
      [
        { kind: 'IMEI', slot: 1 },
        { kind: 'MARKING', slot: 1 },
      ],
    ]);
    const tv = view.lines.find((l) => l.trackingType === 'SERIAL');
    expect(tv?.units[0]?.missing).toEqual([{ kind: 'SERIAL', slot: 1 }]);
    const cable = view.lines.find((l) => l.trackingType === 'NONE' && !l.markingRequired);
    expect(cable?.incompleteUnits).toBe(0);
  });

  it('shows the codes read-only to the manager, refuses the driver and fills released orders', async () => {
    const { ordersApi, as } = setup();
    expect((await as('manager', () => ordersApi.getPicking(DEMO))).editable).toBe(false);
    expect(await caught(as('driver', () => ordersApi.getPicking(RELEASED)))).toBeInstanceOf(
      PermissionDeniedError,
    );
    const released = await as('manager', () => ordersApi.getPicking(RELEASED));
    expect(released.complete).toBe(true);
    expect(released.editable).toBe(false);
  });
});

describe('fake picking: scanning', () => {
  it('validates with the shared validator and stores the normalised value', async () => {
    const { ordersApi, as } = setup();
    const view = await as('warehouse', () => ordersApi.getPicking(DEMO));
    const phoneCode = view.lines.find((l) => l.trackingType === 'IMEI')?.productCode ?? '';
    const unit = unitsOf(view, phoneCode)[0];
    if (!unit) throw new Error('no phone unit');
    const bad = await caught(
      as('warehouse', () =>
        ordersApi.recordUnitCode(DEMO, unit.unitId, {
          kind: 'IMEI',
          slot: 1,
          value: '123456789012345',
        }),
      ),
    );
    expect(bad).toBeInstanceOf(ApiValidationError);
    expect((bad as ApiValidationError).issues[0]?.message).toBe('IMEI_CHECKSUM');
    const imei = demoImei(9001);
    const spaced = `${imei.slice(0, 5)} ${imei.slice(5)}`;
    const after = await as('warehouse', () =>
      ordersApi.recordUnitCode(DEMO, unit.unitId, { kind: 'IMEI', slot: 1, value: spaced }),
    );
    const stored = unitsOf(after, phoneCode)[0];
    expect(stored?.codes.map((c) => c.value)).toEqual([imei]);
    expect(stored?.missing).toEqual([{ kind: 'MARKING', slot: 1 }]);
  });

  it('refuses a code another live unit holds, a slot the rule does not take and other roles', async () => {
    const { ordersApi, as } = setup();
    const view = await as('warehouse', () => ordersApi.getPicking(DEMO));
    const phone = view.lines.find((l) => l.trackingType === 'IMEI');
    const [first, second] = phone?.units ?? [];
    if (!first || !second) throw new Error('two phone units expected');
    const imei = demoImei(9002);
    await as('warehouse', () =>
      ordersApi.recordUnitCode(DEMO, first.unitId, { kind: 'IMEI', slot: 1, value: imei }),
    );
    const duplicate = await caught(
      as('warehouse', () =>
        ordersApi.recordUnitCode(DEMO, second.unitId, { kind: 'IMEI', slot: 1, value: imei }),
      ),
    );
    expect((duplicate as ApiConflictError).reason).toBe('UNIT_CODE_DUPLICATE');
    expect((duplicate as ApiConflictError).details).toEqual({
      kind: 'IMEI',
      orderNumber: 'IO-10500',
    });
    const serial = await caught(
      as('warehouse', () =>
        ordersApi.recordUnitCode(DEMO, first.unitId, { kind: 'SERIAL', slot: 1, value: 'SN12345' }),
      ),
    );
    expect((serial as ApiConflictError).reason).toBe('UNIT_CODE_NOT_REQUIRED');
    const byManager = await caught(
      as('manager', () =>
        ordersApi.recordUnitCode(DEMO, second.unitId, {
          kind: 'IMEI',
          slot: 1,
          value: demoImei(1),
        }),
      ),
    );
    expect(byManager).toBeInstanceOf(PermissionDeniedError);
  });

  it('gates the release until every required code is there, then locks the codes', async () => {
    const { ordersApi, driversApi, as } = setup();
    const [driver] = await driversApi.listActiveDrivers();
    const order = await as('warehouse', () => ordersApi.getOrder(DEMO));
    const refused = await caught(
      as('warehouse', () =>
        ordersApi.release(DEMO, {
          driverUserId: driver?.id ?? '',
          expectedRowVersion: order.rowVersion,
        }),
      ),
    );
    expect((refused as ApiConflictError).reason).toBe('UNIT_CODES_INCOMPLETE');
    const items = (refused as ApiConflictError).details as { items: { incompleteUnits: number }[] };
    expect(items.items.map((i) => i.incompleteUnits)).toEqual([2, 1]);

    let view = await as('warehouse', () => ordersApi.getPicking(DEMO));
    let seed = 9100;
    for (const line of view.lines) {
      for (const unit of line.units) {
        for (const slot of unit.missing) {
          seed += 1;
          const value =
            slot.kind === 'IMEI'
              ? demoImei(seed)
              : slot.kind === 'SERIAL'
                ? `TV${seed}`
                : `0104600000000999${seed}21X${seed}\u001d93Ab`;
          view = await as('warehouse', () =>
            ordersApi.recordUnitCode(DEMO, unit.unitId, {
              kind: slot.kind,
              slot: slot.slot,
              value,
            }),
          );
        }
      }
    }
    expect(view.complete).toBe(true);
    const released = await as('warehouse', () =>
      ordersApi.release(DEMO, {
        driverUserId: driver?.id ?? '',
        expectedRowVersion: order.rowVersion,
      }),
    );
    expect(released.status).toBe('RELEASED');
    const unit = view.lines[0]?.units[0];
    const locked = await caught(
      as('warehouse', () => ordersApi.clearUnitCode(DEMO, unit?.unitId ?? '', 'IMEI', 1)),
    );
    expect((locked as ApiConflictError).reason).toBe('UNIT_CODES_NOT_EDITABLE');
  });

  it('frees the codes of a cancelled order for other orders', async () => {
    const { ordersApi, as } = setup();
    const imei = demoImei(9300);
    const demo = await as('warehouse', () => ordersApi.getPicking(DEMO));
    const demoUnit = demo.lines.find((l) => l.trackingType === 'IMEI')?.units[0];
    await as('warehouse', () =>
      ordersApi.recordUnitCode(DEMO, demoUnit?.unitId ?? '', {
        kind: 'IMEI',
        slot: 1,
        value: imei,
      }),
    );
    // Another phone order reaches the warehouse (manager approves without accounting).
    const submitted = await as('manager', () => ordersApi.getOrder(SUBMITTED_PHONES));
    await as('manager', async () =>
      ordersApi.approve(SUBMITTED_PHONES, {
        ...(await fifoPlanOf(ordersApi, SUBMITTED_PHONES)),
        skipAccounting: true,
        paymentMethod: 'CASH',
        expectedRowVersion: submitted.rowVersion,
      }),
    );
    const other = await as('warehouse', () => ordersApi.getPicking(SUBMITTED_PHONES));
    const otherUnit = other.lines.find((l) => l.trackingType === 'IMEI')?.units[0];
    const scan = () =>
      as('warehouse', () =>
        ordersApi.recordUnitCode(SUBMITTED_PHONES, otherUnit?.unitId ?? '', {
          kind: 'IMEI',
          slot: 1,
          value: imei,
        }),
      );
    expect(((await caught(scan())) as ApiConflictError).details).toEqual({
      kind: 'IMEI',
      orderNumber: 'IO-10500',
    });
    const demoOrder = await as('manager', () => ordersApi.getOrder(DEMO));
    await as('manager', () =>
      ordersApi.cancel(DEMO, {
        reason: 'Mijoz rad etdi',
        expectedRowVersion: demoOrder.rowVersion,
      }),
    );
    const accepted = await scan();
    expect(accepted.lines.find((l) => l.trackingType === 'IMEI')?.units[0]?.codes[0]?.value).toBe(
      imei,
    );
  });
});
