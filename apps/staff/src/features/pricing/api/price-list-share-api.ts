import type { PriceTier } from '@iorder/shared';
import {
  BRAND_ROUTES,
  priceListPostRecipientsResponseSchema,
  priceListPostResponseSchema,
  type PriceListPostRecipientsResponse,
  type PriceListPostResponse,
} from '@iorder/shared/staff-cost';
import type { DownloadedFile, HttpClient } from '@core/lib/http-client';

/** The published price list as the file the chats receive, and sending it to them now. */
export interface PriceListShareApi {
  /**
   * The .xlsx of the published list in one price tier [C, owner 2026-11-11] (every staff role that
   * reads the staff price list).
   */
  downloadExcel: (tier: PriceTier) => Promise<DownloadedFile>;
  /** Who a post would reach now, by tier and by chat kind, and who it skips (manager, admin). */
  recipients: () => Promise<PriceListPostRecipientsResponse>;
  /** Queues each organization the file of its own tier (manager and admin). */
  postToGroups: () => Promise<PriceListPostResponse>;
}

export function createHttpPriceListShareApi(http: HttpClient): PriceListShareApi {
  return {
    downloadExcel: (tier) =>
      http.requestFile(BRAND_ROUTES.downloadPriceListExcel, { query: { tier } }),
    recipients: () =>
      http.request(BRAND_ROUTES.priceListPostRecipients, priceListPostRecipientsResponseSchema),
    postToGroups: () =>
      http.request(BRAND_ROUTES.postPriceListToGroups, priceListPostResponseSchema),
  };
}
