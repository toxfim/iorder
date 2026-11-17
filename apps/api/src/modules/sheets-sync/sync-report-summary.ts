import type { SyncReport } from './sheets-sync.service.js';

/** Only numbers: safe to print or log (no supplier names, product codes or cost values). */
export interface SyncReportCounts {
  rowsRead: number;
  skippedBySupplierFilter: number;
  created: number;
  updated: number;
  unchanged: number;
  createdProducts: number;
  rejected: number;
  staleRefs: number;
  mismatches: number;
  derivedUsdCosts: number;
  stockChanged: number;
  removalsRequested: number;
}

export function summarizeSyncReport(report: SyncReport): SyncReportCounts {
  return {
    rowsRead: report.rowsRead,
    skippedBySupplierFilter: report.skippedBySupplierFilter.reduce((sum, s) => sum + s.count, 0),
    created: report.created,
    updated: report.updated,
    unchanged: report.unchanged,
    createdProducts: report.createdProducts.length,
    rejected: report.rejected.length,
    staleRefs: report.staleRefs.length,
    mismatches: report.mismatches.length,
    derivedUsdCosts: report.derivedUsdCosts.length,
    stockChanged: report.stock.created + report.stock.updated,
    removalsRequested: report.removals.requested,
  };
}

/** One line such as `rowsRead=120 created=3 ...`, built only from `SyncReportCounts`. */
export function formatSyncCounts(counts: SyncReportCounts): string {
  return Object.entries(counts)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(' ');
}
