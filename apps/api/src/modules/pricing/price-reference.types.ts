import type { UsdRateSource } from '@iorder/shared/staff-cost';
import type { Prisma } from '../../generated/prisma/client.js';

/** The fields of one delivery line that the sheet sync owns. Exact decimals, never float. */
export interface CostDeliveryData {
  /** Staff-only text, whitespace-collapsed, exactly as the sheet writes it. */
  supplier: string;
  purchaseMethod: string;
  category: string;
  deliveredQuantity: Prisma.Decimal;
  availableQuantity: Prisma.Decimal;
  /**
   * Null, all three together, while the sheet's cost cells of the line are still empty ("cost
   * pending"): the line counts for stock, has no cost yet. Enforced by a DB check.
   */
  costUsd: Prisma.Decimal | null;
  usdRateUsed: Prisma.Decimal | null;
  costUzs: Prisma.Decimal | null;
  deliveredAt: Date;
}

export interface CostDeliveryView extends CostDeliveryData {
  id: string;
  productId: string;
  deliveryRef: string;
  syncedAt: Date;
  /** Set when a manager confirmed the line's removal (soft removal). */
  removedAt: Date | null;
}

/** Input of the sync: one delivery of a product that is already known by id. */
export interface CostDeliveryInput extends CostDeliveryData {
  productId: string;
  deliveryRef: string;
}

export interface UsdRateView {
  rate: Prisma.Decimal | null;
  source: UsdRateSource | null;
  /** ISO date (YYYY-MM-DD) a CBU or CHANNEL rate is valid for; null for MANUAL or when unset. */
  rateDate: string | null;
  setBy: string | null;
  updatedAt: Date | null;
  followsCentralBank: boolean;
  /** A manual rate within its 24 hours, also while the channel's rate is the one in force. */
  manualRate: Prisma.Decimal | null;
  manualExpiresAt: Date | null;
  lastRefreshFailedAt: Date | null;
  lastChannelFailedAt: Date | null;
}

export interface UpsertDeliveriesResult {
  created: number;
  updated: number;
  unchanged: number;
  /**
   * Lines in the input that were already CONFIRMED as removed. They are NOT revived or updated
   * (a manager decided); the caller reports them (refs only).
   */
  skippedRemoved: { productId: string; deliveryRef: string }[];
}

/** One of the latest deliveries of a product: just what the price list shows. */
export interface CostDeliverySummaryView {
  productId: string;
  deliveredAt: Date;
  deliveryRef: string;
  supplier: string;
  /** Null together for a cost-pending line (see CostDeliveryData). */
  costUsd: Prisma.Decimal | null;
  usdRateUsed: Prisma.Decimal | null;
  costUzs: Prisma.Decimal | null;
}

/** Called INSIDE the write transaction with the products the call touched. */
export type AfterDeliveriesWritten = (
  tx: import('../../common/database/db-client.js').Tx,
  touchedProductIds: readonly string[],
) => Promise<void>;

/** One live delivery line as the mega report shows it (staff-only cost data, hard rule 7). */
export interface MegaReportLine {
  productId: string;
  /** The sheet's «ID заявки», exactly as stored. */
  deliveryRef: string;
  /** The sheet's «Доступное кол-во». */
  availableQuantity: Prisma.Decimal;
  costUsd: Prisma.Decimal | null;
  usdRateUsed: Prisma.Decimal | null;
  costUzs: Prisma.Decimal | null;
}
