import type { StaffRole } from '@iorder/shared';
import { PermissionDeniedError } from '@core/lib/api-errors';
import type { ActivityHistoryApi, ActivityHistoryEntry } from './activity-history-api';

// Dev and test only (behind the fake-API gate, never in a production bundle): demo rows in the
// shape the page expects, so the screen can be reviewed before the api exposes the audit trail.

const DEMO_ENTRIES: readonly ActivityHistoryEntry[] = [
  {
    id: 'fake-history-8',
    at: '2026-10-20T05:32:08.000Z',
    actor: { kind: 'STAFF', name: 'Aziz Karimov', role: 'MANAGER' },
    object: { type: 'PRICE_LIST', label: 'v13', detail: null },
    action: 'PRICE_LIST_PUBLISHED',
    before: { kind: 'VERSION', number: 12 },
    after: { kind: 'VERSION', number: 13 },
    note: 'Yetkazib beruvchi narxi oshdi',
  },
  {
    id: 'fake-history-7',
    at: '2026-10-20T05:18:42.000Z',
    actor: { kind: 'STAFF', name: 'Javohir Ergashev', role: 'DRIVER' },
    object: { type: 'ORDER', label: 'IO-1046', detail: 'Korzinka' },
    action: 'ORDER_DELIVERED',
    before: { kind: 'STATUS', status: 'RELEASED' },
    after: { kind: 'STATUS', status: 'DELIVERED' },
    note: null,
  },
  {
    id: 'fake-history-6',
    at: '2026-10-20T04:48:16.000Z',
    actor: { kind: 'STAFF', name: 'Dilnoza Saidova', role: 'ACCOUNTANT' },
    object: { type: 'ORDER', label: 'IO-1047', detail: 'Akfa Group' },
    action: 'ORDER_ACCOUNTING_CLEARED',
    before: { kind: 'STATUS', status: 'MANAGER_APPROVED' },
    after: { kind: 'STATUS', status: 'ACCOUNTING_CLEARED' },
    note: null,
  },
  {
    id: 'fake-history-5',
    at: '2026-10-20T04:30:00.000Z',
    actor: { kind: 'STAFF', name: 'Aziz Karimov', role: 'MANAGER' },
    object: { type: 'PAYMENT', label: 'Artel Electronics', detail: null },
    action: 'PAYMENT_RECORDED',
    before: { kind: 'NONE' },
    after: { kind: 'MONEY', amount: '3240000.00' },
    note: 'Naqd, kassaga',
  },
  {
    id: 'fake-history-4',
    at: '2026-10-20T04:24:31.000Z',
    actor: { kind: 'STAFF', name: 'Aziz Karimov', role: 'MANAGER' },
    object: { type: 'ORDER', label: 'IO-1048', detail: 'Artel Electronics' },
    action: 'ORDER_APPROVED',
    before: { kind: 'STATUS', status: 'SUBMITTED' },
    after: { kind: 'STATUS', status: 'MANAGER_APPROVED' },
    note: null,
  },
  {
    id: 'fake-history-3',
    at: '2026-10-20T04:12:05.000Z',
    actor: { kind: 'CUSTOMER', name: 'Madina Rasulova', organization: 'Artel Electronics' },
    object: { type: 'ORDER', label: 'IO-1048', detail: 'Artel Electronics' },
    action: 'ORDER_SUBMITTED',
    before: { kind: 'NONE' },
    after: { kind: 'STATUS', status: 'SUBMITTED' },
    note: null,
  },
  {
    id: 'fake-history-2',
    at: '2026-10-19T12:05:22.000Z',
    actor: { kind: 'STAFF', name: 'Aziz Karimov', role: 'MANAGER' },
    object: { type: 'STAFF', label: "Kamol Yo'ldoshev", detail: 'kamol' },
    action: 'STAFF_BLOCKED',
    before: { kind: 'ACTIVE', active: true },
    after: { kind: 'ACTIVE', active: false },
    note: "Mehnat ta'tili davrida",
  },
  {
    id: 'fake-history-1',
    at: '2026-10-19T11:20:11.000Z',
    actor: { kind: 'STAFF', name: 'Shaxzoda Tohirova', role: 'MANAGER' },
    object: { type: 'ORGANIZATION', label: 'Makro', detail: null },
    action: 'ORGANIZATION_ACTIVATED',
    before: { kind: 'ACTIVE', active: false },
    after: { kind: 'ACTIVE', active: true },
    note: null,
  },
];

export interface FakeActivityHistoryOptions {
  readonly roles: () => readonly StaffRole[];
  readonly latencyMs?: number;
  readonly entries?: readonly ActivityHistoryEntry[];
}

export function createFakeActivityHistoryApi(
  options: FakeActivityHistoryOptions,
): ActivityHistoryApi {
  const entries = options.entries ?? DEMO_ENTRIES;
  const wait = (): Promise<void> =>
    options.latencyMs
      ? new Promise((resolve) => setTimeout(resolve, options.latencyMs))
      : Promise.resolve();
  return {
    list: async () => {
      await wait();
      // The same rule the route uses (admin, manager): a direct call by another role is refused.
      if (
        !options
          .roles()
          .some((role) => role === 'ADMIN' || role === 'MANAGER' || role === 'PURCHASING_MANAGER')
      ) {
        throw new PermissionDeniedError('Activity history is for admin and manager');
      }
      return { available: true, entries: [...entries] };
    },
  };
}
