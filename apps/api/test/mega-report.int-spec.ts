import ExcelJS from 'exceljs';
import { COST_ROUTES } from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { CatalogModule } from '../src/modules/catalog/index.js';
import { PriceReferenceService, PricingModule } from '../src/modules/pricing/index.js';
import { resetCatalogPricingAudit, resetIdentity, resetOrders } from './support/test-db.js';
import {
  ACCOUNTANT,
  ACTOR_HEADER,
  ADMIN,
  createTestApp,
  DRIVER,
  MANAGER,
  SELLER,
  SHOP_OWNER,
  STAFF_VIEWER,
  WAREHOUSE,
  type TestApp,
} from './support/test-app.js';

const D = (value: string): Prisma.Decimal => new Prisma.Decimal(value);
const PURCHASING: Actor = { userId: 'user-purchasing', staffRoles: ['PURCHASING_MANAGER'] };

describe('GET /staff/stock/mega-report (real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([CatalogModule, PricingModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    // 09:05 UTC = 14:05 in Tashkent.
    t.clock.set(new Date('2026-11-10T09:05:00Z'));
    await resetOrders(t.prisma);
    await resetIdentity(t.prisma);
    await resetCatalogPricingAudit(t.prisma);
  });

  async function download(
    actor: Actor,
  ): Promise<{ status: number; data: Uint8Array; headers: Headers }> {
    const { port } = t.app.getHttpServer().address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}${COST_ROUTES.megaReport.path}`, {
      headers: { [ACTOR_HEADER]: JSON.stringify(actor) },
    });
    return {
      status: response.status,
      data: new Uint8Array(await response.arrayBuffer()),
      headers: response.headers,
    };
  }

  const product = async (code: string, ruName: string): Promise<string> =>
    (
      await t.prisma.product.create({
        data: {
          productCode: code,
          unit: 'dona',
          translations: { create: [{ lang: 'RU', name: ruName }] },
        },
      })
    ).id;

  const delivery = (
    productId: string,
    deliveryRef: string,
    day: string,
    available: string,
    cost: { usd: string; rate: string; uzs: string } | null,
  ) => ({
    productId,
    deliveryRef,
    supplier: 'secret supplier llc',
    purchaseMethod: '1 к 1',
    category: 'Смартфоны',
    deliveredQuantity: D('100'),
    availableQuantity: D(available),
    costUsd: cost === null ? null : D(cost.usd),
    usdRateUsed: cost === null ? null : D(cost.rate),
    costUzs: cost === null ? null : D(cost.uzs),
    deliveredAt: new Date(`${day}T05:00:00Z`),
  });

  it('one row per product, one band per delivery (oldest first), cost staff only', async () => {
    const redmi = await product('40087', 'Redmi Note 14 8/256');
    const band = await product('9001', 'Mi Band 9');
    await t.get(PriceReferenceService).upsertDeliveries([
      // Given out of order on purpose: the file sorts by delivery date.
      delivery(redmi, '6223', '2026-10-05', '18', {
        usd: '151.5',
        rate: '12085',
        uzs: '1830877.50',
      }),
      delivery(redmi, '6201', '2026-10-01', '29', { usd: '150', rate: '12100', uzs: '1815000' }),
      delivery(band, '7265', '2026-11-01', '14', null),
    ]);

    for (const actor of [MANAGER, ADMIN, ACCOUNTANT, PURCHASING]) {
      const r = await download(actor);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(r.headers.get('content-disposition')).toBe(
        'attachment; filename="Mega_report_2026-11-10_14-05.xlsx"',
      );
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from((await download(MANAGER)).data) as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('no sheet');
    const row = (n: number): unknown[] =>
      Array.from({ length: 8 }, (_, i) => sheet.getRow(n).getCell(i + 1).value);
    expect(row(1).slice(0, 6)).toEqual([
      'ID товара',
      'Наименование товара',
      'Поставка 1',
      'Поставка 1',
      'Поставка 1',
      'Поставка 2',
    ]);
    expect(row(3)).toEqual(['9001', 'Mi Band 9', '7265', 14, 'нет цены', null, null, null]);
    expect(row(4)).toEqual(['40087', 'Redmi Note 14 8/256', '6201', 29, 150, '6223', 18, 151.5]);
    expect(sheet.rowCount).toBe(4);

    // Only what the owner asked for: no supplier, rate, so'm cost or purchase method in the file.
    const text = JSON.stringify(sheet.getSheetValues());
    for (const secret of ['secret supplier', '12085', '1830877', '1 к 1', 'Смартфоны']) {
      expect(text).not.toContain(secret);
    }
  });

  it('refuses every role without the cost permission (hard rule 7)', async () => {
    for (const actor of [WAREHOUSE, DRIVER, SHOP_OWNER, SELLER, STAFF_VIEWER]) {
      expect((await download(actor)).status).toBe(403);
    }
  });

  it('an empty database still gives a file with the header', async () => {
    const r = await download(MANAGER);
    expect(r.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(r.data) as unknown as ArrayBuffer);
    expect(workbook.worksheets[0]?.getCell('A1').value).toBe('ID товара');
  });
});
