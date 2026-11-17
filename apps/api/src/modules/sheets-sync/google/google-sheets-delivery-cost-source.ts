import { z } from 'zod';
import { DeliveryCostSource, type SheetTable } from '../delivery-cost-source.js';
import type { GoogleTokenProvider } from './google-token-provider.js';
import { GOOGLE_SHEETS_TIMEOUT_MS, type HttpFetch } from './http.js';
import { SheetReadError } from './sheet-read-error.js';

export const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
/** Columns A to CZ: wider than the real sheet, so a column added later is still inside the range. */
export const SHEET_RANGE_COLUMNS = 'A:CZ';
/** A sane ceiling for the supplies tab. More than this fails loudly instead of syncing a guess. */
export const MAX_SHEET_DATA_ROWS = 50_000;
/** A hard cap on the raw response, before it is parsed. */
export const MAX_RESPONSE_CHARS = 64_000_000;

// FORMATTED_VALUE returns every cell as the text the sheet displays (the formats confirmed
// 2026-10-21: en-US numbers, DD/MM/YYYY HH:MM:SS dates). A non-string cell means the render option
// was not honoured, and the strict parsers downstream would reject it anyway.
const valuesResponseSchema = z.object({
  values: z.array(z.array(z.string())).optional(),
});

const quotaErrorSchema = z.object({
  error: z.object({
    status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

const QUOTA_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

/** A 403 is either "no access" or a rate limit; the structured reason tells them apart. */
function isQuotaBody(body: string): boolean {
  try {
    const parsed = quotaErrorSchema.parse(JSON.parse(body)).error;
    return (
      parsed.status === 'RESOURCE_EXHAUSTED' ||
      (parsed.errors ?? []).some((e) => e.reason !== undefined && QUOTA_REASONS.has(e.reason))
    );
  } catch {
    return false;
  }
}

function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === '');
}

/**
 * The supplies tab as a table: row 1 are the headers, the rest are data rows. The API leaves out
 * trailing empty cells, so short rows are padded with empty text up to the header width, and
 * trailing blank rows are dropped.
 */
export function toSheetTable(values: readonly (readonly string[])[]): SheetTable {
  const [headers, ...rest] = values;
  if (headers === undefined || isBlankRow(headers)) throw new SheetReadError('MALFORMED');
  let end = rest.length;
  while (end > 0 && isBlankRow(rest[end - 1] ?? [])) end -= 1;
  if (end > MAX_SHEET_DATA_ROWS) throw new SheetReadError('MALFORMED');
  const width = headers.length;
  const rows = rest
    .slice(0, end)
    .map((row) =>
      row.length >= width ? row : [...row, ...Array<string>(width - row.length).fill('')],
    );
  return { headers, rows };
}

/**
 * Reads the «Поставка» tab through the Google Sheets REST API with a service account that has the
 * READ-ONLY scope. READ-ONLY BY CONSTRUCTION: the only request is a GET of a values range and the
 * token carries `spreadsheets.readonly`, so even a bug cannot write (hard rule 10).
 *
 * Errors are `SheetReadError`s only: no response body, no cell contents, no token or key.
 */
export class GoogleSheetsDeliveryCostSource extends DeliveryCostSource {
  constructor(
    private readonly tokens: GoogleTokenProvider,
    private readonly fetchImpl: HttpFetch,
    private readonly config: { spreadsheetId: string; tab: string },
    private readonly timeoutMs: number = GOOGLE_SHEETS_TIMEOUT_MS,
  ) {
    super();
  }

  /** Exposed for the test of the exact request; the id and the tab are URL-encoded. */
  buildUrl(): string {
    // A tab name is quoted in A1 notation (names with spaces or quotes need it); ' is doubled.
    const range = `'${this.config.tab.replaceAll("'", "''")}'!${SHEET_RANGE_COLUMNS}`;
    const query = new URLSearchParams({
      valueRenderOption: 'FORMATTED_VALUE',
      majorDimension: 'ROWS',
    });
    return `${SHEETS_API_BASE}/${encodeURIComponent(this.config.spreadsheetId)}/values/${encodeURIComponent(range)}?${query.toString()}`;
  }

  async readDeliveryTable(): Promise<SheetTable> {
    const first = await this.request();
    if (first.status !== 401) return this.interpret(first.status, first.body);
    // A cached token can be revoked or expire early: take a fresh one and try once more.
    this.tokens.invalidate();
    const second = await this.request();
    return this.interpret(second.status, second.body);
  }

  private async request(): Promise<{ status: number; body: string }> {
    const token = await this.tokens.getAccessToken();
    let response;
    try {
      response = await this.fetchImpl(this.buildUrl(), {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SheetReadError('NETWORK');
    }
    return { status: response.status, body: await this.readBody(response) };
  }

  private async readBody(response: { text(): Promise<string> }): Promise<string> {
    try {
      return await response.text();
    } catch {
      throw new SheetReadError('NETWORK');
    }
  }

  private interpret(status: number, body: string): SheetTable {
    if (status === 401) throw new SheetReadError('AUTH');
    if (status === 429) throw new SheetReadError('QUOTA');
    if (status === 403) throw new SheetReadError(isQuotaBody(body) ? 'QUOTA' : 'NOT_FOUND');
    // 400 is what Google answers for a range on a tab that does not exist.
    if (status === 404 || status === 400) throw new SheetReadError('NOT_FOUND');
    if (status >= 500) throw new SheetReadError('NETWORK');
    if (status !== 200 || body.length > MAX_RESPONSE_CHARS) throw new SheetReadError('MALFORMED');

    let values;
    try {
      values = valuesResponseSchema.parse(JSON.parse(body)).values;
    } catch {
      throw new SheetReadError('MALFORMED');
    }
    if (values === undefined) throw new SheetReadError('MALFORMED');
    return toSheetTable(values);
  }
}
