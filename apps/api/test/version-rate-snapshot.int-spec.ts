import { randomUUID } from 'node:crypto';
import {
  staffPriceListWithRateResponseSchema,
  staffVersionListWithRateResponseSchema,
  staffVersionWithRateResponseSchema,
} from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { PricingModule, UsdRateService } from '../src/modules/pricing/index.js';
import { PricingRepository } from '../src/modules/pricing/pricing.repository.js';
import { findForbiddenKeys } from './support/forbidden-fields.js';
import { resetCatalogPricingAudit } from './support/test-db.js';
import {
  ACCOUNTANT,
  createTestApp,
  MANAGER,
  SELLER,
  SHOP_OWNER,
  type TestApp,
} from './support/test-app.js';

interface Body {
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON access
}

describe('USD rate snapshot on published price list versions (real PostgreSQL)', () => {
  let t: TestApp;
  let rates: UsdRateService;
  let apple: string;

  beforeAll(async () => {
    t = await createTestApp([CatalogModule, PricingModule]);
    await t.prisma.$connect();
    rates = t.get(UsdRateService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    t.clock.set(new Date('2026-10-20T08:00:00Z'));
    t.usdRateProvider.returns('12044.72', '2026-10-20');
    await resetCatalogPricingAudit(t.prisma);
    apple = (await t.prisma.product.create({ data: { productCode: 'APPLE', unit: 'box' } })).id;
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

  async function publish(price = '10.00'): Promise<{ id: string; body: Body }> {
    const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
    await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
      items: [{ productId: apple, basePrice: price }],
    });
    const r = await call('POST', `/staff/price-list/drafts/${draft}/publish`);
    expect(r.status).toBe(200);
    return { id: draft, body: r.body };
  }
  const snapshotRow = (id: string) =>
    t.prisma.priceListVersionRate.findUnique({ where: { versionId: id } });

  it('no rate yet: publishing is NOT blocked, the snapshot is null and the DTO says so', async () => {
    const { id, body } = await publish();
    expect(staffVersionWithRateResponseSchema.parse(body)).toMatchObject({
      status: 'PUBLISHED',
      usdRateSnapshot: null,
    });
    await expect(snapshotRow(id)).resolves.toBeNull();
  });

  it("copies the channel's rate with its source and day", async () => {
    t.usdChannelProvider.returns({ rate: '11960', rateDate: '2026-10-20', postId: 557 });
    await rates.refreshFromChannel();
    const { id, body } = await publish();
    expect(staffVersionWithRateResponseSchema.parse(body).usdRateSnapshot).toEqual({
      rate: '11960.0000',
      source: 'CHANNEL',
      rateDate: '2026-10-20',
    });
    const row = await snapshotRow(id);
    expect(row?.source).toBe('CHANNEL');
    t.usdChannelProvider.returns();
  });

  it('copies a Central Bank rate (value, source, rate date) onto the published version', async () => {
    await rates.refreshFromCentralBank();
    const { id, body } = await publish();
    expect(staffVersionWithRateResponseSchema.parse(body).usdRateSnapshot).toEqual({
      rate: '12084.7200', // the bank's 12044.72 + 40 so'm: the rate in force, as customers are priced
      source: 'CBU',
      rateDate: '2026-10-20',
    });
    const row = await snapshotRow(id);
    expect(row?.usdRate.toFixed(4)).toBe('12084.7200');
    expect(row?.rateDate?.toISOString().slice(0, 10)).toBe('2026-10-20');
    // The history of the publish says which rate it used.
    const audit = await t.prisma.auditLog.findFirstOrThrow({
      where: { action: 'PRICE_LIST_PUBLISHED', entityId: id },
    });
    expect(audit.diff).toMatchObject({
      usdRate: { from: null, to: '12084.7200' },
      usdRateSource: { from: null, to: 'CBU' },
      usdRateDate: { from: null, to: '2026-10-20' },
    });
  });

  it('copies a manual rate (no rate date)', async () => {
    await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
    const { body } = await publish();
    expect(body.usdRateSnapshot).toEqual({ rate: '12650.5000', source: 'MANUAL', rateDate: null });
  });

  it('a later rate change never alters an already published (or archived) version', async () => {
    await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
    const first = await publish('10.00');
    await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12700' });
    await rates.refreshFromCentralBank(); // manual in force: skipped
    const draft = (
      await call('POST', '/staff/price-list/drafts', MANAGER, { copyFromCurrent: true })
    ).body.id as string;
    expect((await call('GET', '/staff/price-list/drafts/current')).body.usdRateSnapshot).toBeNull(); // not taken yet
    await call('POST', `/staff/price-list/drafts/${draft}/publish`);

    const detail = (id: string) => call('GET', `/staff/price-list/versions/${id}`);
    expect(
      staffPriceListWithRateResponseSchema.parse((await detail(first.id)).body).version,
    ).toMatchObject({
      status: 'ARCHIVED',
      usdRateSnapshot: { rate: '12650.5000', source: 'MANUAL' },
    });
    expect((await detail(draft)).body.version.usdRateSnapshot).toMatchObject({
      rate: '12700.0000',
    });

    const list = staffVersionListWithRateResponseSchema.parse(
      (await call('GET', '/staff/price-list/versions')).body,
    );
    expect(list.items.map((v) => v.usdRateSnapshot?.rate)).toEqual(['12700.0000', '12650.5000']);
  });

  it('the staff current list shows its snapshot to the accountant too; customers never get one', async () => {
    await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
    await publish();
    const staff = await call('GET', '/staff/price-list/current', ACCOUNTANT);
    expect(staff.body.version.usdRateSnapshot).toEqual({
      rate: '12650.5000',
      source: 'MANUAL',
      rateDate: null,
    });
    for (const actor of [SHOP_OWNER, SELLER]) {
      const r = await call('GET', '/price-list/current', actor);
      expect(r.status).toBe(200);
      expect(findForbiddenKeys(r.body)).toEqual([]);
      const text = JSON.stringify(r.body).toLowerCase();
      // The UZS prices are USD x rate (10.00 -> 126505.00), so only the rate as such is checked.
      for (const word of ['usd', 'snapshot', 'ratedate', '12650.5']) {
        expect(text).not.toContain(word);
      }
    }
  });

  it('reads snapshots of a whole version list in ONE query', async () => {
    await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
    await publish('10.00');
    await publish('11.00');
    await publish('12.00');
    const spy = vi.spyOn(t.get(PricingRepository), 'findRateSnapshots');
    const list = await call('GET', '/staff/price-list/versions');
    expect(list.body.items).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a corrupt rate setting stops the publish; nothing is half published', async () => {
    const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
    await call('PUT', `/staff/price-list/drafts/${draft}/items`, MANAGER, {
      items: [{ productId: apple, basePrice: '10.00' }],
    });
    await t.prisma.appSetting.create({
      data: { key: 'usd_rate', value: { rate: 'x' }, updatedAt: new Date() },
    });
    expect((await call('POST', `/staff/price-list/drafts/${draft}/publish`)).status).toBe(500);
    await expect(
      t.prisma.priceListVersion.findUniqueOrThrow({ where: { id: draft } }),
    ).resolves.toMatchObject({
      status: 'DRAFT',
    });
    await expect(t.prisma.priceListVersionRate.count()).resolves.toBe(0);
  });

  describe('immutability at the database level', () => {
    it('a published version snapshot cannot be updated, deleted or replaced', async () => {
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      const { id } = await publish();
      await expect(
        t.prisma
          .$executeRaw`UPDATE price_list_version_rates SET usd_rate = 1 WHERE version_id = ${id}::uuid`,
      ).rejects.toThrow(/cannot change: version is not a draft/);
      await expect(
        t.prisma.$executeRaw`DELETE FROM price_list_version_rates WHERE version_id = ${id}::uuid`,
      ).rejects.toThrow(/cannot change: version is not a draft/);
      await expect(
        t.prisma.$executeRaw`INSERT INTO price_list_version_rates (version_id, usd_rate, source)
          VALUES (${id}::uuid, 1, 'MANUAL')`,
      ).rejects.toThrow(); // already has one (and the version is not a draft)
      await expect(snapshotRow(id)).resolves.toMatchObject({ source: 'MANUAL' });
    });

    it('an ARCHIVED version keeps its snapshot immutable too', async () => {
      await call('PUT', '/staff/usd-rate', MANAGER, { rate: '12650.5' });
      const first = await publish('10.00');
      await publish('11.00'); // archives the first
      await expect(
        t.prisma
          .$executeRaw`UPDATE price_list_version_rates SET usd_rate = 1 WHERE version_id = ${first.id}::uuid`,
      ).rejects.toThrow(/cannot change/);
    });

    it('a snapshot cannot be added to a version that is already published', async () => {
      const { id } = await publish(); // published without a rate
      await expect(
        t.prisma.$executeRaw`INSERT INTO price_list_version_rates (version_id, usd_rate, source)
          VALUES (${id}::uuid, 12000, 'MANUAL')`,
      ).rejects.toThrow(/cannot change: version is not a draft/);
    });

    it('a DRAFT may carry one, and discarding the draft removes it with the version', async () => {
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      await expect(
        t.prisma.$executeRaw`INSERT INTO price_list_version_rates (version_id, usd_rate, source)
          VALUES (${draft}::uuid, 12000, 'MANUAL')`,
      ).resolves.toBe(1);
      expect((await call('DELETE', `/staff/price-list/drafts/${draft}`)).status).toBe(204);
      await expect(t.prisma.priceListVersionRate.count()).resolves.toBe(0);
    });

    it('rejects a snapshot for a missing version, and rows that break the CHECKs', async () => {
      const draft = (await call('POST', '/staff/price-list/drafts', MANAGER, {})).body.id as string;
      await expect(
        t.prisma.$executeRaw`INSERT INTO price_list_version_rates (version_id, usd_rate, source)
          VALUES (${randomUUID()}::uuid, 1, 'MANUAL')`,
      ).rejects.toThrow(/does not exist/);
      const bad = (usdRate: string, source: string, date: string | null) =>
        t.prisma.$executeRawUnsafe(
          `INSERT INTO price_list_version_rates (version_id, usd_rate, source, rate_date)
           VALUES ('${draft}', ${usdRate}, '${source}', ${date === null ? 'NULL' : `'${date}'`})`,
        );
      await expect(bad('0', 'MANUAL', null)).rejects.toThrow(/rate_positive/);
      await expect(bad('1', 'ECB', '2026-10-20')).rejects.toThrow(/source_known/);
      await expect(bad('1', 'CHANNEL', null)).rejects.toThrow(/date_matches_source/);
      await expect(bad('1', 'CBU', null)).rejects.toThrow(/date_matches_source/);
      await expect(bad('1', 'MANUAL', '2026-10-20')).rejects.toThrow(/date_matches_source/);
      await expect(bad('11960', 'CHANNEL', '2026-10-20')).resolves.toBe(1);
    });

    it('cannot be truncated', async () => {
      await expect(t.prisma.$executeRawUnsafe('TRUNCATE price_list_version_rates')).rejects.toThrow(
        /not allowed/,
      );
    });
  });
});
