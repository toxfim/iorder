import type { AllocationPreview, AllocationPreviewItem } from '@iorder/shared/staff-orders';
import { describe, expect, it } from 'vitest';
import {
  approveBlockers,
  rejectBlockers,
  releaseBlockers,
  type ApproveGate,
  type ReleaseGate,
} from './action-blockers';
import { draftIsValid, fifoDraft } from './allocation-plan';

// Every condition that locks approve, reject or release has a reason, in a fixed order: the first
// one is what the person must do first.

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const item = (n: number, name: string, over: Partial<AllocationPreviewItem> = {}) =>
  ({
    orderItemId: ID(n),
    productId: ID(n + 100),
    productCode: String(10_000 + n),
    name,
    quantity: '2.000',
    stockTracked: true,
    lines: [
      {
        supplyLineId: ID(n + 200),
        deliveryRef: `SP-${n}`,
        deliveredAt: '2026-10-01T00:00:00.000Z',
        availableQuantity: '9.000',
        heldQuantity: '0.000',
        freeQuantity: '9.000',
      },
    ],
    fifo: [{ supplyLineId: ID(n + 200), deliveryRef: `SP-${n}`, quantity: '2.000' }],
    shortQuantity: '0.000',
    earlierDemand: { orders: 0, quantity: '0.000' },
    current: [],
    ...over,
  }) satisfies AllocationPreviewItem;

const previewOf = (
  items: AllocationPreviewItem[],
  over: Partial<AllocationPreview> = {},
): AllocationPreview => ({
  orderId: ID(1),
  status: 'SUBMITTED',
  rowVersion: 1,
  feasible: true,
  attention: false,
  notAllocated: false,
  lastSheetChangeAt: null,
  items,
  ...over,
});

const good = previewOf([item(2, 'Galaxy A15'), item(3, 'Redmi 13')]);

const gate = (over: Partial<ApproveGate> = {}): ApproveGate => ({
  busy: false,
  draftPending: false,
  planState: 'ready',
  preview: good,
  draft: fifoDraft(good),
  paymentMethod: 'CASH',
  ...over,
});
const codes = (blockers: readonly { code: string }[]): string[] => blockers.map((b) => b.code);

describe('approve blockers', () => {
  it('has none when the items are saved, the plan fits and the sale type is chosen', () => {
    expect(approveBlockers(gate())).toEqual([]);
  });

  it.each([
    ['a running request', { busy: true }, 'BUSY'],
    ['unsaved item edits', { draftPending: true }, 'UNSAVED_ITEMS'],
    ['no sale type', { paymentMethod: null }, 'NO_PAYMENT_METHOD'],
    ['a plan not asked for yet', { planState: 'idle', preview: null }, 'PLAN_LOADING'],
    ['a plan still loading', { planState: 'loading', preview: null }, 'PLAN_LOADING'],
    ['a plan that failed to load', { planState: 'error', preview: null }, 'PLAN_UNAVAILABLE'],
    ['a plan the role may not read', { planState: 'denied', preview: null }, 'PLAN_DENIED'],
    ['a plan that is closed', { planState: 'closed', preview: null }, 'PLAN_CLOSED'],
    ['an order still loading (dialog)', { order: 'loading' }, 'ORDER_LOADING'],
    ['an order that failed to load (dialog)', { order: 'error' }, 'ORDER_UNAVAILABLE'],
  ] as const)('names %s', (_, over, code) => {
    expect(codes(approveBlockers(gate(over as Partial<ApproveGate>)))).toEqual([code]);
  });

  it('names the product that is short, and counts the others', () => {
    const one = previewOf(
      [item(2, 'Galaxy A15', { shortQuantity: '1.000' }), item(3, 'Redmi 13')],
      {
        feasible: false,
      },
    );
    expect(approveBlockers(gate({ preview: one, draft: fifoDraft(one) }))).toEqual([
      { code: 'STOCK_SHORT_ONE', params: { name: 'Galaxy A15' } },
    ]);
    const two = previewOf(
      [
        item(2, 'Galaxy A15', { shortQuantity: '1.000' }),
        item(3, 'Redmi 13', { shortQuantity: '2.000' }),
      ],
      { feasible: false },
    );
    expect(approveBlockers(gate({ preview: two, draft: fifoDraft(two) }))).toEqual([
      { code: 'STOCK_SHORT_MANY', params: { name: 'Galaxy A15', count: 1 } },
    ]);
  });

  it('says the stock is short without a name when the server names no line', () => {
    const refused = previewOf(good.items, { feasible: false });
    expect(codes(approveBlockers(gate({ preview: refused })))).toEqual(['STOCK_SHORT']);
  });

  it('never counts a product outside the plan (by order) as short or wrong', () => {
    const untracked = item(4, 'Powerbank', { stockTracked: false, lines: [], fifo: [] });
    const preview = previewOf([item(2, 'Galaxy A15'), untracked]);
    expect(approveBlockers(gate({ preview, draft: fifoDraft(preview) }))).toEqual([]);
  });

  it('names the product whose supplies do not add up to the ordered quantity', () => {
    const draft = { ...fifoDraft(good), [ID(3)]: { [ID(203)]: '1' } };
    expect(approveBlockers(gate({ draft }))).toEqual([
      { code: 'PLAN_INVALID_ONE', params: { name: 'Redmi 13' } },
    ]);
    const both = { [ID(2)]: { [ID(202)]: '5' }, [ID(3)]: { [ID(203)]: 'x' } };
    expect(approveBlockers(gate({ draft: both }))).toEqual([
      { code: 'PLAN_INVALID_MANY', params: { name: 'Galaxy A15', count: 1 } },
    ]);
  });

  it('orders several reasons as the work goes: items, then stock, then the sale type', () => {
    const short = previewOf([item(2, 'Galaxy A15', { shortQuantity: '1.000' })], {
      feasible: false,
    });
    expect(
      codes(
        approveBlockers(
          gate({
            draftPending: true,
            preview: short,
            draft: fifoDraft(short),
            paymentMethod: null,
          }),
        ),
      ),
    ).toEqual(['UNSAVED_ITEMS', 'STOCK_SHORT_ONE', 'NO_PAYMENT_METHOD']);
  });

  it('says only "wait" while a request runs or the dialog still reads the order', () => {
    const all = {
      draftPending: true,
      paymentMethod: null,
      preview: null,
      planState: 'error',
    } as const;
    expect(codes(approveBlockers(gate({ ...all, busy: true })))).toEqual(['BUSY']);
    expect(codes(approveBlockers(gate({ ...all, order: 'loading' })))).toEqual(['ORDER_LOADING']);
  });

  it('is empty exactly when the old lock (busy, draft, method, plan) was open', () => {
    const previews: (AllocationPreview | null)[] = [
      null,
      good,
      previewOf(good.items, { feasible: false }),
    ];
    for (const busy of [false, true]) {
      for (const draftPending of [false, true]) {
        for (const paymentMethod of [null, 'CASH'] as const) {
          for (const preview of previews) {
            for (const draft of [fifoDraft(good), { [ID(2)]: { [ID(202)]: '1' } }]) {
              const canSubmit =
                preview !== null && preview.feasible && draftIsValid(preview, draft);
              const locked = busy || draftPending || paymentMethod === null || !canSubmit;
              const blockers = approveBlockers(
                gate({ busy, draftPending, paymentMethod, preview, draft, planState: 'ready' }),
              );
              expect(blockers.length > 0).toBe(locked);
            }
          }
        }
      }
    }
  });
});

describe('reject blockers', () => {
  it('names unsaved item edits and a running request, nothing else', () => {
    expect(rejectBlockers({ busy: false, draftPending: false })).toEqual([]);
    expect(codes(rejectBlockers({ busy: false, draftPending: true }))).toEqual(['UNSAVED_ITEMS']);
    expect(codes(rejectBlockers({ busy: true, draftPending: true }))).toEqual(['BUSY']);
  });
});

describe('release blockers', () => {
  const ready = (over: Partial<ReleaseGate> = {}): ReleaseGate => ({
    busy: false,
    cleared: true,
    codesState: 'ready',
    codesComplete: true,
    codesProgress: { done: 3, total: 3 },
    driversState: 'ready',
    driverCount: 2,
    driverChosen: true,
    ...over,
  });

  it('has none once the order is cleared, every code is scanned and a driver is chosen', () => {
    expect(releaseBlockers(ready())).toEqual([]);
  });

  it.each([
    ['a running request', { busy: true }, 'BUSY'],
    ['codes still being read', { codesState: 'loading', codesComplete: false }, 'CODES_CHECKING'],
    ['codes not asked for yet', { codesState: 'idle', codesComplete: false }, 'CODES_CHECKING'],
    [
      'codes that failed to load',
      { codesState: 'error', codesComplete: false },
      'CODES_UNAVAILABLE',
    ],
    [
      'codes the role may not read',
      { codesState: 'denied', codesComplete: false },
      'CODES_UNAVAILABLE',
    ],
    ['drivers still loading', { driverChosen: false, driversState: 'loading' }, 'DRIVERS_LOADING'],
    [
      'drivers that failed to load',
      { driverChosen: false, driversState: 'error' },
      'DRIVERS_UNAVAILABLE',
    ],
    [
      'drivers the role may not read',
      { driverChosen: false, driversState: 'denied' },
      'DRIVERS_UNAVAILABLE',
    ],
    ['no active driver', { driverChosen: false, driverCount: 0 }, 'NO_DRIVERS'],
    ['no driver chosen', { driverChosen: false }, 'NO_DRIVER_CHOSEN'],
  ] as const)('names %s', (_, over, code) => {
    expect(codes(releaseBlockers(ready(over as Partial<ReleaseGate>)))).toEqual([code]);
  });

  it('counts the codes that are still missing', () => {
    expect(
      releaseBlockers(ready({ codesComplete: false, codesProgress: { done: 1, total: 3 } })),
    ).toEqual([{ code: 'CODES_MISSING', params: { done: 1, total: 3 } }]);
  });

  it('puts accounting first, then the codes; before clearance there is no driver to choose', () => {
    expect(
      codes(
        releaseBlockers(
          ready({
            cleared: false,
            codesComplete: false,
            codesProgress: { done: 0, total: 2 },
            driverChosen: false,
            driversState: 'idle',
          }),
        ),
      ),
    ).toEqual(['WAITING_ACCOUNTING', 'CODES_MISSING']);
    expect(codes(releaseBlockers(ready({ codesComplete: false, driverChosen: false })))).toEqual([
      'CODES_MISSING',
      'NO_DRIVER_CHOSEN',
    ]);
  });

  it('is empty exactly when the old lock (busy, step, driver, codes) was open', () => {
    for (const busy of [false, true]) {
      for (const cleared of [false, true]) {
        for (const driverChosen of [false, true]) {
          for (const codesComplete of [false, true]) {
            const locked = busy || !cleared || !driverChosen || !codesComplete;
            const blockers = releaseBlockers(ready({ busy, cleared, driverChosen, codesComplete }));
            expect(blockers.length > 0).toBe(locked);
          }
        }
      }
    }
  });
});
