/** A table as a sheet hands it over: a header row and data rows of untrusted cells. */
export interface SheetTable {
  /** Header cells of the first row. Only the columns named in `SHEET_COLUMNS` are ever looked at. */
  readonly headers: readonly unknown[];
  /** Data rows, cells in the order of `headers`. Cells are text, as a sheet shows them. */
  readonly rows: readonly (readonly unknown[])[];
}

/**
 * Where delivery rows come from (the «Поставка» sheet). READ-ONLY BY CONSTRUCTION (hard rule
 * 10): the only method reads, and there is no write, append or update method for an
 * implementation to provide. The app never writes to the Google Sheet.
 *
 * The source returns an UNTRUSTED table: required columns are located by header name and every
 * row is validated with zod by the sync, row by row, so one broken row is reported instead of
 * failing the whole sync. A real implementation reads the one configured tab, and may return
 * more columns than we need: all except `SHEET_COLUMNS` are ignored and never stored or logged.
 */
export abstract class DeliveryCostSource {
  abstract readDeliveryTable(): Promise<SheetTable>;
}

/** Default wiring until the real client exists: fails loudly instead of syncing nothing. */
export class UnconfiguredDeliveryCostSource extends DeliveryCostSource {
  readDeliveryTable(): Promise<SheetTable> {
    return Promise.reject(new Error('No delivery cost source is configured'));
  }
}
