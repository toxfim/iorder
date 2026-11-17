import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { DEFAULT_LOCALE, type Locale, type PriceTier } from '@iorder/shared';
import { businessDayOf, getBusinessTimeParts } from '../../common/clock/business-time.js';
import { Clock } from '../../common/clock/clock.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { BrandService, CatalogService, ProductImagesService } from '../catalog/index.js';
import { toCustomerPriceListResponse } from './dto/pricing.response.js';
import { PricingService } from './pricing.service.js';
import { SupplyAllocationService } from './supply-allocation/supply-allocation.service.js';
import { UsdRateService } from './usd-rate/usd-rate.service.js';

export interface PriceListExport {
  /** `iorder-price-YYYY-MM-DD.xlsx`, the date being today in Asia/Tashkent. */
  fileName: string;
  data: Uint8Array;
  versionNumber: number;
  /** Publication moment of the exported version (UTC instant). */
  publishedAt: Date;
  /** `publishedAt` as DD.MM.YYYY HH:mm in Asia/Tashkent, for captions. */
  publishedAtLabel: string;
  /** Today in Asia/Tashkent as DD.MM.YYYY (the "Sana" cell). */
  dateLabel: string;
  /** The USD rate as shown in the file ("11 960"), null when no rate is set. */
  rateLabel: string | null;
  rowCount: number;
}

export interface Labels {
  title: string;
  rate: string;
  date: string;
  /** The sheet of the products without a brand (always the last sheet). */
  otherBrand: string;
  headers: readonly [string, string, string, string, string, string, string];
}

// Layout and UZ wording from the owner's template (docs/template.xlsx, 2026-10-28), plus the
// product code and photo columns the owner asked for on 2026-10-29. The two price columns are USD
// and carry the owner's own names in UZ and RU ("Цена $" / "Отсрочка $", 2026-10-29). RU and EN
// are a first draft for a native speaker (like the bot replies).
export const PRICE_FILE_LABELS: Record<Locale, Labels> = {
  UZ: {
    title: 'Price list',
    rate: 'Kurs',
    date: 'Sana',
    otherBrand: 'Boshqa',
    headers: ['Kategoriya', 'Tovar ID', 'Rasm', 'Mahsulot', 'Qoldiq', 'Цена $', 'Отсрочка $'],
  },
  RU: {
    title: 'Прайс-лист',
    rate: 'Курс',
    date: 'Дата',
    otherBrand: 'Прочее',
    headers: ['Категория', 'ID товара', 'Фото', 'Товар', 'Остаток', 'Цена $', 'Отсрочка $'],
  },
  EN: {
    title: 'Price list',
    rate: 'Rate',
    date: 'Date',
    otherBrand: 'Other',
    headers: ['Category', 'Product ID', 'Photo', 'Product', 'Stock', 'Price $', 'Deferred $'],
  },
};

/** What the file shows, and nothing else: the cache key is a hash of exactly this. */
interface WorkbookModel {
  lang: Locale;
  /** The tier the prices are in; part of the cache key, so the two tiers never share bytes. */
  tier: PriceTier;
  dateLabel: string;
  rateLabel: string | null;
  sheets: { name: string; rows: RowModel[] }[];
}

interface RowModel {
  category: string;
  name: string;
  productCode: string;
  /** Whole pieces; null (an empty cell) when the stock is zero or unknown. */
  stock: number | null;
  /** USD decimal string (never put through arithmetic). */
  price: string;
  /** The deferred-payment price in USD; null (an empty cell) when the item has none. */
  deferredPrice: string | null;
  /** sha256 of the primary photo's JPEG thumbnail (null: no photo), so a new photo is a new file. */
  image: string | null;
}

const HEADER_ROW = 2;
/** A decimal with at most this many significant digits round-trips through a double unchanged. */
const MAX_EXACT_DIGITS = 15;
/** Enough for a few recent files in three languages. */
const CACHE_MAX_ENTRIES = 8;
const SHEET_NAME_MAX = 31;
const COLUMN_COUNT = 7;
const COLUMN_WIDTHS = [24, 16, 11, 50, 15, 15, 16] as const;
/** 1-based columns. */
const COL = { category: 1, code: 2, photo: 3, name: 4, stock: 5, price: 6, deferred: 7 } as const;
/** The photo box inside its cell, in pixels; rows of a sheet with photos are this tall. */
const PHOTO_BOX = 56;
const PHOTO_ROW_HEIGHT_PT = 48;
const PHOTO_ROW_HEIGHT_PX = 64;
/** Pixels of one character of column width in Calibri 11 (Excel's default). */
const PX_PER_WIDTH = 7;
// Colors of the staff design tokens (--ink, --acc-fg), so the file looks like the app.
const INK = 'FF202020';
const ACCENT = 'FFB8380A';
const MUTED = 'FF5F6368';
const ZEBRA = ['FFFFFFFF', 'FFF6F7F8'] as const;
const GRID = { style: 'thin', color: { argb: 'FFE1E3E6' } } as const;
const BORDER = { top: GRID, left: GRID, bottom: GRID, right: GRID };
const HEADER_EDGE = { style: 'thin', color: { argb: INK } } as const;

/**
 * Builds the Excel price list ([C] 2026-10-28, owner's template): the file `/price` sends and the
 * one posted to every organization group. One sheet per brand (sorted by name), products without
 * a brand on a last sheet. Row 1: title, USD rate, today's date; row 2: headers; then the rows,
 * sorted by category (locale-aware, no category last), then name, then code.
 *
 * Hard rule 7: product rows come from the CUSTOMER price list DTO mapper (name, category, price),
 * fed with the list in USD (the owner's columns; hard rule 1's UZS applies to the app screens),
 * plus the stock aggregate as whole pieces (showing stock in this file is an owner decision of
 * 2026-10-28) and the brand. The only cost-class value is the USD rate setting, which the owner
 * explicitly wants in this file (an exception to "the rate is staff-only"). Nothing else is read
 * from cost data: no purchase price, supplier or margin.
 *
 * Money (hard rule 1): the price string from the DTO is never put through arithmetic. It becomes
 * a numeric cell with a display format only when it has at most 15 digits, which round-trips
 * through a double; a longer value could lose digits, so it is written as text instead.
 */
@Injectable()
export class PriceListExportService {
  /** Insertion-ordered, so the first key is the oldest entry. */
  private readonly cache = new Map<string, Uint8Array>();

  constructor(
    private readonly pricing: PricingService,
    private readonly catalog: CatalogService,
    private readonly brands: BrandService,
    private readonly images: ProductImagesService,
    private readonly usdRate: UsdRateService,
    private readonly clock: Clock,
    private readonly holds: SupplyAllocationService,
  ) {}

  /**
   * The caller has already authorized the request (the bot checks the person and the group; the
   * staff endpoint checks the role). Throws NotFoundError when nothing is published; a draft is
   * never exported. `tier`: whose prices the file shows [C, owner 2026-11-11]; each organization
   * gets the file of ITS tier, the caller picks it.
   */
  async buildCurrent(
    lang: Locale = DEFAULT_LOCALE,
    tier: PriceTier = 'STANDARD',
  ): Promise<PriceListExport> {
    const list = await this.pricing.getCurrentForExport(tier);
    const products = list.items.map((item) => item.product);
    const ids = products.map((p) => p.id);
    const [sheetStock, brandOf, rate, thumbnails] = await Promise.all([
      this.catalog.getStockQuantities(ids),
      this.brands.resolveBrands(products),
      this.usdRate.readSnapshot(),
      this.images.primaryThumbnailsForExport(ids),
    ]);
    // The file shows what can still be promised: the sheet's stock minus the holds of approved orders.
    const stock = await this.holds.availableFrom(sheetStock);
    // Keyed by content, so a photo shared by two products is stored in the file once.
    const photos = new Map<string, Buffer>();
    const photoOf = new Map<string, string>();
    for (const [productId, thumb] of thumbnails) {
      const key = createHash('sha256').update(thumb.buffer).digest('hex');
      photos.set(key, thumb.buffer);
      photoOf.set(productId, key);
    }
    // The file embeds its own thumbnails (above); the DTO's photo URLs are not used here.
    const dto = toCustomerPriceListResponse(list, new Map());
    const now = this.clock.now();
    const dateLabel = formatDate(now);
    const rateLabel = rate === null ? null : formatRate(rate.rate);

    const labels = PRICE_FILE_LABELS[lang];
    const groups = new Map<string | null, RowModel[]>();
    for (const item of dto.items) {
      const brand = brandOf.get(item.productId)?.name ?? null;
      const rows = groups.get(brand) ?? [];
      rows.push({
        category: item.category ?? '',
        name: item.name,
        productCode: item.productCode,
        stock: wholePieces(stock.get(item.productId)),
        price: item.price,
        deferredPrice: item.deferredPrice,
        image: photoOf.get(item.productId) ?? null,
      });
      groups.set(brand, rows);
    }
    const model: WorkbookModel = {
      lang,
      tier,
      dateLabel,
      rateLabel,
      sheets: sheetsOf(groups, labels.otherBrand),
    };
    const publishedAt = new Date(dto.version.publishedAt);
    return {
      fileName: `iorder-price-${businessDayOf(now).date}.xlsx`,
      data: await this.workbookBytes(model, photos),
      versionNumber: dto.version.number,
      publishedAt,
      publishedAtLabel: formatDateTime(publishedAt),
      dateLabel,
      rateLabel,
      rowCount: dto.items.length,
    };
  }

  /**
   * The bytes depend on the version's prices, stock, brands, photos, the rate, today's date and
   * the language, and stock and brands change between versions. So the key is a hash of the whole
   * model the file is built from: the same content is serialized once, anything else is new.
   */
  private async workbookBytes(
    model: WorkbookModel,
    photos: ReadonlyMap<string, Buffer>,
  ): Promise<Uint8Array> {
    // The photos are in the model by their content hash, so the key covers them too.
    const key = createHash('sha256').update(JSON.stringify(model)).digest('hex');
    const cached = this.cache.get(key);
    if (cached) return cached;
    const data = await buildWorkbook(model, photos);
    this.cache.set(key, data);
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return data;
  }
}

/** Brand sheets sorted by name, then the sheet of the products without a brand. */
function sheetsOf(
  groups: ReadonlyMap<string | null, RowModel[]>,
  otherBrand: string,
): WorkbookModel['sheets'] {
  const brands = [...groups.keys()]
    .filter((name): name is string => name !== null)
    .sort((a, b) => COLLATOR.compare(a, b) || compareText(a, b));
  const ordered: { title: string; rows: RowModel[] }[] = brands.map((name) => ({
    title: name,
    rows: groups.get(name) ?? [],
  }));
  const unbranded = groups.get(null);
  // A workbook needs at least one sheet, so an empty list still gets the last one.
  if (unbranded !== undefined || ordered.length === 0) {
    ordered.push({ title: otherBrand, rows: unbranded ?? [] });
  }
  const used = new Set<string>();
  return ordered.map(({ title, rows }) => ({
    name: uniqueSheetName(title, used),
    rows: [...rows].sort(
      (a, b) =>
        compareCategory(a.category, b.category) ||
        compareText(a.name, b.name) ||
        compareText(a.productCode, b.productCode),
    ),
  }));
}

/**
 * Excel rules for a sheet name: at most 31 characters, none of [ ] : * ? / \, not starting or
 * ending with an apostrophe, unique ignoring case.
 */
export function uniqueSheetName(title: string, used: Set<string>): string {
  const base =
    title
      .replace(/[[\]:*?/\\\p{Cc}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^'+|'+$/g, '')
      .trim()
      .slice(0, SHEET_NAME_MAX)
      .trim() || 'Sheet';
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n += 1) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, SHEET_NAME_MAX - suffix.length).trim()}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

async function buildWorkbook(
  model: WorkbookModel,
  photos: ReadonlyMap<string, Buffer>,
): Promise<Uint8Array> {
  const labels = PRICE_FILE_LABELS[model.lang];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'iOrder.uz';
  const imageIds = new Map<string, number>();
  const imageIdOf = (key: string): number | null => {
    const known = imageIds.get(key);
    if (known !== undefined) return known;
    const buffer = photos.get(key);
    if (buffer === undefined) return null;
    // ExcelJS types its buffer as an ArrayBuffer but takes a Node Buffer (as `xlsx.load` does).
    const id = workbook.addImage({ buffer: buffer as unknown as ArrayBuffer, extension: 'jpeg' });
    imageIds.set(key, id);
    return id;
  };
  for (const sheetModel of model.sheets) {
    const withPhotos = sheetModel.rows.some((row) => row.image !== null);
    const sheet = workbook.addWorksheet(sheetModel.name, {
      views: [{ state: 'frozen', ySplit: HEADER_ROW, showGridLines: false }],
      pageSetup: {
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        printTitlesRow: `1:${HEADER_ROW}`,
      },
    });
    sheet.columns = COLUMN_WIDTHS.map((width) => ({ width }));
    writeTopRow(sheet, model, labels);
    writeHeaderRow(sheet, labels);

    sheetModel.rows.forEach((item, index) => {
      const rowNumber = HEADER_ROW + 1 + index;
      const row = sheet.getRow(rowNumber);
      row.height = withPhotos ? PHOTO_ROW_HEIGHT_PT : 18;
      // Text always goes in as a string cell, never a formula, and is stored unchanged. ExcelJS
      // cannot write the quotePrefix style, so a value starting with = + - @ is not prefixed.
      row.getCell(COL.category).value = item.category;
      row.getCell(COL.code).value = item.productCode;
      row.getCell(COL.name).value = item.name;
      if (item.stock !== null) row.getCell(COL.stock).value = stockCellValue(item.stock);
      writePrice(row.getCell(COL.price), item.price);
      if (item.deferredPrice !== null) writePrice(row.getCell(COL.deferred), item.deferredPrice);
      const imageId = item.image === null ? null : imageIdOf(item.image);
      const photo = item.image === null ? undefined : photos.get(item.image);
      if (imageId !== null && photo !== undefined) placePhoto(sheet, imageId, photo, rowNumber);
      const fill = ZEBRA[index % 2] ?? ZEBRA[0];
      for (let column = 1; column <= COLUMN_COUNT; column += 1) {
        const cell = row.getCell(column);
        cell.font = dataFont(column);
        cell.border = BORDER;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        cell.alignment = {
          vertical: 'middle',
          horizontal:
            column === COL.code || column === COL.photo || column === COL.stock
              ? 'center'
              : column >= COL.price
                ? 'right'
                : 'left',
        };
      }
    });
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

/** Category muted, product code monospace, price bold; the rest plain. */
function dataFont(column: number): Partial<ExcelJS.Font> {
  const base = { name: 'Calibri', size: 10, color: { argb: INK } };
  if (column === COL.category) return { ...base, color: { argb: MUTED } };
  if (column === COL.code) return { ...base, name: 'Consolas' };
  if (column === COL.price) return { ...base, bold: true };
  return base;
}

function writeTopRow(sheet: ExcelJS.Worksheet, model: WorkbookModel, labels: Labels): void {
  const top = sheet.getRow(1);
  top.height = 36;
  const title = sheet.getCell('A1');
  title.value = labels.title;
  title.font = { name: 'Arial', bold: true, size: 18, color: { argb: ACCENT } };
  title.alignment = { vertical: 'middle' };
  const cells: [string, string | null][] = [
    ['D1', model.rateLabel === null ? null : `${labels.rate}: ${model.rateLabel} UZS`],
    ['G1', `${labels.date}: ${model.dateLabel}`],
  ];
  for (const [address, text] of cells) {
    if (text === null) continue;
    const cell = sheet.getCell(address);
    cell.value = text;
    cell.font = { name: 'Arial', bold: true, size: 12, color: { argb: INK } };
    cell.alignment = { vertical: 'middle', horizontal: 'right' };
  }
}

function writeHeaderRow(sheet: ExcelJS.Worksheet, labels: Labels): void {
  const header = sheet.getRow(HEADER_ROW);
  header.height = 24;
  labels.headers.forEach((text, index) => {
    const cell = header.getCell(index + 1);
    cell.value = text;
    cell.font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { top: HEADER_EDGE, left: HEADER_EDGE, bottom: HEADER_EDGE, right: HEADER_EDGE };
  });
  // Filter buttons on the headers, so a customer can narrow a long sheet to one category.
  sheet.autoFilter = {
    from: { row: HEADER_ROW, column: 1 },
    to: { row: HEADER_ROW, column: COLUMN_COUNT },
  };
}

/**
 * Puts a photo in the middle of its cell, scaled into PHOTO_BOX keeping its proportions. A photo
 * whose size cannot be read is drawn as a square rather than dropped.
 */
function placePhoto(
  sheet: ExcelJS.Worksheet,
  imageId: number,
  jpeg: Buffer,
  rowNumber: number,
): void {
  const size = jpegSize(jpeg) ?? { width: PHOTO_BOX, height: PHOTO_BOX };
  const scale = PHOTO_BOX / Math.max(size.width, size.height);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const cellWidth = (COLUMN_WIDTHS[COL.photo - 1] ?? 0) * PX_PER_WIDTH;
  sheet.addImage(imageId, {
    // 0-based anchors; the fraction is the offset inside the cell.
    tl: {
      col: COL.photo - 1 + Math.max(0, (cellWidth - width) / 2 / cellWidth),
      row: rowNumber - 1 + Math.max(0, (PHOTO_ROW_HEIGHT_PX - height) / 2 / PHOTO_ROW_HEIGHT_PX),
    } as ExcelJS.Anchor,
    ext: { width, height },
    editAs: 'oneCell',
  });
}

/** Width and height from a JPEG's start-of-frame segment, or null when there is none. */
export function jpegSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1] ?? 0;
    const length = data.readUInt16BE(offset + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function writePrice(cell: ExcelJS.Cell, price: string): void {
  if (isExactlyRepresentable(price)) {
    // A conversion of a Decimal(18,2) value for a display-formatted cell, not arithmetic.
    cell.value = Number(price);
    cell.numFmt = /\.0*$/.test(price) || !price.includes('.') ? '#,##0' : '#,##0.00';
  } else {
    cell.value = price;
  }
}

function isExactlyRepresentable(price: string): boolean {
  return /^\d+(\.\d+)?$/.test(price) && price.replace('.', '').length <= MAX_EXACT_DIGITS;
}

// Owner decision 2026-11-04: above this many pieces the file says "in stock" instead of the number.
// The text is Russian in every language of the file, as the owner asked.
const EXACT_STOCK_MAX_PIECES = 10;
const IN_STOCK_TEXT = 'Есть в наличии';

function stockCellValue(pieces: number): number | string {
  return pieces > EXACT_STOCK_MAX_PIECES ? IN_STOCK_TEXT : pieces;
}

/** Whole pieces for the "Qoldiq" column; null (empty cell) for zero, negative or unknown stock. */
function wholePieces(quantity: Prisma.Decimal | undefined): number | null {
  if (quantity === undefined) return null;
  const whole = quantity.floor();
  return whole.greaterThan(0) ? whole.toNumber() : null;
}

/** "11 960" or "12 034,56": thousands separated by a space, at most two decimals (display only). */
export function formatRate(rate: Prisma.Decimal): string {
  const [integer = '0', fraction = '00'] = rate.toFixed(2).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fraction === '00' ? grouped : `${grouped},${fraction}`;
}

// Category and brand names are mostly Russian or Latin, so Russian collation (it also orders
// Latin sensibly).
const COLLATOR = new Intl.Collator('ru');

/** Alphabetical; products without a category ('') go last. */
function compareCategory(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  return COLLATOR.compare(a, b);
}

// Plain code-point order: the same on every machine, unlike locale-dependent collation.
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** DD.MM.YYYY in Asia/Tashkent. */
function formatDate(instant: Date): string {
  const t = getBusinessTimeParts(instant);
  return `${pad(t.day)}.${pad(t.month)}.${t.year}`;
}

/** DD.MM.YYYY HH:mm in Asia/Tashkent. */
function formatDateTime(instant: Date): string {
  const t = getBusinessTimeParts(instant);
  return `${formatDate(instant)} ${pad(t.hour)}:${pad(t.minute)}`;
}
