import type { SheetSyncRun } from '@iorder/shared/staff-cost';

// Sample deliveries, stock, sync reports and removal requests for the in-memory fake (dev, tests,
// VITE_USE_FAKE_API). Shaped like the sheet «Поставка»: 5-digit product ids, request ids like
// Z-20413, amounts in the thousands of so'm. Must never reach a production bundle:
// scripts/check-bundle.mjs looks for these strings.

export const FAKE_COST_BACKEND_MARKER = 'iorder-fake-cost-backend';

export const FAKE_SUPPLIERS = ['alpha trade import', 'Beta system tm fbs'] as const;
/** The invisible character that makes a supplier name a near miss (written as a code point). */
export const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
export const FAKE_PURCHASE_METHODS = ['Import', 'Local'] as const;

/** The rate the fake starts with (the example of the v1 design: $1 = 12 650 so'm). */
export const FAKE_START_RATE = '12650.0000';
export const FAKE_RATE_DATE = '2026-10-19';
export const FAKE_RATE_UPDATED_AT = '2026-10-19T04:00:00.000Z';

/** Delivery days, newest first: the date and the rate of that day (the rate is never recomputed). */
export const FAKE_DELIVERY_DAYS = [
  { date: '2026-10-16T05:00:00.000Z', rate: '12650.0000', request: 20413 },
  { date: '2026-10-09T05:00:00.000Z', rate: '12640.0000', request: 20371 },
  { date: '2026-10-02T05:00:00.000Z', rate: '12620.0000', request: 20330 },
  { date: '2026-09-25T05:00:00.000Z', rate: '12610.0000', request: 20288 },
  { date: '2026-09-18T05:00:00.000Z', rate: '12600.0000', request: 20247 },
  { date: '2026-09-10T05:00:00.000Z', rate: '12580.0000', request: 20206 },
  { date: '2026-09-02T05:00:00.000Z', rate: '12560.0000', request: 20164 },
] as const;

export interface FakeDeliverySpec {
  /** Index into FAKE_DELIVERY_DAYS. */
  readonly day: number;
  /** Cost in USD with 4 fraction digits. */
  readonly usd: string;
  readonly delivered: number;
  readonly available: number;
}

/**
 * Deliveries by product code, newest first. The stock aggregate of a product is the sum of the
 * available quantities of its live lines (this is how the sheet's «Доступное кол-во» is used).
 * Products without an entry have no delivery at all (10525 and the priced-but-unstocked 10499).
 */
export const FAKE_DELIVERIES: Readonly<Record<string, readonly FakeDeliverySpec[]>> = {
  '10482': [
    { day: 0, usd: '1.9500', delivered: 600, available: 420 },
    { day: 2, usd: '1.9000', delivered: 600, available: 180 },
    { day: 4, usd: '1.8500', delivered: 500, available: 0 },
  ],
  '10483': [
    { day: 0, usd: '9.2000', delivered: 120, available: 74 },
    { day: 1, usd: '9.4000', delivered: 100, available: 18 },
    { day: 3, usd: '9.4000', delivered: 100, available: 0 },
    { day: 5, usd: '9.9000', delivered: 80, available: 0 },
  ],
  '10484': [
    { day: 1, usd: '17.1000', delivered: 60, available: 12 },
    { day: 4, usd: '16.8000', delivered: 60, available: 0 },
  ],
  '10485': [
    { day: 0, usd: '24.0000', delivered: 50, available: 36 },
    { day: 2, usd: '23.5000', delivered: 50, available: 9 },
    { day: 3, usd: '23.5000', delivered: 40, available: 0 },
    { day: 5, usd: '24.8000', delivered: 40, available: 0 },
    { day: 6, usd: '25.0000', delivered: 40, available: 0 },
  ],
  '10486': [{ day: 0, usd: '0.4500', delivered: 2000, available: 1500 }],
  '10487': [{ day: 2, usd: '1.0000', delivered: 300, available: 0 }],
  '10488': [
    { day: 0, usd: '62.0000', delivered: 30, available: 26 },
    { day: 3, usd: '61.5000', delivered: 30, available: 4 },
  ],
  '10489': [
    { day: 1, usd: '21.5000', delivered: 70, available: 45 },
    { day: 3, usd: '21.8000', delivered: 70, available: 15 },
  ],
  '10490': [
    { day: 0, usd: '85.0000', delivered: 80, available: 58 },
    { day: 2, usd: '86.5000', delivered: 60, available: 22 },
    { day: 4, usd: '87.0000', delivered: 60, available: 0 },
  ],
  '10491': [
    { day: 0, usd: '128.5000', delivered: 40, available: 34 },
    { day: 1, usd: '129.0000', delivered: 40, available: 25 },
    { day: 3, usd: '131.0000', delivered: 30, available: 0 },
    { day: 4, usd: '133.0000', delivered: 30, available: 0 },
    { day: 5, usd: '133.5000', delivered: 30, available: 0 },
    { day: 6, usd: '135.0000', delivered: 30, available: 0 },
  ],
  '10492': [
    { day: 1, usd: '188.0000', delivered: 25, available: 11 },
    { day: 3, usd: '190.0000', delivered: 25, available: 0 },
  ],
  '10493': [{ day: 5, usd: '4.0000', delivered: 200, available: 0 }],
  '10494': [
    { day: 0, usd: '175.0000', delivered: 20, available: 20 },
    { day: 2, usd: '176.0000', delivered: 20, available: 5 },
  ],
  '10495': [{ day: 1, usd: '355.0000', delivered: 15, available: 8 }],
  '10496': [
    { day: 0, usd: '213.0000', delivered: 35, available: 28 },
    { day: 2, usd: '215.0000', delivered: 35, available: 6 },
  ],
  '10497': [{ day: 0, usd: '715.0000', delivered: 10, available: 7 }],
  '10498': [{ day: 3, usd: '450.0000', delivered: 6, available: 0 }],
  '10521': [{ day: 0, usd: '96.0000', delivered: 24, available: 24 }],
  '10522': [
    { day: 0, usd: '18.4000', delivered: 90, available: 90 },
    { day: 1, usd: '18.9000', delivered: 60, available: 31 },
  ],
  '10523': [{ day: 1, usd: '27.5000', delivered: 50, available: 3 }],
  '10524': [{ day: 4, usd: '510.0000', delivered: 8, available: 0 }],
};

/** Removal requests: a stored delivery line that vanished from the sheet (data-model §6.3). */
export const FAKE_REMOVAL_SEEDS: readonly {
  readonly productCode: string;
  readonly day: number;
  readonly detectedAt: string;
}[] = [
  { productCode: '10491', day: 4, detectedAt: '2026-10-19T04:00:09.000Z' },
  { productCode: '10483', day: 1, detectedAt: '2026-10-18T04:00:09.000Z' },
];

const RUN_ID = (n: number): string => `00000000-0000-4000-9000-${n.toString(16).padStart(12, '0')}`;

const NO_COUNTS = {
  rowsRead: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  rejected: 0,
  skippedRows: 0,
  staleRefs: 0,
  mismatches: 0,
  createdProducts: 0,
  removalsRequested: 0,
  removalsDismissed: 0,
  reappearedAfterRemoval: 0,
} as const;

/** Newest first, like `GET /staff/sheet-sync/runs`. */
export const FAKE_SYNC_RUNS: readonly SheetSyncRun[] = [
  {
    id: RUN_ID(3),
    startedAt: '2026-10-19T04:00:00.000Z',
    finishedAt: '2026-10-19T04:00:09.000Z',
    status: 'OK',
    trigger: 'MANUAL',
    counts: {
      rowsRead: 212,
      created: 4,
      updated: 2,
      unchanged: 188,
      rejected: 2,
      skippedRows: 15,
      staleRefs: 0,
      mismatches: 1,
      createdProducts: 3,
      removalsRequested: 2,
      removalsDismissed: 0,
      reappearedAfterRemoval: 0,
    },
    rejectedRows: [
      {
        header: 'Цена закупа $',
        reason: 'NOT_A_NUMBER',
        productCode: '10523',
        deliveryRef: 'Z-20371',
      },
      { header: 'Товар_ID', reason: 'MISSING_PRODUCT_CODE' },
    ],
    skippedSuppliers: [
      {
        supplier: 'Beta system tm fbs',
        reason: 'BEFORE_DATE_LIMIT',
        count: 12,
        hasInvisibleCharacters: false,
      },
      {
        // A near miss: the name only differs from a selected supplier by a hidden character.
        supplier: `${FAKE_SUPPLIERS[0]}${ZERO_WIDTH_SPACE}`,
        reason: 'SUPPLIER_NOT_SELECTED',
        count: 3,
        hasInvisibleCharacters: true,
      },
    ],
    createdProducts: ['10521', '10522', '10525'],
    pendingRemovalRequests: 2,
    costMismatches: [{ productCode: '10482', deliveryRef: 'Z-20413', differencePercent: '0.80' }],
    errorCode: null,
  },
  {
    id: RUN_ID(2),
    startedAt: '2026-10-18T04:00:00.000Z',
    finishedAt: '2026-10-18T04:00:03.000Z',
    status: 'FAILED',
    trigger: 'SCHEDULED',
    counts: NO_COUNTS,
    rejectedRows: [],
    skippedSuppliers: [],
    createdProducts: [],
    pendingRemovalRequests: 0,
    costMismatches: [],
    errorCode: 'SHEET_UNREACHABLE',
  },
  {
    id: RUN_ID(1),
    startedAt: '2026-10-17T04:00:00.000Z',
    finishedAt: '2026-10-17T04:00:08.000Z',
    status: 'OK',
    trigger: 'SCHEDULED',
    counts: { ...NO_COUNTS, rowsRead: 205, created: 205, createdProducts: 18 },
    rejectedRows: [],
    skippedSuppliers: [],
    createdProducts: [],
    pendingRemovalRequests: 0,
    costMismatches: [],
    errorCode: null,
  },
];
