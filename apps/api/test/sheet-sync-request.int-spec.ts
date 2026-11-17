import { sheetSyncRequestResponseSchema } from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { PricingModule } from '../src/modules/pricing/index.js';
import { SheetSyncQueue } from '../src/modules/sheets-sync/sheet-sync-queue.js';
import { SheetsSyncModule } from '../src/modules/sheets-sync/sheets-sync.module.js';
import { resetCatalogPricingAudit } from './support/test-db.js';
import {
  ACCOUNTANT,
  ADMIN,
  createTestApp,
  DRIVER,
  MANAGER,
  SELLER,
  WAREHOUSE,
  type TestApp,
} from './support/test-app.js';

/** Stands in for the worker's queue: the request must never read the sheet or run a sync here. */
class FakeSheetSyncQueue extends SheetSyncQueue {
  requests = 0;
  async request(): Promise<'QUEUED' | 'ALREADY_QUEUED'> {
    this.requests += 1;
    return this.requests === 1 ? 'QUEUED' : 'ALREADY_QUEUED';
  }
}

describe('"sync now" with the sheet (real PostgreSQL)', () => {
  let t: TestApp;
  const queue = new FakeSheetSyncQueue();

  beforeAll(async () => {
    t = await createTestApp([PricingModule, CatalogModule, SheetsSyncModule], {
      overrides: [{ token: SheetSyncQueue, value: queue }],
    });
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    queue.requests = 0;
    await resetCatalogPricingAudit(t.prisma);
  });

  const request = (actor: Actor) => t.request('POST', '/staff/sheet-sync/runs', { actor });

  it('queues one run for a manager, reports ALREADY_QUEUED for the next press, and audits both', async () => {
    const first = await request(MANAGER);
    expect(first.status).toBe(202);
    expect(sheetSyncRequestResponseSchema.parse(first.body)).toEqual({ outcome: 'QUEUED' });

    const second = await request(ADMIN);
    expect(second.status).toBe(202);
    expect(sheetSyncRequestResponseSchema.parse(second.body)).toEqual({
      outcome: 'ALREADY_QUEUED',
    });
    expect(queue.requests).toBe(2);

    const rows = await t.prisma.auditLog.findMany({
      where: { action: 'SHEET_SYNC_REQUESTED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => [r.actorUserId, r.entityType, r.entityId])).toEqual([
      [MANAGER.userId, 'SHEET_SYNC', 'cost-reference'],
      [ADMIN.userId, 'SHEET_SYNC', 'cost-reference'],
    ]);
    expect(rows.map((r) => (r.diff as { outcome: { to: string } }).outcome.to)).toEqual([
      'QUEUED',
      'ALREADY_QUEUED',
    ]);
  });

  it('refuses the accountant (reports only), warehouse, driver, customers and anonymous callers, queuing nothing', async () => {
    for (const actor of [ACCOUNTANT, WAREHOUSE, DRIVER, SELLER]) {
      expect((await request(actor)).status, JSON.stringify(actor)).toBe(403);
    }
    expect((await t.request('POST', '/staff/sheet-sync/runs')).status).toBe(401);
    expect(queue.requests).toBe(0);
    expect(await t.prisma.auditLog.count({ where: { action: 'SHEET_SYNC_REQUESTED' } })).toBe(0);
  });
});
