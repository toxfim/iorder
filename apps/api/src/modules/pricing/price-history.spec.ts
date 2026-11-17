import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { computePriceHistory, type PriceAtVersion } from './price-history.js';
import type { VersionView } from './pricing.types.js';

const version = (n: number, day: number, status: VersionView['status']): VersionView => ({
  id: `v${n}`,
  number: n,
  status,
  publishedAt: new Date(Date.UTC(2026, 9, day)),
  publishedBy: `user${n}`,
  note: null,
  source: n === 3 ? 'SHEET_IMPORT' : 'MANUAL',
  createdAt: new Date(Date.UTC(2026, 9, day - 1)),
});
const price = (value: string): PriceAtVersion => ({
  basePrice: new Prisma.Decimal(value),
  deferredPrice: null,
  rrp: null,
  currency: 'UZS',
});

describe('computePriceHistory', () => {
  const versions = [
    version(3, 12, 'PUBLISHED'),
    version(1, 10, 'ARCHIVED'),
    version(2, 11, 'ARCHIVED'),
  ];

  it('returns old and new price with who/when/source, oldest first', () => {
    const history = computePriceHistory(
      versions,
      new Map([
        ['v1', price('100.00')],
        ['v2', price('120.50')],
        ['v3', price('130.00')],
      ]),
    );
    expect(
      history.map((e) => [e.versionNumber, e.oldPrice?.toFixed(2) ?? null, e.newPrice?.toFixed(2)]),
    ).toEqual([
      [1, null, '100.00'],
      [2, '100.00', '120.50'],
      [3, '120.50', '130.00'],
    ]);
    expect(history[2]).toMatchObject({ publishedBy: 'user3', source: 'SHEET_IMPORT' });
  });

  it('skips versions where the price did not change and shows removal as newPrice null', () => {
    const history = computePriceHistory(
      versions,
      new Map([
        ['v1', price('100.00')],
        ['v2', price('100.00')],
      ]),
    );
    expect(
      history.map((e) => [
        e.versionNumber,
        e.oldPrice?.toFixed(2) ?? null,
        e.newPrice?.toFixed(2) ?? null,
      ]),
    ).toEqual([
      [1, null, '100.00'],
      [3, '100.00', null],
    ]);
  });

  it('records a version where only the cash price changed, with both cash prices', () => {
    const withCash = (base: string, cash: string | null): PriceAtVersion => ({
      ...price(base),
      deferredPrice: cash === null ? null : new Prisma.Decimal(cash),
    });
    const history = computePriceHistory(
      versions,
      new Map([
        ['v1', withCash('100.00', null)],
        ['v2', withCash('100.00', '95.00')],
        ['v3', withCash('100.00', '95.00')],
      ]),
    );
    expect(
      history.map((e) => [
        e.versionNumber,
        e.oldPrice?.toFixed(2) ?? null,
        e.newPrice?.toFixed(2) ?? null,
        e.oldDeferredPrice?.toFixed(2) ?? null,
        e.newDeferredPrice?.toFixed(2) ?? null,
      ]),
    ).toEqual([
      [1, null, '100.00', null, null],
      [2, '100.00', '100.00', null, '95.00'],
    ]);
  });

  it('records a version where only the RRP changed, with both RRPs', () => {
    const withRrp = (base: string, rrp: string | null): PriceAtVersion => ({
      ...price(base),
      rrp: rrp === null ? null : new Prisma.Decimal(rrp),
    });
    const history = computePriceHistory(
      versions,
      new Map([
        ['v1', withRrp('100.00', null)],
        ['v2', withRrp('100.00', '149.00')],
        ['v3', withRrp('100.00', '149.00')],
      ]),
    );
    expect(
      history.map((e) => [
        e.versionNumber,
        e.oldPrice?.toFixed(2) ?? null,
        e.newPrice?.toFixed(2) ?? null,
        e.oldRrp?.toFixed(2) ?? null,
        e.newRrp?.toFixed(2) ?? null,
      ]),
    ).toEqual([
      [1, null, '100.00', null, null],
      [2, '100.00', '100.00', null, '149.00'],
    ]);
    // Removing the RRP is a change too; removing the product ends with no RRP.
    const removed = computePriceHistory(
      versions,
      new Map([
        ['v1', withRrp('100.00', '149.00')],
        ['v2', withRrp('100.00', null)],
      ]),
    );
    expect(
      removed.map((e) => [e.oldRrp?.toFixed(2) ?? null, e.newRrp?.toFixed(2) ?? null]),
    ).toEqual([
      [null, '149.00'],
      ['149.00', null],
      [null, null],
    ]);
  });

  it('is empty for a product that never had a price', () => {
    expect(computePriceHistory(versions, new Map())).toEqual([]);
  });

  it('ignores drafts (no publication data)', () => {
    const draft: VersionView = { ...version(4, 13, 'DRAFT'), publishedAt: null, publishedBy: null };
    expect(computePriceHistory([draft], new Map([['v4', price('1.00')]]))).toEqual([]);
  });
});
