import {
  PRODUCT_NAME_MAX_LENGTH,
  moneyStringSchema,
  productCodeKey,
  productCodeSchema,
  type Locale,
} from '@iorder/shared';
import {
  PRICE_IMPORT_COLUMNS,
  PRICE_IMPORT_ALIF_COLUMNS,
  PRICE_IMPORT_WHOLESALE_COLUMNS,
  PRODUCT_CATEGORY_MAX_LENGTH,
  type PriceImportAlifColumn,
  type PriceImportColumn,
  type PriceImportWholesaleColumn,
  type PriceImportPreviewRow,
  type PriceImportRowIssue,
  type PriceImportRowStatus,
  type PriceImportRowWarning,
} from '@iorder/shared/staff-cost';
import { Prisma } from '../../../generated/prisma/client.js';

// PURE: the row rules of the price list import [C, 2026-11-09], shared by the preview (which
// writes nothing) and the confirm (which re-runs exactly these checks against locked data). No
// I/O, no clock. Money stays a decimal string / Decimal (hard rule 1).

/**
 * The template's headers per language, in PRICE_IMPORT_COLUMNS order. The parser accepts any
 * language's wording (compared trimmed, ignoring case); the template is downloaded in UZ.
 * "Kategoriya" and "RRP $" were added on the owner's request [C, 2026-11-09]; both cells are
 * optional, but the columns themselves are part of the header row: a file of the older five-column
 * template is refused (FILE_HEADERS_INVALID) rather than read as "no RRP", which would silently
 * remove the RRP of every product it re-prices [P].
 */
export const PRICE_IMPORT_HEADERS: Record<Locale, readonly string[]> = {
  UZ: ['Tovar ID', 'Mahsulot', 'Brend', 'Kategoriya', 'Цена $', 'Отсрочка $', 'RRP $'],
  RU: ['ID товара', 'Товар', 'Бренд', 'Категория', 'Цена $', 'Отсрочка $', 'RRP $'],
  EN: ['Product ID', 'Product', 'Brand', 'Category', 'Price $', 'Deferred $', 'RRP $'],
};

/**
 * The optional «Оптовик/Партнер» columns [C, owner 2026-11-11]: the template's own headers (UZ and
 * RU use the owner's Russian price wording, like "Цена $") and the wordings the parser also accepts
 * (compared like the other headers). Anywhere after the required columns, in any order.
 */
export const PRICE_IMPORT_WHOLESALE_HEADERS: Record<
  PriceImportWholesaleColumn,
  { template: Record<Locale, string>; accepted: readonly string[] }
> = {
  wholesalePrice: {
    template: { UZ: 'Оптовик/Партнер $', RU: 'Оптовик/Партнер $', EN: 'Wholesale/Partner $' },
    accepted: [
      'Оптовик/Партнер $',
      'Оптовик/Партнер',
      'Optovik/Partner $',
      'Optovik/Partner',
      'Wholesale/Partner $',
      'Wholesale/Partner',
      'Wholesale $',
      'Wholesale',
    ],
  },
  wholesaleDeferredPrice: {
    template: {
      UZ: 'Оптовик/Партнер Отсрочка $',
      RU: 'Оптовик/Партнер Отсрочка $',
      EN: 'Wholesale/Partner deferred $',
    },
    accepted: [
      'Оптовик/Партнер Отсрочка $',
      'Оптовик/Партнер Отсрочка',
      'Optovik/Partner Отсрочка $',
      'Optovik/Partner Otsrochka $',
      'Wholesale/Partner deferred $',
      'Wholesale/Partner deferred',
      'Wholesale deferred $',
      'Wholesale deferred',
    ],
  },
};

/** Where the wholesale columns are in a sheet (0-based); null = the file has no such column. */
export type WholesaleColumnIndexes = Record<PriceImportWholesaleColumn, number | null>;

export const NO_WHOLESALE_COLUMNS: WholesaleColumnIndexes = Object.freeze({
  wholesalePrice: null,
  wholesaleDeferredPrice: null,
});

/** Finds the wholesale columns in a header row after the required columns. */
export function findWholesaleColumns(cells: readonly unknown[]): WholesaleColumnIndexes {
  const found: Record<PriceImportWholesaleColumn, number | null> = { ...NO_WHOLESALE_COLUMNS };
  for (let index = PRICE_IMPORT_COLUMNS.length; index < cells.length; index += 1) {
    const key = headerKey(cells[index]);
    for (const column of PRICE_IMPORT_WHOLESALE_COLUMNS) {
      const accepted = PRICE_IMPORT_WHOLESALE_HEADERS[column].accepted;
      if (found[column] === null && accepted.some((header) => headerKey(header) === key)) {
        found[column] = index;
      }
    }
  }
  return found;
}

/**
 * The optional «Alif factoring» columns [C, owner 2026-11-12], found like the wholesale ones. The
 * template headers and the accepted wordings are [P].
 */
export const PRICE_IMPORT_ALIF_HEADERS: Record<
  PriceImportAlifColumn,
  { template: Record<Locale, string>; accepted: readonly string[] }
> = {
  alifPrice: {
    template: { UZ: 'Alif $', RU: 'Alif $', EN: 'Alif $' },
    accepted: ['Alif $', 'Alif', 'Алиф $', 'Алиф', 'Alif factoring $', 'Alif factoring'],
  },
  alifDeferredPrice: {
    template: { UZ: 'Alif Отсрочка $', RU: 'Alif Отсрочка $', EN: 'Alif deferred $' },
    accepted: [
      'Alif Отсрочка $',
      'Alif Отсрочка',
      'Алиф Отсрочка $',
      'Алиф Отсрочка',
      'Alif Otsrochka $',
      'Alif deferred $',
      'Alif deferred',
    ],
  },
};

/** Where the Alif columns are in a sheet (0-based); null = the file has no such column. */
export type AlifColumnIndexes = Record<PriceImportAlifColumn, number | null>;

export const NO_ALIF_COLUMNS: AlifColumnIndexes = Object.freeze({
  alifPrice: null,
  alifDeferredPrice: null,
});

/** Finds the Alif columns in a header row after the required columns. */
export function findAlifColumns(cells: readonly unknown[]): AlifColumnIndexes {
  const found: Record<PriceImportAlifColumn, number | null> = { ...NO_ALIF_COLUMNS };
  for (let index = PRICE_IMPORT_COLUMNS.length; index < cells.length; index += 1) {
    const key = headerKey(cells[index]);
    for (const column of PRICE_IMPORT_ALIF_COLUMNS) {
      const accepted = PRICE_IMPORT_ALIF_HEADERS[column].accepted;
      if (found[column] === null && accepted.some((header) => headerKey(header) === key)) {
        found[column] = index;
      }
    }
  }
  return found;
}

/** A data row as the file (or the confirm request) gives it, before any lookup. */
export interface ImportRowInput {
  rowNumber: number;
  /** Trimmed; null when empty. */
  productCode: string | null;
  name: string;
  brandName: string | null;
  /** The category cell, trimmed; null when empty. */
  category: string | null;
  /** Normalized money strings; null when the cell is empty or unreadable. */
  basePrice: string | null;
  deferredPrice: string | null;
  /** The recommended retail price; null when the cell is empty (no RRP) or unreadable. */
  rrp: string | null;
  /**
   * The «Оптовик/Партнер» prices; meaningful only when `wholesaleGiven` (the file has the price
   * column, or the confirm row sends the field). Not given = the import keeps the current ones.
   */
  wholesalePrice: string | null;
  wholesaleDeferredPrice: string | null;
  wholesaleGiven: boolean;
  /** The «Alif factoring» prices, like the wholesale ones (`alifGiven` false = keep the current). */
  alifPrice: string | null;
  alifDeferredPrice: string | null;
  alifGiven: boolean;
  /** What the parser already knows is wrong with the cells (format, not lookups). */
  issues: PriceImportRowIssue[];
}

/** What the import knows about an existing product (never a cost field). */
export interface ImportProductFact {
  id: string;
  /** The common name as stored (what a sheet product keeps and a rename is compared with). */
  name: string;
  codeGenerated: boolean;
  isActive: boolean;
  mergedIntoProductId: string | null;
}

export interface ImportPrices {
  basePrice: Prisma.Decimal;
  deferredPrice: Prisma.Decimal | null;
  rrp: Prisma.Decimal | null;
  wholesalePrice: Prisma.Decimal | null;
  wholesaleDeferredPrice: Prisma.Decimal | null;
  alifPrice: Prisma.Decimal | null;
  alifDeferredPrice: Prisma.Decimal | null;
}

/** The catalog and the published list as the rows are judged against them. */
export interface ImportContext {
  /** productCodeKey -> product. */
  productsByCodeKey: ReadonlyMap<string, ImportProductFact>;
  /** lower(btrim(name)) -> brand id. */
  brandIdsByNameKey: ReadonlyMap<string, string>;
  /** productId -> prices in the published list. */
  publishedPrices: ReadonlyMap<string, ImportPrices>;
  /** lower(trim(name)) of every active product's names. */
  activeNameKeys: ReadonlySet<string>;
}

/** A judged row: the preview DTO plus what the confirm needs to act on it. */
export interface JudgedRow {
  preview: PriceImportPreviewRow;
  /** The brand named by the cell, when it exists. */
  brandId: string | null;
  /** The existing product's stored name; null for a code-less row or an unknown code. */
  currentName: string | null;
}

// ---------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------

/** The header row names the columns in any of the three languages; null when it matches none. */
export function matchHeaders(cells: readonly unknown[]): Locale | null {
  const given = PRICE_IMPORT_COLUMNS.map((_, index) => headerKey(cells[index]));
  for (const [locale, headers] of Object.entries(PRICE_IMPORT_HEADERS) as [
    Locale,
    readonly string[],
  ][]) {
    if (headers.every((header, index) => headerKey(header) === given[index])) return locale;
  }
  return null;
}

function headerKey(cell: unknown): string {
  return (cellText(cell) ?? '').replace(/\s+/g, ' ').toLowerCase();
}

/** The text of a cell: a string, a number as written, a formula's result or rich text; else null. */
export function cellText(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'string') return cell.trim() === '' ? null : cell.trim();
  if (typeof cell === 'number') return Number.isFinite(cell) ? numberText(cell) : null;
  if (typeof cell === 'boolean' || cell instanceof Date) return null;
  if (typeof cell === 'object') {
    const record = cell as { result?: unknown; richText?: { text: string }[]; text?: unknown };
    if (Array.isArray(record.richText)) {
      return cellText(record.richText.map((part) => part.text).join(''));
    }
    if ('result' in record) return cellText(record.result);
    if (typeof record.text === 'string') return cellText(record.text);
  }
  return null;
}

/** A double as a plain decimal string (no exponent); null when it cannot be written as one. */
function numberText(value: number): string | null {
  const text = String(value);
  return /e/i.test(text) ? null : text;
}

/** Outcome of reading a price cell. */
export type ParsedPrice = { kind: 'EMPTY' } | { kind: 'INVALID' } | { kind: 'OK'; value: string };

/**
 * A price cell: a number, or a string number with a currency sign, spaces (thousands) and a comma
 * as the decimal mark ONLY when there is no dot (`12,5` -> 12.50; `1,250.50` -> 1250.50). More
 * than two fraction digits are refused, never rounded. The result has exactly two decimals.
 */
export function parsePriceCell(cell: unknown): ParsedPrice {
  const text = cellText(cell);
  // A number cell is never empty: one that cannot be written as a plain decimal is unreadable.
  if (text === null) return { kind: typeof cell === 'number' ? 'INVALID' : 'EMPTY' };
  // \p{Zs}: every space separator, the non-breaking space of a pasted "1 250" included.
  let cleaned = text.replace(/[$\s\p{Zs}]/gu, '');
  cleaned = cleaned.includes('.') ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { kind: 'INVALID' };
  // Leading zeros are a spelling, not a value: 012.5 is 12.50.
  const normalized = new Prisma.Decimal(cleaned).toFixed(2);
  return moneyStringSchema.safeParse(normalized).success
    ? { kind: 'OK', value: normalized }
    : { kind: 'INVALID' };
}

/** The cells of one data row (PRICE_IMPORT_COLUMNS order, then any extra) as the parser reads them. */
export function readRow(
  rowNumber: number,
  cells: readonly unknown[],
  wholesale: WholesaleColumnIndexes = NO_WHOLESALE_COLUMNS,
  alif: AlifColumnIndexes = NO_ALIF_COLUMNS,
): ImportRowInput {
  const at = (column: PriceImportColumn): unknown => cells[PRICE_IMPORT_COLUMNS.indexOf(column)];
  const issues: PriceImportRowIssue[] = [];
  const rawCode = cellText(at('productCode'));
  let productCode: string | null = null;
  if (rawCode !== null) {
    const parsed = productCodeSchema.safeParse(rawCode);
    if (parsed.success) productCode = parsed.data;
    else issues.push('CODE_FORMAT_INVALID');
  }
  const name = cellText(at('name')) ?? '';
  if (name === '') issues.push('NAME_MISSING');
  else if (name.length > PRODUCT_NAME_MAX_LENGTH) issues.push('NAME_TOO_LONG');
  const base = parsePriceCell(at('basePrice'));
  if (base.kind === 'EMPTY') issues.push('PRICE_MISSING');
  else if (base.kind === 'INVALID') issues.push('PRICE_INVALID');
  const deferred = parsePriceCell(at('deferredPrice'));
  if (deferred.kind === 'INVALID') issues.push('DEFERRED_PRICE_INVALID');
  const rrp = parsePriceCell(at('rrp'));
  if (rrp.kind === 'INVALID') issues.push('RRP_INVALID');
  const cellAt = (index: number | null): unknown => (index === null ? null : cells[index]);
  const wholesaleGiven = wholesale.wholesalePrice !== null;
  const wholesaleBase = parsePriceCell(cellAt(wholesale.wholesalePrice));
  if (wholesaleBase.kind === 'INVALID') issues.push('WHOLESALE_PRICE_INVALID');
  const wholesaleDeferred = parsePriceCell(cellAt(wholesale.wholesaleDeferredPrice));
  if (wholesaleDeferred.kind === 'INVALID') issues.push('WHOLESALE_DEFERRED_PRICE_INVALID');
  // A deferred column without the price column, or a deferred cell without a price cell.
  if (wholesaleDeferred.kind === 'OK' && wholesaleBase.kind !== 'OK') {
    issues.push('WHOLESALE_PRICE_MISSING');
  }
  const alifGiven = alif.alifPrice !== null;
  const alifBase = parsePriceCell(cellAt(alif.alifPrice));
  if (alifBase.kind === 'INVALID') issues.push('ALIF_PRICE_INVALID');
  const alifDeferred = parsePriceCell(cellAt(alif.alifDeferredPrice));
  if (alifDeferred.kind === 'INVALID') issues.push('ALIF_DEFERRED_PRICE_INVALID');
  if (alifDeferred.kind === 'OK' && alifBase.kind !== 'OK') issues.push('ALIF_PRICE_MISSING');
  // Free text, like the staff form's category: any label is accepted, only its length is limited.
  const category = cellText(at('category'));
  if (category !== null && category.length > PRODUCT_CATEGORY_MAX_LENGTH) {
    issues.push('CATEGORY_TOO_LONG');
  }
  return {
    rowNumber,
    // An unreadable code is kept as typed so the preview can show it next to the issue.
    productCode: productCode ?? rawCode,
    name,
    brandName: cellText(at('brand')),
    category,
    basePrice: base.kind === 'OK' ? base.value : null,
    deferredPrice: deferred.kind === 'OK' ? deferred.value : null,
    rrp: rrp.kind === 'OK' ? rrp.value : null,
    wholesalePrice: wholesaleBase.kind === 'OK' ? wholesaleBase.value : null,
    wholesaleDeferredPrice: wholesaleDeferred.kind === 'OK' ? wholesaleDeferred.value : null,
    wholesaleGiven,
    alifPrice: alifBase.kind === 'OK' ? alifBase.value : null,
    alifDeferredPrice: alifDeferred.kind === 'OK' ? alifDeferred.value : null,
    alifGiven,
    issues,
  };
}

/** True when a row has nothing in the template's columns (a blank line of the sheet). */
export function isBlankRow(
  cells: readonly unknown[],
  wholesale: WholesaleColumnIndexes = NO_WHOLESALE_COLUMNS,
  alif: AlifColumnIndexes = NO_ALIF_COLUMNS,
): boolean {
  // Only the recognised columns count: a note in an unrelated extra column is not a row.
  const indexes = [
    ...PRICE_IMPORT_COLUMNS.map((_, index) => index),
    ...[...Object.values(wholesale), ...Object.values(alif)].filter(
      (index): index is number => index !== null,
    ),
  ];
  return indexes.every((index) => cellText(cells[index]) === null);
}

// ---------------------------------------------------------------------------------------
// Judgement
// ---------------------------------------------------------------------------------------

const nameKey = (name: string): string => name.trim().toLowerCase();

/**
 * Judges the rows against the catalog and the published list: lookups, duplicates inside the file,
 * the status and the warnings. A row with any issue is ERROR and is never written.
 */
export function judgeRows(rows: readonly ImportRowInput[], context: ImportContext): JudgedRow[] {
  const codeCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.productCode !== null && !row.issues.includes('CODE_FORMAT_INVALID')) {
      const key = productCodeKey(row.productCode);
      codeCounts.set(key, (codeCounts.get(key) ?? 0) + 1);
    } else if (row.productCode === null && row.name !== '') {
      const key = nameKey(row.name);
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
  }
  const seenCodes = new Set<string>();
  return rows.map((row) => judgeRow(row, context, { codeCounts, nameCounts, seenCodes }));
}

function judgeRow(
  row: ImportRowInput,
  context: ImportContext,
  file: {
    codeCounts: ReadonlyMap<string, number>;
    nameCounts: ReadonlyMap<string, number>;
    seenCodes: Set<string>;
  },
): JudgedRow {
  let issues = [...row.issues];
  const warnings: PriceImportRowWarning[] = [];
  let product: ImportProductFact | null = null;
  let name = row.name;
  let category = row.category;
  const codeValid = row.productCode !== null && !issues.includes('CODE_FORMAT_INVALID');
  if (row.productCode !== null && codeValid) {
    const key = productCodeKey(row.productCode);
    // The later duplicate is the one reported; the first row keeps its verdict.
    if (file.seenCodes.has(key)) issues.push('DUPLICATE_CODE_IN_FILE');
    file.seenCodes.add(key);
    product = context.productsByCodeKey.get(key) ?? null;
    if (product === null) issues.push('UNKNOWN_PRODUCT_CODE');
    else if (product.mergedIntoProductId !== null) issues.push('PRODUCT_MERGED');
    else if (!product.isActive) issues.push('PRODUCT_INACTIVE');
    // A sheet product is never renamed by an import, so its name cell cannot be wrong: the preview
    // hands the client the stored name instead (the confirm request needs a usable one).
    if (product !== null && !product.codeGenerated && issues.some(isNameIssue)) {
      issues = issues.filter((issue) => !isNameIssue(issue));
      name = product.name;
    }
    // The category is given when a product is added and an import never changes it afterwards
    // (the sheet owns a sheet product's): the cell of an existing product is ignored, so it cannot
    // be wrong, and the preview shows no category for the row instead of one it will not store.
    if (product !== null) {
      issues = issues.filter((issue) => issue !== 'CATEGORY_TOO_LONG');
      category = null;
    }
  }
  let brandId: string | null = null;
  if (row.brandName !== null) {
    brandId = context.brandIdsByNameKey.get(nameKey(row.brandName)) ?? null;
    if (brandId === null) issues.push('UNKNOWN_BRAND');
  }
  if (row.productCode === null) {
    warnings.push('CODE_WILL_BE_GENERATED');
    if (row.name !== '') {
      const key = nameKey(row.name);
      if (context.activeNameKeys.has(key)) warnings.push('SAME_NAME_EXISTS');
      if ((file.nameCounts.get(key) ?? 0) > 1) warnings.push('DUPLICATE_NAME_IN_FILE');
    }
  }
  const current = product === null ? undefined : context.publishedPrices.get(product.id);
  return {
    brandId,
    currentName: product?.name ?? null,
    preview: {
      rowNumber: row.rowNumber,
      productCode: row.productCode,
      productId: product?.id ?? null,
      codeGenerated: product?.codeGenerated ?? null,
      name,
      brandName: row.brandName,
      category,
      basePrice: row.basePrice,
      deferredPrice: row.deferredPrice,
      rrp: row.rrp,
      wholesalePrice: row.wholesaleGiven ? row.wholesalePrice : null,
      wholesaleDeferredPrice: row.wholesaleGiven ? row.wholesaleDeferredPrice : null,
      wholesaleGiven: row.wholesaleGiven,
      alifPrice: row.alifGiven ? row.alifPrice : null,
      alifDeferredPrice: row.alifGiven ? row.alifDeferredPrice : null,
      alifGiven: row.alifGiven,
      currentBasePrice: current === undefined ? null : current.basePrice.toFixed(2),
      currentDeferredPrice: current?.deferredPrice?.toFixed(2) ?? null,
      currentRrp: current?.rrp?.toFixed(2) ?? null,
      currentWholesalePrice: current?.wholesalePrice?.toFixed(2) ?? null,
      currentWholesaleDeferredPrice: current?.wholesaleDeferredPrice?.toFixed(2) ?? null,
      currentAlifPrice: current?.alifPrice?.toFixed(2) ?? null,
      currentAlifDeferredPrice: current?.alifDeferredPrice?.toFixed(2) ?? null,
      status: statusOf(row, issues, product, current),
      issues,
      warnings,
    },
  };
}

const isNameIssue = (issue: PriceImportRowIssue): boolean =>
  issue === 'NAME_MISSING' || issue === 'NAME_TOO_LONG';

function statusOf(
  row: ImportRowInput,
  issues: readonly PriceImportRowIssue[],
  product: ImportProductFact | null,
  current: ImportPrices | undefined,
): PriceImportRowStatus {
  if (issues.length > 0) return 'ERROR';
  if (product === null) return 'NEW';
  if (
    current !== undefined &&
    row.basePrice !== null &&
    current.basePrice.equals(row.basePrice) &&
    sameOptional(current.deferredPrice, row.deferredPrice) &&
    sameOptional(current.rrp, row.rrp) &&
    (!row.wholesaleGiven ||
      (sameOptional(current.wholesalePrice, row.wholesalePrice) &&
        sameOptional(current.wholesaleDeferredPrice, row.wholesaleDeferredPrice))) &&
    (!row.alifGiven ||
      (sameOptional(current.alifPrice, row.alifPrice) &&
        sameOptional(current.alifDeferredPrice, row.alifDeferredPrice)))
  ) {
    return 'UNCHANGED';
  }
  return 'PRICE_CHANGED';
}

function sameOptional(a: Prisma.Decimal | null, b: string | null): boolean {
  if (a === null || b === null) return a === null && b === null;
  return a.equals(b);
}

/** The counts of the preview's summary. */
export function summarize(rows: readonly PriceImportPreviewRow[]): {
  newCount: number;
  priceChangedCount: number;
  unchangedCount: number;
  errorCount: number;
} {
  const count = (status: PriceImportRowStatus): number =>
    rows.filter((row) => row.status === status).length;
  return {
    newCount: count('NEW'),
    priceChangedCount: count('PRICE_CHANGED'),
    unchangedCount: count('UNCHANGED'),
    errorCount: count('ERROR'),
  };
}
