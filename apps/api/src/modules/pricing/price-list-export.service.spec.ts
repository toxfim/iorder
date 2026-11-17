import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../common/clock/clock.js';
import { NotFoundError } from '../../common/errors/domain-errors.js';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  BrandService,
  BrandView,
  CatalogService,
  ProductImagesService,
  ProductView,
} from '../catalog/index.js';
import { findBrand } from '../catalog/brand-finder.js';
import {
  formatRate,
  jpegSize,
  PriceListExportService,
  uniqueSheetName,
} from './price-list-export.service.js';
import type { SupplyAllocationService } from './supply-allocation/supply-allocation.service.js';
import type { PricingService } from './pricing.service.js';
import type { PriceListView } from './pricing.types.js';
import type { UsdRateService, UsdRateSnapshot } from './usd-rate/usd-rate.service.js';

function product(
  code: string,
  names: Record<string, string>,
  overrides: Partial<ProductView> = {},
): ProductView {
  return {
    id: `id-${code}`,
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
    translations: Object.entries(names).map(([lang, name]) => ({
      lang: lang as 'UZ' | 'RU' | 'EN',
      name,
      description: 'INTERNAL-DESCRIPTION',
    })),
    ...overrides,
  };
}

const priced = (p: ProductView, price: string, deferredPrice: string | null = null) => ({
  product: p,
  basePrice: new Prisma.Decimal(price),
  deferredPrice: deferredPrice === null ? null : new Prisma.Decimal(deferredPrice),
  // The file posted to the groups has no RRP column (not part of the 2026-11-09 request).
  rrp: null,
  wholesalePrice: null,
  wholesaleDeferredPrice: null,
  alifPrice: null,
  alifDeferredPrice: null,
  // The service hands the export the list in USD.
  currency: 'USD',
  uzs: null,
  usd: null,
});

const LIST: PriceListView = {
  version: {
    id: 'v-secret-id',
    number: 7,
    status: 'PUBLISHED',
    publishedAt: new Date('2026-10-20T19:30:00Z'),
    publishedBy: 'STAFF-USER-ID',
    note: 'INTERNAL-NOTE',
    source: 'MANUAL',
    createdAt: new Date('2026-10-19T08:00:00Z'),
  },
  items: [
    priced(
      product('R-2', { RU: 'Наушники REDMI Buds 8 Black' }, { category: 'Наушники' }),
      '250000',
      '245000',
    ),
    priced(product('R-1', { RU: 'Redmi Watch 5 Lite Black' }, { category: 'Часы' }), '480000.50'),
    priced(product('X-1', { RU: 'Xiaomi Robot Vacuum 6 EU' }, { category: 'Пылесосы' }), '3500000'),
    priced(product('U-1', { RU: 'FreeBuds 6i Black' }, { category: 'Наушники' }), '1000'),
    priced(product('C-3', { UZ: '=HYPERLINK("http://evil.example","x")' }), '1.00'),
    priced(product('A-1', { RU: 'Xiaomi Kettle' }, { category: 'Аксессуары' }), '90000'),
  ],
  usdRate: null,
  priceTier: null,
};

const BRANDS: BrandView[] = [
  { id: 'b-x', name: 'Xiaomi' },
  { id: 'b-r', name: 'Redmi' },
  { id: 'b-h', name: 'Huawei' },
];

interface Fakes {
  list: PriceListView | null;
  stock: Map<string, Prisma.Decimal>;
  /** Staff-chosen brand per product id. */
  chosen: Map<string, string>;
  rate: UsdRateSnapshot | null;
  now: Date;
  /** JPEG thumbnail per product id (the primary photo). */
  photos: Map<string, Buffer>;
}

const jpeg = (width: number, height: number, background = '#e04a1a'): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background } })
    .jpeg()
    .toBuffer();

function setup(overrides: Partial<Fakes> = {}) {
  const state: Fakes = {
    list: LIST,
    stock: new Map([
      ['id-R-2', new Prisma.Decimal('12.000')],
      ['id-X-1', new Prisma.Decimal('0')],
      ['id-A-1', new Prisma.Decimal('3.7')],
    ]),
    chosen: new Map(),
    rate: { rate: new Prisma.Decimal('11960.0000'), source: 'CBU', rateDate: '2026-10-21' },
    now: new Date('2026-10-21T09:00:00Z'),
    photos: new Map(),
    ...overrides,
  };
  const pricing = {
    getCurrentForExport: () =>
      state.list === null ? Promise.reject(new NotFoundError('none')) : Promise.resolve(state.list),
  } as unknown as PricingService;
  const catalog = {
    getStockQuantities: () => Promise.resolve(state.stock),
  } as unknown as CatalogService;
  const brands = {
    resolveBrands: (products: readonly ProductView[]) =>
      Promise.resolve(
        new Map(
          products.map((p) => {
            const chosen = BRANDS.find((b) => b.id === state.chosen.get(p.id));
            const name = p.translations[0]?.name ?? '';
            return [p.id, chosen ?? findBrand(name, BRANDS)];
          }),
        ),
      ),
  } as unknown as BrandService;
  const usdRate = { readSnapshot: () => Promise.resolve(state.rate) } as unknown as UsdRateService;
  const images = {
    primaryThumbnailsForExport: (ids: readonly string[]) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) => {
            const buffer = state.photos.get(id);
            return buffer ? [[id, { buffer, extension: 'jpeg' as const }] as const] : [];
          }),
        ),
      ),
  } as unknown as ProductImagesService;
  const clock = { now: () => state.now } as Clock;
  return {
    state,
    service: new PriceListExportService(pricing, catalog, brands, images, usdRate, clock, {
      availableFrom: (stock: Map<string, Prisma.Decimal>) => Promise.resolve(stock),
    } as unknown as SupplyAllocationService),
  };
}

async function load(data: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
  return workbook;
}

function sheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const found = workbook.getWorksheet(name);
  if (!found) throw new Error(`no sheet ${name}`);
  return found;
}

function dataRows(ws: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = [];
  for (let r = 3; r <= ws.rowCount; r += 1) {
    rows.push([1, 2, 3, 4, 5, 6, 7].map((c) => ws.getRow(r).getCell(c).value ?? null));
  }
  return rows;
}

function allValues(workbook: ExcelJS.Workbook): unknown[] {
  const values: unknown[] = [];
  workbook.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => values.push(cell.value))));
  return values;
}

describe('PriceListExportService', () => {
  it('writes one sheet per brand sorted by name, products without a brand on a last sheet', async () => {
    const workbook = await load((await setup().service.buildCurrent('UZ')).data);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(['Redmi', 'Xiaomi', 'Boshqa']);
    const ru = await load((await setup().service.buildCurrent('RU')).data);
    expect(ru.worksheets.at(-1)?.name).toBe('Прочее');
    const en = await load((await setup().service.buildCurrent('EN')).data);
    expect(en.worksheets.at(-1)?.name).toBe('Other');
  });

  it('a brand chosen by staff wins over the finder', async () => {
    const { service } = setup({ chosen: new Map([['id-U-1', 'b-h']]) });
    const workbook = await load((await service.buildCurrent('UZ')).data);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'Huawei',
      'Redmi',
      'Xiaomi',
      'Boshqa',
    ]);
    expect(dataRows(sheet(workbook, 'Huawei')).map((r) => r[3])).toEqual(['FreeBuds 6i Black']);
  });

  it('row 1: title in the accent colour, rate with a space thousands separator, today in Tashkent', async () => {
    // 20:00 UTC on the 21st is already the 22nd in Tashkent.
    const { service } = setup({ now: new Date('2026-10-21T20:00:00Z') });
    const result = await service.buildCurrent('UZ');
    const ws = sheet(await load(result.data), 'Xiaomi');
    expect(ws.getCell('A1').value).toBe('Price list');
    expect(ws.getCell('D1').value).toBe('Kurs: 11 960 UZS');
    expect(ws.getCell('G1').value).toBe('Sana: 22.10.2026');
    expect(ws.getCell('A1').font).toMatchObject({
      bold: true,
      size: 18,
      color: { argb: 'FFB8380A' },
    });
    expect(ws.getCell('G1').alignment).toMatchObject({ horizontal: 'right' });
    expect(ws.getRow(1).height).toBe(36);
    expect(result.dateLabel).toBe('22.10.2026');
    expect(result.rateLabel).toBe('11 960');
    expect(result.fileName).toBe('iorder-price-2026-10-22.xlsx');
  });

  it('leaves the rate cell out when no rate is set', async () => {
    const result = await setup({ rate: null }).service.buildCurrent('UZ');
    const ws = sheet(await load(result.data), 'Xiaomi');
    expect(ws.getCell('D1').value).toBeNull();
    expect(ws.getCell('G1').value).toBe('Sana: 21.10.2026');
    expect(result.rateLabel).toBeNull();
  });

  it('row 2: the headers in each language, white on dark, with filters; frozen below row 2', async () => {
    const uz = sheet(await load((await setup().service.buildCurrent('UZ')).data), 'Redmi');
    expect(uz.getRow(2).values).toEqual([
      undefined,
      'Kategoriya',
      'Tovar ID',
      'Rasm',
      'Mahsulot',
      'Qoldiq',
      'Цена $',
      'Отсрочка $',
    ]);
    expect(uz.getCell('B2').alignment).toMatchObject({ horizontal: 'center' });
    expect(uz.getCell('B2').font).toMatchObject({ bold: true, color: { argb: 'FFFFFFFF' } });
    expect((uz.getCell('B2').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF202020');
    expect(uz.autoFilter).toBe('A2:G2');
    expect(uz.views[0]).toMatchObject({ state: 'frozen', ySplit: 2 });
    const ru = sheet(await load((await setup().service.buildCurrent('RU')).data), 'Redmi');
    expect(ru.getRow(2).values).toEqual([
      undefined,
      'Категория',
      'ID товара',
      'Фото',
      'Товар',
      'Остаток',
      'Цена $',
      'Отсрочка $',
    ]);
    const en = sheet(await load((await setup().service.buildCurrent('EN')).data), 'Redmi');
    expect(en.getCell('B2').value).toBe('Product ID');
    expect(en.getCell('C2').value).toBe('Photo');
    expect(en.getCell('E2').value).toBe('Stock');
    expect(en.getCell('F2').value).toBe('Price $');
    expect(en.getCell('G2').value).toBe('Deferred $');
  });

  it('rows: category, product code, name, whole stock (blank for zero or unknown), price and deferred price as numbers', async () => {
    const workbook = await load((await setup().service.buildCurrent('UZ')).data);
    expect(dataRows(sheet(workbook, 'Redmi'))).toEqual([
      ['Наушники', 'R-2', null, 'Наушники REDMI Buds 8 Black', 'Есть в наличии', 250000, 245000],
      // No deferred-payment price: its cell stays empty.
      ['Часы', 'R-1', null, 'Redmi Watch 5 Lite Black', null, 480000.5, null],
    ]);
    // Sorted by category: Аксессуары before Пылесосы. Stock 3.7 -> 3 pieces; 0 -> blank.
    expect(dataRows(sheet(workbook, 'Xiaomi'))).toEqual([
      ['Аксессуары', 'A-1', null, 'Xiaomi Kettle', 3, 90000, null],
      ['Пылесосы', 'X-1', null, 'Xiaomi Robot Vacuum 6 EU', null, 3500000, null],
    ]);
    // No category goes last.
    expect(dataRows(sheet(workbook, 'Boshqa')).map((r) => r[0])).toEqual(['Наушники', '']);
  });

  it.each([
    ['exactly 10', '10', 10],
    ['10.9, which is 10 whole pieces', '10.9', 10],
    ['11', '11', 'Есть в наличии'],
    ['a large stock', '5000', 'Есть в наличии'],
  ])(
    'the stock column on every sheet and in every language: %s',
    async (_name, quantity, shown) => {
      const stock = new Map(LIST.items.map((i) => [i.product.id, new Prisma.Decimal(quantity)]));
      for (const lang of ['UZ', 'RU', 'EN'] as const) {
        const workbook = await load((await setup({ stock }).service.buildCurrent(lang)).data);
        expect(workbook.worksheets.length).toBeGreaterThan(1);
        for (const ws of workbook.worksheets) {
          for (const row of dataRows(ws)) expect(row[4], ws.name).toBe(shown);
        }
      }
    },
  );

  it('formats whole prices without decimals and prices with tiyin with two', async () => {
    const ws = sheet(await load((await setup().service.buildCurrent('UZ')).data), 'Redmi');
    expect(ws.getCell('F3').numFmt).toBe('#,##0');
    expect(ws.getCell('F4').numFmt).toBe('#,##0.00');
  });

  it('styles data rows: font 10, light grid, zebra fill, monospace code, bold price', async () => {
    const ws = sheet(await load((await setup().service.buildCurrent('UZ')).data), 'Redmi');
    expect(ws.getCell('D3').font).toMatchObject({ size: 10 });
    expect(ws.getCell('B3').font).toMatchObject({ name: 'Consolas' });
    expect(ws.getCell('F3').font).toMatchObject({ bold: true });
    expect(ws.getCell('G3').border?.bottom?.style).toBe('thin');
    expect(ws.getRow(3).height).toBe(18);
    const fill = (address: string) =>
      (ws.getCell(address).fill as ExcelJS.FillPattern).fgColor?.argb;
    expect(fill('A3')).toBe('FFFFFFFF');
    expect(fill('A4')).toBe('FFF6F7F8');
    expect(ws.pageSetup).toMatchObject({ orientation: 'landscape', fitToWidth: 1 });
  });

  it('writes a price too long for a double as exact text', async () => {
    const list: PriceListView = {
      ...LIST,
      items: [priced(product('BIG', { RU: 'Big' }), '1234567890123456.78')],
    };
    const ws = sheet(await load((await setup({ list }).service.buildCurrent()).data), 'Boshqa');
    expect(ws.getCell('F3').value).toBe('1234567890123456.78');
  });

  it('stores text unchanged as string cells and writes no formula cells', async () => {
    const workbook = await load((await setup().service.buildCurrent('UZ')).data);
    workbook.eachSheet((ws) =>
      ws.eachRow((row) =>
        row.eachCell((cell) => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)),
      ),
    );
    const cell = sheet(workbook, 'Boshqa').getCell('D4');
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.value).toBe('=HYPERLINK("http://evil.example","x")');
  });

  it('holds no cost data: only the rate, which the owner wants in this file (hard rule 7)', async () => {
    for (const lang of ['UZ', 'RU', 'EN'] as const) {
      const values = allValues(await load((await setup().service.buildCurrent(lang)).data));
      const text = JSON.stringify(values).toLowerCase();
      for (const word of [
        'cost',
        'supplier',
        'margin',
        'purchase',
        'usd',
        'staff',
        'internal',
        'secret',
        'tannarx',
        'себестоим',
        'закуп',
        'поставщик',
      ]) {
        expect(text, `${lang}: ${word}`).not.toContain(word);
      }
    }
    const values = allValues(await load((await setup().service.buildCurrent('UZ')).data));
    const allowed = new Set<unknown>([
      'Price list',
      'Kurs: 11 960 UZS',
      'Sana: 21.10.2026',
      'Kategoriya',
      'Tovar ID',
      'Rasm',
      'Mahsulot',
      'Qoldiq',
      'Цена $',
      'Отсрочка $',
      ...LIST.items.map((i) => i.product.productCode),
      ...LIST.items.flatMap((i) => i.product.translations.map((t) => t.name)),
      ...LIST.items.map((i) => i.product.category).filter((c) => c !== null),
      '',
      'Есть в наличии',
      3,
      250000,
      245000,
      480000.5,
      3500000,
      1000,
      1,
      90000,
    ]);
    for (const value of values) expect(allowed, String(value)).toContain(value);
  });

  describe('photo column', () => {
    it("puts the primary photo in the middle of the product's photo cell, keeping its proportions", async () => {
      const wide = await jpeg(200, 100);
      const { service } = setup({ photos: new Map([['id-R-2', wide]]) });
      const ws = sheet(await load((await service.buildCurrent('UZ')).data), 'Redmi');
      const [image, ...others] = ws.getImages();
      expect(others).toEqual([]);
      // 0-based anchor: column C (the photo column), row 3 (R-2 is the first Redmi row).
      expect(Math.floor(image?.range.tl.nativeCol ?? -1)).toBe(2);
      expect(image?.range.tl.nativeRow).toBe(2);
      // ExcelJS reads the size back but its types do not declare it.
      expect((image?.range as { ext?: unknown } | undefined)?.ext).toEqual({
        width: 56,
        height: 28,
      });
      // Every row of a sheet with a photo is tall enough for it; other sheets keep 18.
      expect(ws.getRow(3).height).toBe(48);
      expect(ws.getRow(4).height).toBe(48);
      const xiaomi = sheet(await load((await service.buildCurrent('UZ')).data), 'Xiaomi');
      expect(xiaomi.getImages()).toEqual([]);
      expect(xiaomi.getRow(3).height).toBe(18);
    });

    it('stores a photo shared by two products once', async () => {
      const same = await jpeg(64, 64);
      const { service } = setup({
        photos: new Map([
          ['id-R-2', same],
          ['id-R-1', same],
        ]),
      });
      const workbook = await load((await service.buildCurrent('UZ')).data);
      expect(sheet(workbook, 'Redmi').getImages()).toHaveLength(2);
      expect(workbook.model.media).toHaveLength(1);
    });

    it('builds a new file when a photo changes', async () => {
      const { state, service } = setup({ photos: new Map([['id-R-2', await jpeg(64, 64)]]) });
      const before = (await service.buildCurrent('UZ')).data;
      expect((await service.buildCurrent('UZ')).data).toBe(before);
      state.photos = new Map([['id-R-2', await jpeg(64, 64, '#1a4ae0')]]);
      expect((await service.buildCurrent('UZ')).data).not.toBe(before);
    });
  });

  it('passes the "no published list" error through and builds nothing', async () => {
    await expect(setup({ list: null }).service.buildCurrent()).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('still produces a valid workbook when the list has no active product', async () => {
    const workbook = await load(
      (await setup({ list: { ...LIST, items: [] } }).service.buildCurrent()).data,
    );
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(['Boshqa']);
  });

  describe('cache', () => {
    it('returns the same bytes when nothing that is shown changed', async () => {
      const { service } = setup();
      const first = await service.buildCurrent('EN');
      expect((await service.buildCurrent('EN')).data).toBe(first.data);
      expect((await service.buildCurrent('RU')).data).not.toBe(first.data);
    });

    it('builds a new file when the stock, a brand, the rate, the date or a price changes', async () => {
      const { state, service } = setup();
      let previous = (await service.buildCurrent('UZ')).data;
      const changes: (() => void)[] = [
        () => {
          state.stock = new Map([['id-R-2', new Prisma.Decimal('5')]]);
        },
        () => {
          state.chosen = new Map([['id-U-1', 'b-h']]);
        },
        () => {
          state.rate = { rate: new Prisma.Decimal('12000'), source: 'MANUAL', rateDate: null };
        },
        () => {
          state.now = new Date('2026-10-23T09:00:00Z');
        },
        () => {
          // A new version with a new price. (A version that shows the same content keeps the
          // bytes: the version number is not in the file.)
          const [first, ...rest] = LIST.items;
          if (!first) throw new Error('fixture');
          state.list = {
            version: { ...LIST.version, id: 'v-next', number: 8 },
            items: [{ ...first, basePrice: new Prisma.Decimal('260000') }, ...rest],
            usdRate: null,
            priceTier: null,
          };
        },
      ];
      for (const change of changes) {
        change();
        const next = (await service.buildCurrent('UZ')).data;
        expect(next).not.toBe(previous);
        previous = next;
      }
    });

    it('keeps at most 8 entries', async () => {
      const { state, service } = setup();
      const first = await service.buildCurrent('EN');
      for (let i = 0; i < 8; i += 1) {
        state.now = new Date(Date.UTC(2026, 10, 1 + i, 9));
        await service.buildCurrent('EN');
      }
      state.now = new Date('2026-10-21T09:00:00Z');
      expect((await service.buildCurrent('EN')).data).not.toBe(first.data);
    });
  });
});

describe('jpegSize', () => {
  it('reads the frame size and refuses what is not a JPEG', async () => {
    expect(jpegSize(await jpeg(120, 45))).toEqual({ width: 120, height: 45 });
    expect(jpegSize(Buffer.from('not a jpeg'))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe('uniqueSheetName', () => {
  it('drops characters Excel forbids, cuts to 31 and keeps names unique ignoring case', () => {
    const used = new Set<string>();
    expect(uniqueSheetName('A/B:C*D?E[F]G\\H', used)).toBe('A B C D E F G H');
    expect(uniqueSheetName('x'.repeat(40), used)).toBe('x'.repeat(31));
    expect(uniqueSheetName('Redmi', used)).toBe('Redmi');
    expect(uniqueSheetName('REDMI', used)).toBe('REDMI (2)');
    expect(uniqueSheetName("'quoted'", used)).toBe('quoted');
    expect(uniqueSheetName('///', used)).toBe('Sheet');
  });
});

describe('formatRate', () => {
  it.each([
    ['11960.0000', '11 960'],
    ['12034.5600', '12 034,56'],
    ['950', '950'],
    ['1234567.891', '1 234 567,89'],
  ])('%s -> %s', (rate, label) => {
    expect(formatRate(new Prisma.Decimal(rate))).toBe(label);
  });
});
