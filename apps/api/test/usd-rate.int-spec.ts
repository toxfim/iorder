import { usdRateResponseSchema } from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/modules/audit/index.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { PricingModule, RateRefreshService, UsdRateService } from '../src/modules/pricing/index.js';
import { REFRESH_RETRY_AFTER_MS } from '../src/modules/pricing/usd-rate/rate-refresh.service.js';
import { UsdRateRepository } from '../src/modules/pricing/usd-rate/usd-rate.repository.js';
import { resetCatalogPricingAudit } from './support/test-db.js';
import {
  ACCOUNTANT,
  ADMIN,
  createTestApp,
  DRIVER,
  MANAGER,
  SELLER,
  SHOP_OWNER,
  WAREHOUSE,
  type TestApp,
} from './support/test-app.js';

interface Body {
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON access
}

describe('USD rate: channel, then manual for 24 hours, then the bank + 40 (real PostgreSQL, fakes)', () => {
  let t: TestApp;
  let rates: UsdRateService;
  let refresher: RateRefreshService;

  beforeAll(async () => {
    t = await createTestApp([CatalogModule, PricingModule]);
    await t.prisma.$connect();
    rates = t.get(UsdRateService);
    refresher = t.get(RateRefreshService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    t.clock.set(new Date('2026-10-20T08:00:00Z'));
    t.usdRateProvider.returns('12044.72', '2026-10-20');
    t.usdRateProvider.calls = 0;
    await resetCatalogPricingAudit(t.prisma);
  });

  const call = async (
    method: string,
    path: string,
    actor = MANAGER,
    body?: unknown,
  ): Promise<{ status: number; body: Body }> => {
    const r = await t.request(method, path, { actor, body });
    return { status: r.status, body: (r.body ?? {}) as Body };
  };
  const current = async (): Promise<Body> => (await call('GET', '/staff/usd-rate')).body;
  const auditOf = (action: string) =>
    t.prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

  it('never touches the bank by itself: boot, reads and manual writes make no call', async () => {
    await current();
    await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
    await current();
    expect(t.usdRateProvider.calls).toBe(0);
  });

  describe('refresh from the Central Bank', () => {
    it('sets the first rate as CBU with its date, and audits it as a system action', async () => {
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({ outcome: 'UPDATED' });
      expect(usdRateResponseSchema.parse(await current())).toEqual({
        rate: '12084.7200',
        updatedAt: '2026-10-20T08:00:00.000Z',
        updatedBy: null,
        updatedByUserId: null,
        source: 'CBU',
        rateDate: '2026-10-20',
        followsCentralBank: true,
        manualRate: null,
        manualExpiresAt: null,
        lastRefreshFailedAt: null,
        lastChannelFailedAt: null,
      });
      const [row] = await auditOf('RATE_REFRESH_UPDATED');
      expect(row?.actorUserId).toBeNull();
      expect(row?.diff).toEqual({
        rate: { from: null, to: '12084.7200' },
        source: { from: null, to: 'CBU' },
        rateDate: { from: null, to: '2026-10-20' },
        bankRate: { from: null, to: '12044.7200' },
        bankRateDate: { from: null, to: '2026-10-20' },
      });
    });

    it('a repeated identical quote changes and audits nothing; a new quote records before AND after', async () => {
      await rates.refreshFromCentralBank();
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({ outcome: 'UNCHANGED' });
      expect(await auditOf('RATE_REFRESH_UPDATED')).toHaveLength(1);

      t.clock.set(new Date('2026-10-21T08:00:00Z'));
      t.usdRateProvider.returns('12050.10', '2026-10-21');
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({ outcome: 'UPDATED' });
      const rows = await auditOf('RATE_REFRESH_UPDATED');
      expect(rows[1]?.diff).toEqual({
        rate: { from: '12084.7200', to: '12090.1000' },
        rateDate: { from: '2026-10-20', to: '2026-10-21' },
        bankRate: { from: '12044.7200', to: '12050.1000' },
        bankRateDate: { from: '2026-10-20', to: '2026-10-21' },
      });
    });

    it('keeps the bank up to date under a manual rate, which stays in force', async () => {
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({ outcome: 'UPDATED' });
      expect(await current()).toMatchObject({ rate: '12650.5000', source: 'MANUAL' });
      t.clock.set(new Date('2026-10-21T08:00:00Z')); // exactly 24 hours later
      expect(await current()).toMatchObject({
        rate: '12084.7200',
        source: 'CBU',
        manualRate: null,
      });
    });

    it('a manual rate set WHILE the bank answers wins (no lost write)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(t.usdRateProvider, 'fetchUsdRate').mockImplementation(async () => {
        await gate;
        return { rate: '12044.72', rateDate: '2026-10-20', source: 'CBU' };
      });
      const pending = rates.refreshFromCentralBank();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      release();
      await expect(pending).resolves.toEqual({ outcome: 'UPDATED' });
      expect(await current()).toMatchObject({ rate: '12650.5000', source: 'MANUAL' });
    });

    it('a failed audit insert rolls the refresh back', async () => {
      vi.spyOn(t.get(AuditService), 'recordSystem').mockRejectedValue(new Error('audit down'));
      await expect(rates.refreshFromCentralBank()).rejects.toThrow('audit down');
      await expect(
        t.prisma.appSetting.findUnique({ where: { key: 'usd_rate' } }),
      ).resolves.toBeNull();
    });
  });

  describe('bank unreachable: a typed result, the last value stays, staff can be warned', () => {
    it('with no rate yet: FAILED, the rate stays unset, the flag is set', async () => {
      t.usdRateProvider.failsWith('UNREACHABLE');
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({
        outcome: 'FAILED',
        failure: 'UNREACHABLE',
      });
      const body = await current();
      expect(body).toMatchObject({ rate: null, followsCentralBank: true, manualRate: null });
      expect(body.lastRefreshFailedAt).toBe('2026-10-20T08:00:00.000Z');
      expect(JSON.stringify(body)).not.toMatch(/UNREACHABLE|error|message/i); // a flag, not a log
    });

    it('with a CBU rate: the old value stays; a later success clears the flag', async () => {
      await rates.refreshFromCentralBank();
      t.clock.set(new Date('2026-10-21T08:00:00Z'));
      t.usdRateProvider.failsWith('TIMEOUT');
      await expect(rates.refreshFromCentralBank()).resolves.toMatchObject({
        outcome: 'FAILED',
        failure: 'TIMEOUT',
      });
      expect(await current()).toMatchObject({
        rate: '12084.7200',
        lastRefreshFailedAt: '2026-10-21T08:00:00.000Z',
      });
      t.usdRateProvider.returns('12060.00', '2026-10-21');
      await rates.refreshFromCentralBank();
      expect(await current()).toMatchObject({ rate: '12100.0000', lastRefreshFailedAt: null });
    });

    it('the failure is not an exception for the caller, whatever the kind', async () => {
      for (const kind of ['UNREACHABLE', 'TIMEOUT', 'HTTP_STATUS', 'BAD_RESPONSE'] as const) {
        t.usdRateProvider.failsWith(kind);
        await expect(rates.refreshFromCentralBank()).resolves.toEqual({
          outcome: 'FAILED',
          failure: kind,
        });
      }
    });
  });

  describe('manual rate for 24 hours; it can be ended early', () => {
    it('a manual rate over a CBU rate is audited as a source change, with its end', async () => {
      await rates.refreshFromCentralBank();
      await call('PUT', '/staff/usd-rate', ADMIN, { rate: '12044.72' }); // same number, now manual
      const [row] = await auditOf('USD_RATE_CHANGED');
      expect(row).toMatchObject({ actorUserId: ADMIN.userId });
      expect(row?.diff).toEqual({
        rate: { from: '12084.7200', to: '12044.7200' },
        source: { from: 'CBU', to: 'MANUAL' },
        rateDate: { from: '2026-10-20', to: null },
        manualRate: { from: null, to: '12044.7200' },
        manualSetBy: { from: null, to: ADMIN.userId },
        manualExpiresAt: { from: null, to: '2026-10-21T08:00:00.000Z' },
      });
      expect(await current()).toMatchObject({
        source: 'MANUAL',
        rateDate: null,
        updatedBy: null,
        manualRate: '12044.7200',
        manualExpiresAt: '2026-10-21T08:00:00.000Z',
      });
    });

    it('entering the same rate again starts a new 24 hours and is recorded', async () => {
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      t.clock.set(new Date('2026-10-20T20:00:00Z'));
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      expect(await current()).toMatchObject({ manualExpiresAt: '2026-10-21T20:00:00.000Z' });
      expect(await auditOf('USD_RATE_CHANGED')).toHaveLength(2);
    });

    it('follow-central-bank: ends the manual rate, refreshes once, audited with the actor', async () => {
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      t.clock.set(new Date('2026-10-21T02:00:00Z'));
      t.usdRateProvider.returns('12044.72', '2026-10-21');
      const r = await call('POST', '/staff/usd-rate/follow-central-bank', MANAGER);
      expect(r.status).toBe(200);
      expect(usdRateResponseSchema.parse(r.body)).toMatchObject({
        rate: '12084.7200',
        source: 'CBU',
        rateDate: '2026-10-21',
        followsCentralBank: true,
        updatedBy: null,
      });
      expect(t.usdRateProvider.calls).toBe(1);
      const [follow] = await auditOf('USD_RATE_FOLLOW_CENTRAL_BANK');
      expect(follow).toMatchObject({ actorUserId: MANAGER.userId });
      expect(follow?.diff).toEqual({
        manualExpiresAt: { from: '2026-10-21T08:00:00.000Z', to: '2026-10-21T02:00:00.000Z' },
      });
      expect(await auditOf('RATE_REFRESH_UPDATED')).toHaveLength(1);
    });

    it('follow with the bank down: the manual value stays, follow is recorded, a later refresh may replace it', async () => {
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      t.usdRateProvider.failsWith('UNREACHABLE');
      const r = await call('POST', '/staff/usd-rate/follow-central-bank', ADMIN);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        rate: '12650.5000',
        source: 'MANUAL',
        followsCentralBank: true,
        lastRefreshFailedAt: '2026-10-20T08:00:00.000Z',
      });
      t.usdRateProvider.returns('12044.72', '2026-10-20');
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({ outcome: 'UPDATED' });
      expect(await current()).toMatchObject({
        source: 'CBU',
        rate: '12084.7200',
        lastRefreshFailedAt: null,
      });
    });

    it('follow when nothing is set just refreshes; following twice is a no-op in the history', async () => {
      await call('POST', '/staff/usd-rate/follow-central-bank', MANAGER);
      await call('POST', '/staff/usd-rate/follow-central-bank', MANAGER);
      expect(await auditOf('USD_RATE_FOLLOW_CENTRAL_BANK')).toHaveLength(0);
      expect(await auditOf('RATE_REFRESH_UPDATED')).toHaveLength(1); // second refresh: unchanged
    });

    it('permissions: manager and admin may follow; accountant, warehouse, driver, customers may not', async () => {
      const url = '/staff/usd-rate/follow-central-bank';
      expect((await t.request('POST', url)).status).toBe(401);
      for (const actor of [ACCOUNTANT, WAREHOUSE, DRIVER, SHOP_OWNER, SELLER]) {
        expect((await call('POST', url, actor)).status, actor.userId).toBe(403);
      }
      expect(t.usdRateProvider.calls).toBe(0);
      for (const actor of [MANAGER, ADMIN]) {
        expect((await call('POST', url, actor)).status, actor.userId).toBe(200);
      }
    });

    it('the accountant can view the rate (with its source) but not change it', async () => {
      await rates.refreshFromCentralBank();
      const r = await call('GET', '/staff/usd-rate', ACCOUNTANT);
      expect(r.status).toBe(200);
      expect(r.body.source).toBe('CBU');
      expect((await call('PUT', '/staff/usd-rate', ACCOUNTANT, { rate: '1' })).status).toBe(403);
    });
  });

  describe('refreshIfDue (for a scheduler that does not exist yet)', () => {
    it('refreshes at most once per Tashkent calendar day', async () => {
      const first = new Date('2026-10-20T08:00:00Z'); // 13:00 Tashkent
      await expect(refresher.refreshIfDue(first)).resolves.toEqual({
        due: true,
        outcome: 'UPDATED',
      });
      await expect(refresher.refreshIfDue(new Date('2026-10-20T18:59:00Z'))).resolves.toEqual({
        due: false,
        reason: 'ALREADY_REFRESHED_TODAY',
      });
      expect(t.usdRateProvider.calls).toBe(1);
      // 19:30 UTC is 00:30 on the NEXT Tashkent day: due again.
      t.clock.set(new Date('2026-10-20T19:30:00Z'));
      t.usdRateProvider.returns('12050.00', '2026-10-21');
      await expect(refresher.refreshIfDue(new Date('2026-10-20T19:30:00Z'))).resolves.toEqual({
        due: true,
        outcome: 'UPDATED',
      });
    });

    it('is still due under a manual rate: the bank is what the rate falls back to', async () => {
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      await expect(refresher.refreshIfDue(t.clock.now())).resolves.toEqual({
        due: true,
        outcome: 'UPDATED',
      });
      expect(t.usdRateProvider.calls).toBe(1);
    });

    it('after a failure waits before trying again (no retry storm), then retries', async () => {
      t.usdRateProvider.failsWith('UNREACHABLE');
      const t0 = new Date('2026-10-20T08:00:00Z');
      await expect(refresher.refreshIfDue(t0)).resolves.toMatchObject({
        due: true,
        outcome: 'FAILED',
      });
      const soon = new Date(t0.getTime() + REFRESH_RETRY_AFTER_MS - 1000);
      await expect(refresher.refreshIfDue(soon)).resolves.toEqual({
        due: false,
        reason: 'RETRY_LATER',
      });
      expect(t.usdRateProvider.calls).toBe(1);

      t.usdRateProvider.returns('12044.72', '2026-10-20');
      const later = new Date(t0.getTime() + REFRESH_RETRY_AFTER_MS + 1000);
      t.clock.set(later);
      await expect(refresher.refreshIfDue(later)).resolves.toEqual({
        due: true,
        outcome: 'UPDATED',
      });
      expect(t.usdRateProvider.calls).toBe(2);
    });
  });

  describe('a corrupt stored rate waits for a manager', () => {
    const corruptValue = { rate: '1.0000', source: 'BLACK_MARKET', followsCentralBank: true };
    const storeCorrupt = (): Promise<unknown> =>
      t.prisma.appSetting.create({
        data: { key: 'usd_rate', value: corruptValue, updatedAt: new Date() },
      });

    it('refreshFromCentralBank reports CORRUPT_STORED_RATE and neither asks the bank nor writes', async () => {
      await storeCorrupt();
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({
        outcome: 'CORRUPT_STORED_RATE',
      });
      expect(t.usdRateProvider.calls).toBe(0);
      const row = await t.prisma.appSetting.findUniqueOrThrow({ where: { key: 'usd_rate' } });
      expect(row.value).toEqual(corruptValue);
      expect(await auditOf('RATE_REFRESH_UPDATED')).toHaveLength(0);
    });

    it('refreshIfDue is not due and says why; a manager PUT repairs it, then refreshing works', async () => {
      await storeCorrupt();
      await expect(refresher.refreshIfDue(t.clock.now())).resolves.toEqual({
        due: false,
        reason: 'CORRUPT_STORED_RATE',
      });
      expect(t.usdRateProvider.calls).toBe(0);
      expect((await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' })).status).toBe(200);
      await call('POST', '/staff/usd-rate/follow-central-bank');
      expect(await current()).toMatchObject({ source: 'CBU', rate: '12084.7200' });
    });

    it('a database outage is an error, not "no rate"', async () => {
      vi.spyOn(t.get(UsdRateRepository), 'readState').mockRejectedValue(new Error('db down'));
      await expect(refresher.refreshIfDue(t.clock.now())).rejects.toThrow('db down');
      await expect(rates.refreshFromCentralBank()).rejects.toThrow('db down');
      expect(t.usdRateProvider.calls).toBe(0);
    });
  });

  describe("the channel's daily post", () => {
    const post = (rate: string, rateDate = '2026-10-20', postId = 557) => ({
      rate,
      rateDate,
      postId,
    });
    const statusRow = () => t.prisma.appSetting.findUnique({ where: { key: 'usd_rate_refresh' } });

    beforeEach(() => {
      t.usdChannelProvider.returns();
      t.usdChannelProvider.calls = 0;
    });

    it('is above the manual rate and the bank, for its own Tashkent day only', async () => {
      await rates.refreshFromCentralBank();
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      t.usdChannelProvider.returns(post('11960'));
      await expect(rates.refreshFromChannel()).resolves.toEqual({ outcome: 'UPDATED' });
      expect(await current()).toMatchObject({
        rate: '11960.0000',
        source: 'CHANNEL',
        rateDate: '2026-10-20',
        updatedBy: null,
        // The manual rate is kept and shown as outranked, not lost.
        manualRate: '12650.5000',
        followsCentralBank: false,
      });
      t.clock.set(new Date('2026-10-20T19:00:00Z')); // midnight in Tashkent, manual still in force
      expect(await current()).toMatchObject({ rate: '12650.5000', source: 'MANUAL' });
      t.clock.set(new Date('2026-10-21T08:00:00Z')); // the manual rate ended too
      expect(await current()).toMatchObject({ rate: '12084.7200', source: 'CBU' });
    });

    it('a manual rate saved over a channel rate is recorded but does not change the rate', async () => {
      await rates.refreshFromCentralBank();
      t.usdChannelProvider.returns(post('11960'));
      await rates.refreshFromChannel();
      const r = await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      expect(r.body).toMatchObject({ rate: '11960.0000', source: 'CHANNEL' });
      const [row] = await auditOf('USD_RATE_CHANGED');
      expect(row?.diff).toEqual({
        manualRate: { from: null, to: '12650.5000' },
        manualSetBy: { from: null, to: MANAGER.userId },
        manualExpiresAt: { from: null, to: '2026-10-21T08:00:00.000Z' },
      });
    });

    it('is audited as a system action with the post, and a repeat changes nothing', async () => {
      t.usdChannelProvider.returns(post('11960'));
      await rates.refreshFromChannel();
      await expect(rates.refreshFromChannel()).resolves.toEqual({ outcome: 'UNCHANGED' });
      const rows = await auditOf('RATE_REFRESH_UPDATED');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actorUserId).toBeNull();
      expect(rows[0]?.diff).toEqual({
        rate: { from: null, to: '11960.0000' },
        source: { from: null, to: 'CHANNEL' },
        rateDate: { from: null, to: '2026-10-20' },
        channelRate: { from: null, to: '11960.0000' },
        channelRateDate: { from: null, to: '2026-10-20' },
        channelPostId: { from: null, to: 557 },
      });
    });

    it('takes the latest post naming today: an old post or a post for another day is not today', async () => {
      await rates.refreshFromCentralBank();
      t.usdChannelProvider.returns(
        post('11880', '2026-10-19', 555),
        post('11950', '2026-10-20', 556),
        post('11960', '2026-10-20', 557),
        post('11990', '2026-10-21', 558),
      );
      await rates.refreshFromChannel();
      expect(await current()).toMatchObject({ rate: '11960.0000', source: 'CHANNEL' });
    });

    it('no post today is a normal day: the fallback rate, and no warning', async () => {
      await rates.refreshFromCentralBank();
      t.usdChannelProvider.returns(post('11960', '2026-10-19'));
      await expect(rates.refreshFromChannel()).resolves.toEqual({ outcome: 'NO_POST_TODAY' });
      expect(await current()).toMatchObject({
        rate: '12084.7200',
        source: 'CBU',
        lastChannelFailedAt: null,
      });
    });

    it('a read failure warns, keeps the rate, and a good read clears the warning', async () => {
      await rates.refreshFromCentralBank();
      t.usdChannelProvider.failsWith('BAD_RESPONSE');
      await expect(rates.refreshFromChannel()).resolves.toEqual({
        outcome: 'FAILED',
        failure: 'BAD_RESPONSE',
      });
      expect(await current()).toMatchObject({
        source: 'CBU',
        lastChannelFailedAt: '2026-10-20T08:00:00.000Z',
        lastRefreshFailedAt: null,
      });
      t.usdChannelProvider.returns(post('11960'));
      await rates.refreshFromChannel();
      expect(await current()).toMatchObject({ source: 'CHANNEL', lastChannelFailedAt: null });
    });

    it.each(['4999', '30001', '19960'])(
      'refuses %s (outside the band or far from the bank): not stored, staff are warned',
      async (rate) => {
        await rates.refreshFromCentralBank();
        t.usdChannelProvider.returns(post(rate));
        await expect(rates.refreshFromChannel()).resolves.toMatchObject({ outcome: 'FAILED' });
        expect(await current()).toMatchObject({
          source: 'CBU',
          lastChannelFailedAt: '2026-10-20T08:00:00.000Z',
        });
        expect(await auditOf('RATE_REFRESH_UPDATED')).toHaveLength(1); // the bank's only
      },
    );

    it('a channel rate within 5% of the bank is applied, on either side', async () => {
      await rates.refreshFromCentralBank();
      for (const rate of ['11500', '12600']) {
        t.usdChannelProvider.returns(post(rate));
        await expect(rates.refreshFromChannel()).resolves.toEqual({ outcome: 'UPDATED' });
      }
    });

    it('a corrupt stored rate is neither read over nor replaced', async () => {
      const value = { rate: '1.0000', source: 'BLACK_MARKET', followsCentralBank: true };
      await t.prisma.appSetting.create({
        data: { key: 'usd_rate', value, updatedAt: new Date() },
      });
      await expect(rates.refreshFromChannel()).resolves.toEqual({
        outcome: 'CORRUPT_STORED_RATE',
      });
      expect(t.usdChannelProvider.calls).toBe(0);
      await expect(statusRow()).resolves.toBeNull();
    });

    it('a failed audit insert rolls the channel rate back', async () => {
      t.usdChannelProvider.returns(post('11960'));
      vi.spyOn(t.get(AuditService), 'recordSystem').mockRejectedValue(new Error('audit down'));
      await expect(rates.refreshFromChannel()).rejects.toThrow('audit down');
      await expect(
        t.prisma.appSetting.findUnique({ where: { key: 'usd_rate' } }),
      ).resolves.toBeNull();
    });

    it("a bank refresh never loses the channel's rate, nor the channel the bank's warning", async () => {
      t.usdRateProvider.failsWith('TIMEOUT');
      await rates.refreshFromCentralBank();
      t.usdChannelProvider.returns(post('11960'));
      await rates.refreshFromChannel();
      expect(await current()).toMatchObject({
        source: 'CHANNEL',
        lastRefreshFailedAt: '2026-10-20T08:00:00.000Z',
      });
      t.usdRateProvider.returns('12044.72', '2026-10-20');
      await rates.refreshFromCentralBank();
      expect(await current()).toMatchObject({ source: 'CHANNEL', lastRefreshFailedAt: null });
    });
  });

  describe('bank quote plausibility and freshness', () => {
    it.each(['4999.99', '30000.01', '0.0001', '12044720'])(
      'rejects an implausible rate %s: FAILED, never stored, retried after the pause',
      async (rate) => {
        t.usdRateProvider.returns(rate, '2026-10-20');
        await expect(rates.refreshFromCentralBank()).resolves.toEqual({
          outcome: 'FAILED',
          failure: 'IMPLAUSIBLE_RATE',
        });
        expect(await current()).toMatchObject({
          rate: null,
          lastRefreshFailedAt: '2026-10-20T08:00:00.000Z',
        });
        await expect(refresher.refreshIfDue(t.clock.now())).resolves.toEqual({
          due: false,
          reason: 'RETRY_LATER',
        });
      },
    );

    it('accepts the band edges', async () => {
      t.usdRateProvider.returns('5000', '2026-10-20');
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({ outcome: 'UPDATED' });
      t.usdRateProvider.returns('30000', '2026-10-20');
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({ outcome: 'UPDATED' });
    });

    it('an implausible quote keeps the previous value', async () => {
      await rates.refreshFromCentralBank();
      t.clock.set(new Date('2026-10-21T08:00:00Z'));
      t.usdRateProvider.returns('120.44', '2026-10-21');
      await expect(rates.refreshFromCentralBank()).resolves.toMatchObject({ outcome: 'FAILED' });
      expect(await current()).toMatchObject({ rate: '12084.7200', rateDate: '2026-10-20' });
    });

    it('a bank date older than today is not a refresh: value kept, day not counted, retry later', async () => {
      await rates.refreshFromCentralBank(); // 2026-10-20
      t.clock.set(new Date('2026-10-21T08:00:00Z'));
      t.usdRateProvider.returns('12999.00', '2026-10-20'); // the bank still serves yesterday
      await expect(refresher.refreshIfDue(t.clock.now())).resolves.toEqual({
        due: true,
        outcome: 'STALE_BANK_DATE',
      });
      expect(await current()).toMatchObject({
        rate: '12084.7200',
        lastRefreshFailedAt: '2026-10-21T08:00:00.000Z',
      });
      // Not "refreshed today": after the pause it asks again, and the value is kept while stale.
      await expect(refresher.refreshIfDue(t.clock.now())).resolves.toEqual({
        due: false,
        reason: 'RETRY_LATER',
      });
      t.clock.set(new Date(t.clock.now().getTime() + REFRESH_RETRY_AFTER_MS + 1000));
      await expect(refresher.refreshIfDue(t.clock.now())).resolves.toEqual({
        due: true,
        outcome: 'STALE_BANK_DATE',
      });
      expect(await current()).toMatchObject({ rate: '12084.7200' });
      // Once the bank publishes today's rate it is taken and the day is counted.
      t.usdRateProvider.returns('12100.00', '2026-10-21');
      t.clock.set(new Date(t.clock.now().getTime() + REFRESH_RETRY_AFTER_MS + 1000));
      await expect(refresher.refreshIfDue(t.clock.now())).resolves.toEqual({
        due: true,
        outcome: 'UPDATED',
      });
      await expect(refresher.refreshIfDue(t.clock.now())).resolves.toEqual({
        due: false,
        reason: 'ALREADY_REFRESHED_TODAY',
      });
    });

    it('a quote dated for the coming day is accepted', async () => {
      t.usdRateProvider.returns('12044.72', '2026-10-21');
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({ outcome: 'UPDATED' });
    });

    it('the successful day is the Tashkent day when the answer is processed, not when asked', async () => {
      // Asked at 23:59:50 Tashkent on 20 Oct (18:59:50Z); the bank answers after midnight.
      t.clock.set(new Date('2026-10-20T18:59:50Z'));
      t.usdRateProvider.returns('12044.72', '2026-10-21');
      vi.spyOn(t.usdRateProvider, 'fetchUsdRate').mockImplementation(() => {
        t.clock.set(new Date('2026-10-20T19:00:10Z')); // 00:00:10 on 21 Oct, Tashkent
        return Promise.resolve({ rate: '12044.72', rateDate: '2026-10-21', source: 'CBU' });
      });
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({ outcome: 'UPDATED' });
      const status = await t.prisma.appSetting.findUniqueOrThrow({
        where: { key: 'usd_rate_refresh' },
      });
      expect(status.value).toMatchObject({ lastSuccessDay: '2026-10-21' });
    });

    it('a quote that was today at the start but is yesterday at processing is stale', async () => {
      t.clock.set(new Date('2026-10-20T18:59:50Z'));
      vi.spyOn(t.usdRateProvider, 'fetchUsdRate').mockImplementation(() => {
        t.clock.set(new Date('2026-10-20T19:00:10Z'));
        return Promise.resolve({ rate: '12044.72', rateDate: '2026-10-20', source: 'CBU' });
      });
      await expect(rates.refreshFromCentralBank()).resolves.toEqual({
        outcome: 'STALE_BANK_DATE',
      });
      expect(await current()).toMatchObject({ rate: null });
    });
  });

  describe('stored state', () => {
    it('reads the first-version shape ({rate, updatedBy}) as a manual rate with 24 hours from its write', async () => {
      await t.prisma.appSetting.create({
        data: {
          key: 'usd_rate',
          value: { rate: '12650.5000', updatedBy: 'user-old' },
          updatedAt: t.clock.now(),
        },
      });
      expect(await current()).toMatchObject({
        rate: '12650.5000',
        source: 'MANUAL',
        updatedBy: null,
        followsCentralBank: false,
        manualExpiresAt: '2026-10-21T08:00:00.000Z',
      });
    });

    it('reads the single-value shape: a bank value takes the markup, a manual one gets its 24 hours', async () => {
      const store = (value: object): Promise<unknown> =>
        t.prisma.appSetting.upsert({
          where: { key: 'usd_rate' },
          create: { key: 'usd_rate', value, updatedAt: t.clock.now() },
          update: { value, updatedAt: t.clock.now() },
        });
      await store({
        rate: '12044.7200',
        source: 'CBU',
        rateDate: '2026-10-20',
        setBy: null,
        followsCentralBank: true,
      });
      expect(await current()).toMatchObject({ rate: '12084.7200', source: 'CBU' });

      await store({
        rate: '12650.5000',
        source: 'MANUAL',
        rateDate: null,
        setBy: 'user-old',
        followsCentralBank: false,
      });
      expect(await current()).toMatchObject({
        rate: '12650.5000',
        source: 'MANUAL',
        manualExpiresAt: '2026-10-21T08:00:00.000Z',
      });

      // "Follow" recorded while the bank was down: the old value stays only until a bank rate exists.
      await store({
        rate: '12650.5000',
        source: 'MANUAL',
        rateDate: null,
        setBy: 'user-old',
        followsCentralBank: true,
      });
      expect(await current()).toMatchObject({ source: 'MANUAL', followsCentralBank: true });
      await rates.refreshFromCentralBank();
      expect(await current()).toMatchObject({ rate: '12084.7200', source: 'CBU' });
    });

    it.each([
      [
        'source and fields disagree (CBU with a setter)',
        {
          rate: '1.0000',
          source: 'CBU',
          rateDate: '2026-10-20',
          setBy: 'u',
          followsCentralBank: true,
        },
      ],
      [
        'MANUAL without a setter',
        {
          rate: '1.0000',
          source: 'MANUAL',
          rateDate: null,
          setBy: null,
          followsCentralBank: false,
        },
      ],
      [
        'an unknown source',
        {
          rate: '1.0000',
          source: 'BLACK_MARKET',
          rateDate: null,
          setBy: 'u',
          followsCentralBank: false,
        },
      ],
      [
        'a bad date',
        {
          rate: '1.0000',
          source: 'CBU',
          rateDate: '20.10.2026',
          setBy: null,
          followsCentralBank: true,
        },
      ],
    ])('rejects a corrupt new-shape value: %s', async (_name, value) => {
      await t.prisma.appSetting.create({ data: { key: 'usd_rate', value, updatedAt: new Date() } });
      expect((await call('GET', '/staff/usd-rate')).status).toBe(500);
    });
  });
});
