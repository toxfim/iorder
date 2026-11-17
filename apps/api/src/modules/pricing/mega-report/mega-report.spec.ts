import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../../../common/auth/actor.js';
import type { Clock } from '../../../common/clock/clock.js';
import { ForbiddenError } from '../../../common/errors/domain-errors.js';
import { Prisma } from '../../../generated/prisma/client.js';
import type { CatalogService, ProductView } from '../../catalog/index.js';
import type { PriceReferenceRepository } from '../price-reference.repository.js';
import type { MegaReportLine } from '../price-reference.types.js';
import {
  buildMegaReportWorkbook,
  MEGA_REPORT_TEXT,
  supplyPriceUsd,
  toReportProducts,
} from './mega-report-workbook.js';
import { MegaReportService } from './mega-report.service.js';

const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

function line(
  productId: string,
  deliveryRef: string,
  available: string,
  cost: { usd?: string; rate?: string; uzs?: string } = {},
): MegaReportLine {
  return {
    productId,
    deliveryRef,
    availableQuantity: d(available),
    costUsd: cost.usd === undefined ? null : d(cost.usd),
    usdRateUsed: cost.rate === undefined ? null : d(cost.rate),
    costUzs: cost.uzs === undefined ? null : d(cost.uzs),
  };
}

describe('supplyPriceUsd (owner rule, mega-report.md)', () => {
  it('takes «Цена закупа $» when the sheet has it, even an explicit 0', () => {
    expect(
      supplyPriceUsd({ costUsd: d('12.5'), usdRateUsed: d('12100'), costUzs: d('1') }),
    ).toEqual({ kind: 'USD', usd: d('12.5') });
    const zero = supplyPriceUsd({ costUsd: d('0'), usdRateUsed: d('12100'), costUzs: d('0') });
    expect(zero.kind === 'USD' && zero.usd.isZero()).toBe(true);
  });

  it("falls back to so'm / rate, rounded half up to 4 decimals", () => {
    const price = supplyPriceUsd({ costUsd: null, usdRateUsed: d('12100'), costUzs: d('1000000') });
    // 1 000 000 / 12 100 = 82.644628...
    expect(price.kind === 'USD' && price.usd.toFixed()).toBe('82.6446');
  });

  it("gives no price for a so'm line without a usable rate (variant 1: never guess)", () => {
    expect(supplyPriceUsd({ costUsd: null, usdRateUsed: null, costUzs: d('3810270') })).toEqual({
      kind: 'NO_RATE',
    });
    expect(supplyPriceUsd({ costUsd: null, usdRateUsed: d('0'), costUzs: d('100') })).toEqual({
      kind: 'NO_RATE',
    });
  });

  it('says "pending" when every cost cell is still empty', () => {
    expect(supplyPriceUsd({ costUsd: null, usdRateUsed: null, costUzs: null })).toEqual({
      kind: 'PENDING',
    });
  });
});

const products = new Map([
  ['p-b', { productCode: '40087', name: 'Redmi Note 14' }],
  ['p-a', { productCode: '9001', name: 'Mi Band 9' }],
]);

describe('toReportProducts', () => {
  it('makes one row per product code, keeps the delivery order and sorts codes by value', () => {
    const rows = toReportProducts(
      [
        line('p-b', '6201', '29', { usd: '100', rate: '12085', uzs: '1208500' }),
        line('p-b', '6223', '18', { uzs: '500000' }),
        line('p-a', '7265', '14'),
        line('p-unknown', '1', '1', { usd: '1', rate: '1', uzs: '1' }),
      ],
      products,
    );
    expect(rows.map((r) => r.productCode)).toEqual(['9001', '40087']);
    expect(rows[1]?.supplies.map((s) => [s.deliveryRef, s.price.kind])).toEqual([
      ['6201', 'USD'],
      ['6223', 'NO_RATE'],
    ]);
    expect(rows[0]?.supplies.map((s) => s.price.kind)).toEqual(['PENDING']);
  });
});

async function readBack(data: Uint8Array): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('no sheet');
  return sheet;
}

describe('buildMegaReportWorkbook', () => {
  it('writes a band of three columns per delivery, as many bands as the longest product', async () => {
    const rows = toReportProducts(
      [
        line('p-b', '6201', '29', { usd: '100.25', rate: '12085', uzs: '1211521.25' }),
        line('p-b', '6223', '18', { uzs: '500000' }),
        line('p-b', '6300', '2.5', { uzs: '1210000', rate: '12100' }),
        line('p-a', '7265', '14'),
      ],
      products,
    );
    const sheet = await readBack(await buildMegaReportWorkbook(rows));

    expect(sheet.name).toBe(MEGA_REPORT_TEXT.sheet);
    expect(sheet.getCell('A1').value).toBe('ID товара');
    expect(sheet.getCell('B1').value).toBe('Наименование товара');
    expect(sheet.getCell('C1').value).toBe('Поставка 1');
    expect(sheet.getCell('I1').value).toBe('Поставка 3');
    expect(sheet.getCell('L1').value).toBeNull();
    expect([2, 3, 4].map((c) => sheet.getRow(2).getCell(c).value)).toEqual([
      'Наименование товара',
      'ID заявки',
      'Доступное кол-во',
    ]);
    expect(sheet.getCell('E2').value).toBe('Цена закупа $');

    // Row 3: 9001 with one cost-pending delivery; row 4: 40087 with three.
    expect(sheet.getCell('A3').value).toBe('9001');
    expect(sheet.getCell('C3').value).toBe('7265');
    expect(sheet.getCell('D3').value).toBe(14);
    expect(sheet.getCell('E3').value).toBe('нет цены');
    expect(sheet.getCell('F3').value).toBeNull();

    expect(sheet.getCell('A4').value).toBe('40087');
    expect(sheet.getCell('B4').value).toBe('Redmi Note 14');
    expect(['C4', 'D4', 'E4'].map((a) => sheet.getCell(a).value)).toEqual(['6201', 29, 100.25]);
    expect(['F4', 'G4', 'H4'].map((a) => sheet.getCell(a).value)).toEqual([
      '6223',
      18,
      'нет курса',
    ]);
    expect(['I4', 'J4', 'K4'].map((a) => sheet.getCell(a).value)).toEqual(['6300', 2.5, 100]);
    expect(sheet.getCell('D4').numFmt).toBe('#,##0');
    expect(sheet.getCell('J4').numFmt).toBe('#,##0.###');
  });

  it('still writes the header for an empty report', async () => {
    const sheet = await readBack(await buildMegaReportWorkbook([]));
    expect(sheet.getCell('C1').value).toBe('Поставка 1');
    expect(sheet.getCell('A3').value).toBeNull();
  });
});

function product(id: string, code: string, name: string): ProductView {
  return {
    id,
    productCode: code,
    category: null,
    categoryId: null,
    trackingType: 'NONE',
    markingRequired: false,
    codeRuleConfigured: false,
    isActive: true,
    codeGenerated: false,
    mergedIntoProductId: null,
    brandId: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    translations: [{ lang: 'RU', name, description: null }],
  };
}

describe('MegaReportService', () => {
  const service = new MegaReportService(
    {
      findAllLiveForReport: () => Promise.resolve([line('p-a', '7265', '14', { usd: '5' })]),
    } as unknown as PriceReferenceRepository,
    {
      findProductsByIds: () => Promise.resolve([product('p-a', '9001', 'Mi Band 9')]),
    } as unknown as CatalogService,
    // 2026-11-10 09:05 UTC = 14:05 in Asia/Tashkent.
    { now: () => new Date('2026-11-10T09:05:00Z') } as Clock,
  );
  const staff = (roles: string[]): Actor =>
    ({ userId: 'u1', staffRoles: roles }) as unknown as Actor;

  it('names the file by the Tashkent moment and fills it', async () => {
    const file = await service.build(staff(['MANAGER']));
    expect(file.fileName).toBe('Mega_report_2026-11-10_14-05.xlsx');
    const sheet = await readBack(file.data);
    expect(sheet.getCell('A3').value).toBe('9001');
    expect(sheet.getCell('E3').value).toBe(5);
  });

  it('refuses a role without the cost permission (hard rule 7)', async () => {
    await expect(service.build(staff(['DRIVER']))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
