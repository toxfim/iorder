import {
  allocationPreviewSchema,
  type AllocationMode,
  type AllocationPreview,
  type AllocationPreviewItem,
  type AllocationRequestRow,
} from '@iorder/shared/staff-orders';
import { fromMilli, toMilli } from '@core/lib/quantity';

/** The manager's draft: per order line, per delivery line, quantities as text. */
export type PlanDraft = Readonly<Record<string, Readonly<Record<string, string>>>>;

function rowsToDraft(
  rows: (item: AllocationPreviewItem) => readonly { supplyLineId: string; quantity: string }[],
  preview: AllocationPreview,
): PlanDraft {
  return Object.fromEntries(
    preview.items.map((item) => [
      item.orderItemId,
      Object.fromEntries(
        rows(item).map((row) => [row.supplyLineId, fromMilli(toMilli(row.quantity))]),
      ),
    ]),
  );
}

export const fifoDraft = (preview: AllocationPreview): PlanDraft =>
  rowsToDraft((item) => item.fifo, preview);

export const currentDraft = (preview: AllocationPreview): PlanDraft =>
  rowsToDraft((item) => item.current, preview);

function milliOf(text: string | undefined): bigint | null {
  if (text === undefined || text.trim() === '') return 0n;
  try {
    return toMilli(text.trim());
  } catch {
    return null;
  }
}

export type ItemCheck = 'OK' | 'TOO_LITTLE' | 'TOO_MUCH' | 'OVER_LINE' | 'NOT_A_NUMBER';

/** What is wrong with one order line of the draft. The server decides again on the real stock. */
export function checkItem(item: AllocationPreviewItem, draft: PlanDraft): ItemCheck {
  // A product outside the plan (no sheet «Товар_ID») has nothing to cover: it never blocks.
  if (!item.stockTracked) return 'OK';
  const rows = draft[item.orderItemId] ?? {};
  const wanted = toMilli(item.quantity);
  // Whole pieces, except a legacy fractional order line.
  const wholeOnly = wanted % 1000n === 0n;
  let sum = 0n;
  for (const line of item.lines) {
    const asked = milliOf(rows[line.supplyLineId]);
    if (asked === null) return 'NOT_A_NUMBER';
    if (wholeOnly && asked % 1000n !== 0n) return 'NOT_A_NUMBER';
    if (asked > toMilli(line.freeQuantity)) return 'OVER_LINE';
    sum += asked;
  }
  if (sum < wanted) return 'TOO_LITTLE';
  return sum > wanted ? 'TOO_MUCH' : 'OK';
}

export const draftIsValid = (preview: AllocationPreview, draft: PlanDraft): boolean =>
  preview.items.every((item) => checkItem(item, draft) === 'OK');

/** The rows a request carries; lines left at zero are not rows. */
export function draftRows(preview: AllocationPreview, draft: PlanDraft): AllocationRequestRow[] {
  return preview.items.flatMap((item) =>
    Object.entries(draft[item.orderItemId] ?? {}).flatMap(([supplyLineId, quantity]) =>
      (milliOf(quantity) ?? 0n) > 0n
        ? [{ orderItemId: item.orderItemId, supplyLineId, quantity }]
        : [],
    ),
  );
}

/** What approve and the manager's change send. */
export interface PlanChoice {
  readonly allocationMode: AllocationMode;
  readonly allocations: readonly AllocationRequestRow[];
}

export const fifoChoice = (preview: AllocationPreview): PlanChoice => ({
  allocationMode: 'FIFO',
  allocations: draftRows(preview, fifoDraft(preview)),
});

/** Reads the fresh plan of a 409 ALLOCATION_CHANGED or STOCK_INSUFFICIENT; null when malformed. */
export function previewOfConflict(details: unknown): AllocationPreview | null {
  if (typeof details !== 'object' || details === null || !('preview' in details)) return null;
  const parsed = allocationPreviewSchema.safeParse(details.preview);
  return parsed.success ? parsed.data : null;
}

/** The rows that differ from the proposal make the plan the manager's own choice. */
export function modeOf(preview: AllocationPreview, draft: PlanDraft): AllocationMode {
  const proposed = draftRows(preview, fifoDraft(preview));
  const chosen = draftRows(preview, draft);
  const key = (row: AllocationRequestRow): string =>
    `${row.orderItemId}|${row.supplyLineId}|${toMilli(row.quantity)}`;
  const same =
    proposed.length === chosen.length &&
    new Set(proposed.map(key)).size === new Set([...proposed, ...chosen].map(key)).size;
  return same ? 'FIFO' : 'MANUAL';
}
