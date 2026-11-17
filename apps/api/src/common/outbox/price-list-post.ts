import { priceTierSchema, type PriceTier } from '@iorder/shared';
import { z } from 'zod';
import type { Tx } from '../database/db-client.js';

// The price list Excel file posted to every organization group ([C] 2026-10-28). It lives in the
// same outbox as the messages (status, retries, rate-limit handling are shared). The row is
// written by the pricing module (a manager's "send now" or the daily job); the notifications
// module builds the file at send time and sends it. This file sits in `common` so pricing can
// write the row without importing the notifications module (same pattern as kick-member.ts).
//
// Row shape: recipient_kind ORGANIZATION_CHAT with recipient_organization_id, no order. The chat
// is the organization's group, or a PERSON's private chat with the bot [C, owner 2026-11-11].

export const PRICE_LIST_POST_TYPE = 'PRICE_LIST_POST';

export const isPriceListPostType = (value: string): boolean => value === PRICE_LIST_POST_TYPE;

/**
 * The payload allow-list: what was asked to be sent. No cost data except the USD rate, which the
 * owner wants in the file and the caption (exception to "the rate is staff-only", 2026-10-28).
 * The file itself is built from the published list at send time.
 */
export const priceListPostPayloadSchema = z.strictObject({
  versionNumber: z.number().int().positive(),
  /** DD.MM.YYYY, the business day (Asia/Tashkent) the post was asked for. */
  dateLabel: z.string().regex(/^\d{2}\.\d{2}\.\d{4}$/),
  /** The USD rate setting as a decimal string, null when no rate is set. */
  usdRate: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .nullable(),
  /**
   * The organization's tier when the post was asked for (history). The file is built with the
   * tier the organization has at SEND time. Rows older than the tiers have none: STANDARD.
   */
  priceTier: priceTierSchema.default('STANDARD'),
});
export type PriceListPostPayload = z.infer<typeof priceListPostPayloadSchema>;

export interface PriceListPostRequest {
  recipients: readonly { organizationId: string; priceTier: PriceTier }[];
  /** Everything but the tier, which comes from each recipient. */
  payload: Omit<PriceListPostPayload, 'priceTier'>;
  /**
   * Unique per request ("send now": a fresh id, so each press sends again) or per business day
   * (the daily job: at most one post per group per day). The organization id is appended.
   */
  dedupePrefix: string;
}

/**
 * Adds one PRICE_LIST_POST row per organization, inside the caller's transaction. A row whose
 * dedupe key exists already is skipped (ON CONFLICT DO NOTHING). Returns how many were added.
 */
export async function enqueuePriceListPosts(
  tx: Tx,
  request: PriceListPostRequest,
  now: Date,
): Promise<number> {
  if (request.recipients.length === 0) return 0;
  const result = await tx.notificationOutbox.createMany({
    data: request.recipients.map(({ organizationId, priceTier }) => ({
      type: PRICE_LIST_POST_TYPE,
      recipientKind: 'ORGANIZATION_CHAT' as const,
      recipientOrganizationId: organizationId,
      payload: { ...request.payload, priceTier } satisfies PriceListPostPayload,
      dedupeKey: `${request.dedupePrefix}:${organizationId}`,
      createdAt: now,
    })),
    skipDuplicates: true,
  });
  return result.count;
}
