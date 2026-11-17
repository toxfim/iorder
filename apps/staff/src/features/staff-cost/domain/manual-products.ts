import type { ConflictReason } from '@iorder/shared';
import {
  PRICE_IMPORT_FILE_ERRORS,
  PRICE_IMPORT_MAX_BYTES,
  PRICE_IMPORT_ROW_ISSUES,
  type PriceImportFileError,
  type PriceImportPreviewRow,
  type PriceImportRowIssue,
  type MergePreviewResponse,
  type PriceImportRowRequest,
} from '@iorder/shared/staff-cost';
import { ApiConflictError, ApiNotFoundError, ApiValidationError } from '@core/lib/api-errors';
import { describePricingError, type DescribedError } from '@core/lib/price-errors';
import { sameMoney } from '@/features/pricing/domain/price-input';

// Pure helpers of the staff-added products screens [C, 2026-11-09]: what an import confirm sends,
// how the api's refusals are read, and the texts of their errors. Staff-only (cost chunk).

/** The `accept` attribute of the import file input: the .xlsx extension and its media type. */
export const PRICE_IMPORT_ACCEPT =
  '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The upload limit as the hint shows it. */
export const PRICE_IMPORT_MAX_MB = Math.round(PRICE_IMPORT_MAX_BYTES / (1024 * 1024));

/** A quick check before the upload; the server reads the bytes and decides again. */
export function checkImportFile(file: {
  readonly name: string;
  readonly size: number;
}): PriceImportFileError | null {
  if (!file.name.toLowerCase().endsWith('.xlsx')) return 'FILE_NOT_XLSX';
  if (file.size > PRICE_IMPORT_MAX_BYTES) return 'FILE_TOO_LARGE';
  return null;
}

/** The rows a confirm may send: everything the preview did not refuse, with a price to send. */
export function importableRows(rows: readonly PriceImportPreviewRow[]): PriceImportPreviewRow[] {
  return rows.filter((row) => row.status !== 'ERROR' && row.basePrice !== null);
}

/** How many preview rows the check screen shows before "Hammasini ko'rsatish" (design 2026-11-09). */
export const PREVIEW_ROWS_SHOWN = 7;

/**
 * The check screen's order: the rows that will be skipped first (so the person sees what to fix),
 * then the rest; each group keeps the file's order.
 */
export function orderPreviewRows<T extends PriceImportPreviewRow>(
  rows: readonly T[],
  isError: (row: T) => boolean,
): T[] {
  return [...rows.filter(isError), ...rows.filter((row) => !isError(row))];
}

/**
 * The columns of the error rows file, in order (translated by the caller): the row number, the
 * template's seven columns in the template's order, then what is wrong.
 */
export const ERROR_ROWS_CSV_COLUMNS = [
  'row',
  'code',
  'name',
  'brand',
  'category',
  'price',
  'deferred',
  'rrp',
  'issue',
] as const;
export type ErrorRowsCsvColumn = (typeof ERROR_ROWS_CSV_COLUMNS)[number];

const UTF8_BOM = '﻿';
const CSV_SEPARATOR = ';';

/** Quoted only when needed; a quote inside is doubled, like Excel writes it. */
function csvCell(value: string): string {
  return /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The error rows as a CSV the person opens in Excel to fix them: UTF-8 with a byte order mark (so
 * Excel reads the Cyrillic headers), `;` separated (so Excel in a comma-decimal locale splits the
 * columns), CRLF lines. Built in the browser from the preview; nothing is asked of the api.
 */
export function errorRowsCsv(
  rows: readonly PriceImportPreviewRow[],
  headers: Readonly<Record<ErrorRowsCsvColumn, string>>,
  issueText: (row: PriceImportPreviewRow) => string,
): string {
  const line = (cells: readonly string[]): string => cells.map(csvCell).join(CSV_SEPARATOR);
  const lines = [
    line(ERROR_ROWS_CSV_COLUMNS.map((column) => headers[column])),
    ...rows.map((row) =>
      line([
        String(row.rowNumber),
        row.productCode ?? '',
        row.name,
        row.brandName ?? '',
        row.category ?? '',
        row.basePrice ?? '',
        row.deferredPrice ?? '',
        row.rrp ?? '',
        issueText(row),
      ]),
    ),
  ];
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

/**
 * True when the import replaces a published price with a different one (or removes it): the
 * preview then shows the old amount struck through next to the new one.
 */
export function replacesPrice(current: string | null, next: string | null): boolean {
  if (current === null) return false;
  return next === null || !sameMoney(current, next);
}

/** The confirm request rows, in the preview's order (the api repeats every check on them). */
export function toConfirmRows(rows: readonly PriceImportPreviewRow[]): PriceImportRowRequest[] {
  return importableRows(rows).map((row) => ({
    productCode: row.productCode,
    name: row.name,
    brandName: row.brandName,
    // The preview already dropped the category of an existing product (it is never changed).
    category: row.category,
    // Filtered above: a row without a price is never importable.
    basePrice: row.basePrice ?? '0',
    deferredPrice: row.deferredPrice,
    rrp: row.rrp,
    // Only a file with the «Оптовик/Партнер» columns sets them; otherwise they are kept.
    ...(row.wholesaleGiven
      ? { wholesalePrice: row.wholesalePrice, wholesaleDeferredPrice: row.wholesaleDeferredPrice }
      : {}),
    // The same for the «Alif factoring» columns [C, owner 2026-11-12].
    ...(row.alifGiven
      ? { alifPrice: row.alifPrice, alifDeferredPrice: row.alifDeferredPrice }
      : {}),
  }));
}

const isFileError = (value: unknown): value is PriceImportFileError =>
  typeof value === 'string' && (PRICE_IMPORT_FILE_ERRORS as readonly string[]).includes(value);

/**
 * The reason a whole file was refused (422 PRICE_IMPORT_FILE_INVALID with `details.reason`); null
 * for any other error.
 */
export function fileErrorOf(error: unknown): PriceImportFileError | null {
  if (!(error instanceof ApiValidationError) || error.code !== 'PRICE_IMPORT_FILE_INVALID') {
    return null;
  }
  const reason = reasonOf(error.details);
  return isFileError(reason) ? reason : null;
}

/** `details.reason` of an error body, whatever its type; undefined when there is none. */
function reasonOf(details: unknown): unknown {
  if (typeof details !== 'object' || details === null || !('reason' in details)) return undefined;
  return details.reason;
}

export interface InvalidImportRow {
  /** Position in the confirm request's `rows`. */
  readonly index: number;
  readonly issues: readonly PriceImportRowIssue[];
}

const isRowIssue = (value: unknown): value is PriceImportRowIssue =>
  typeof value === 'string' && (PRICE_IMPORT_ROW_ISSUES as readonly string[]).includes(value);

/**
 * The rows a confirm refused (422 IMPORT_ROWS_INVALID, `details.rows` = row index + issues).
 * Unknown issue codes are dropped, an unreadable payload gives an empty list.
 */
export function invalidRowsOf(error: unknown): InvalidImportRow[] {
  if (!(error instanceof ApiValidationError) || error.code !== 'IMPORT_ROWS_INVALID') return [];
  const details: unknown = error.details;
  if (typeof details !== 'object' || details === null || !('rows' in details)) return [];
  const rows: unknown = details.rows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown) => {
    if (typeof row !== 'object' || row === null) return [];
    const index = 'index' in row ? row.index : undefined;
    const issues = 'issues' in row && Array.isArray(row.issues) ? row.issues : [];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return [];
    return [{ index, issues: issues.filter(isRowIssue) }];
  });
}

/** What the merge dialog says about the sheet product: pieces (3 fraction digits) and USD cost. */
export interface MergeTargetFacts {
  readonly stock: string | null;
  readonly cost: string | null;
}

/**
 * Reads the stock and cost of the preview's target here, in the staff-cost chunk: the cost
 * contract's field names must not land in a page chunk (hard rule 7, scripts/check-bundle.mjs).
 */
export function mergeTargetFacts(target: MergePreviewResponse['target']): MergeTargetFacts {
  return { stock: target.stockQuantity, cost: target.costUsd };
}

/** The 409 that means "someone published meanwhile": the owner reloads and the person retries. */
export const isStalePriceList = (error: unknown): boolean =>
  error instanceof ApiConflictError && error.reason === 'PRICE_LIST_CHANGED';

/**
 * The texts of the manual product calls. The brand of a new product may be gone (404 NOT_FOUND
 * with `details.reason = UNKNOWN_BRAND`); everything else is the shared pricing mapping.
 */
export function describeManualProductError(error: unknown): DescribedError {
  if (error instanceof ApiNotFoundError && reasonOf(error.details) === 'UNKNOWN_BRAND') {
    return { key: 'staffCost.manual.unknownBrand' };
  }
  return describePricingError('publish', error);
}

/** The merge-only conflict reasons, each with its own text. */
const MERGE_REASONS = [
  'NOT_GENERATED_CODE',
  'TARGET_IS_GENERATED',
  'PRODUCT_ALREADY_MERGED',
] as const satisfies readonly ConflictReason[];
type MergeReason = (typeof MERGE_REASONS)[number];

const isMergeReason = (value: ConflictReason | undefined): value is MergeReason =>
  value !== undefined && (MERGE_REASONS as readonly string[]).includes(value);

export function describeMergeError(error: unknown): DescribedError {
  if (error instanceof ApiConflictError && isMergeReason(error.reason)) {
    return { key: `staffCost.merge.errors.${error.reason}` };
  }
  return describePricingError('publish', error);
}
