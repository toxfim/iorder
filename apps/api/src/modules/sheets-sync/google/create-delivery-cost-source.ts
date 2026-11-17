import { DeliveryCostSource, UnconfiguredDeliveryCostSource } from '../delivery-cost-source.js';
import { isSheetSourceConfigured, type Env } from '../../../config/env.js';
import { GoogleSheetsDeliveryCostSource } from './google-sheets-delivery-cost-source.js';
import { GoogleTokenProvider } from './google-token-provider.js';
import type { HttpFetch } from './http.js';
import { createFileKeyReader } from './service-account-key.js';

type SheetEnv = Pick<
  Env,
  'GOOGLE_SERVICE_ACCOUNT_FILE' | 'GOOGLE_SHEET_ID' | 'GOOGLE_SHEET_SUPPLIES_TAB'
>;

/**
 * The real Google source ONLY when the key file, the sheet id and the tab are all configured;
 * otherwise the unconfigured one, which fails loudly. Building the source reads nothing: the key
 * file is read, and Google contacted, on the first `readDeliveryTable`.
 */
export function createDeliveryCostSource(
  env: SheetEnv,
  fetchImpl: HttpFetch = globalThis.fetch,
  nowMs: () => number = Date.now,
): DeliveryCostSource {
  if (
    !isSheetSourceConfigured(env) ||
    env.GOOGLE_SERVICE_ACCOUNT_FILE === undefined ||
    env.GOOGLE_SHEET_ID === undefined ||
    env.GOOGLE_SHEET_SUPPLIES_TAB === undefined
  ) {
    return new UnconfiguredDeliveryCostSource();
  }
  const tokens = new GoogleTokenProvider(
    createFileKeyReader(env.GOOGLE_SERVICE_ACCOUNT_FILE),
    fetchImpl,
    nowMs,
  );
  return new GoogleSheetsDeliveryCostSource(tokens, fetchImpl, {
    spreadsheetId: env.GOOGLE_SHEET_ID,
    tab: env.GOOGLE_SHEET_SUPPLIES_TAB,
  });
}
