import { describe, expect, it } from 'vitest';
import type { SyncReport } from './sheets-sync.service.js';
import { formatSyncCounts, summarizeSyncReport } from './sync-report-summary.js';

const report: SyncReport = {
  rowsRead: 10,
  skippedBySupplierFilter: [
    {
      supplier: 'SECRET SUPPLIER',
      reason: 'PRODUCT_NOT_SELECTED',
      count: 3,
      hasInvisibleCharacters: false,
    },
  ],
  created: 2,
  updated: 1,
  unchanged: 4,
  createdProducts: ['SECRET-CODE'],
  rejected: [{ index: 1, issues: [{ path: 'Дата', message: 'bad' }] }],
  staleRefs: [],
  mismatches: [{ productCode: 'SECRET-CODE', deliveryRef: 'r', differencePercent: '12.5' }],
  derivedUsdCosts: [{ productCode: 'SECRET-CODE', deliveryRef: 'r' }],
  stock: { created: 1, updated: 2, unchanged: 5 },
  categoriesChanged: 0,
  removals: { requested: 1, dismissed: 0 },
  reappearedAfterRemoval: [],
};

describe('summarizeSyncReport', () => {
  it('reduces a report to numbers only', () => {
    const counts = summarizeSyncReport(report);
    expect(counts).toMatchObject({
      rowsRead: 10,
      skippedBySupplierFilter: 3,
      created: 2,
      rejected: 1,
      mismatches: 1,
      stockChanged: 3,
      removalsRequested: 1,
    });
    expect(Object.values(counts).every((v) => typeof v === 'number')).toBe(true);
  });

  it('prints no names, codes or values', () => {
    const line = formatSyncCounts(summarizeSyncReport(report));
    expect(line).toContain('rowsRead=10');
    expect(line).not.toContain('SECRET');
    expect(line).not.toContain('12.5');
  });
});
