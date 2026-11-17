import { z } from 'zod';
import { decimalPattern, isoInstantSchema, languageCodeSchema } from './common.js';
import { route } from './routes.js';

// STAFF-ONLY, manager only ([C] 2026-10-30): a party number on a whole supply (`delivery_ref`, the
// sheet's «ID заявки»). Several supplies can share a party; a supply has one party. Exported from
// the staff-cost entry only. No cost and no supplier here: a row is described by its products.

export const PARTY_NUMBER_MAX_LENGTH = 32;
/** How many supplies one save may touch; far above a real party. */
export const MAX_SUPPLIES_PER_PARTY_SAVE = 100;
/** How many rows one search returns; `total` tells how many matched. */
export const SUPPLY_SEARCH_LIMIT = 50;
/** How many product names a row carries (a supply can hold dozens of products). */
export const SUPPLY_PRODUCT_NAMES_SHOWN = 3;

/** Trimmed text compared exactly: "7" and "07" are two parties. */
export const partyNumberSchema = z.string().trim().min(1).max(PARTY_NUMBER_MAX_LENGTH);

const deliveryRefSchema = z.string().min(1).max(200);

export const supplySearchQuerySchema = z.strictObject({
  search: z.string().trim().max(100).optional(),
});
export type SupplySearchQuery = z.output<typeof supplySearchQuerySchema>;

/** One supply: its live delivery lines grouped by `delivery_ref`. */
export const supplySummarySchema = z.strictObject({
  deliveryRef: z.string(),
  productCount: z.number().int().positive(),
  /** The first few products, each with its names by language. */
  products: z
    .array(
      z.strictObject({
        productCode: z.string(),
        names: z.array(z.strictObject({ lang: languageCodeSchema, name: z.string() })),
      }),
    )
    .max(SUPPLY_PRODUCT_NAMES_SHOWN),
  totalQuantity: z.string().regex(decimalPattern(15, 3)),
  /** The newest delivery day of the supply. */
  deliveredAt: isoInstantSchema,
  partyNumber: z.string().nullable(),
});
export type SupplySummary = z.infer<typeof supplySummarySchema>;

export const supplyListResponseSchema = z.strictObject({
  items: z.array(supplySummarySchema).max(SUPPLY_SEARCH_LIMIT),
  total: z.number().int().nonnegative(),
});
export type SupplyListResponse = z.infer<typeof supplyListResponseSchema>;

/** The party a supply had when the manager saw it. */
export const supplyPartyStateSchema = z.strictObject({
  deliveryRef: z.string(),
  partyNumber: z.string().nullable(),
});
export type SupplyPartyState = z.infer<typeof supplyPartyStateSchema>;

export const SUPPLY_CONFLICT_ANSWERS = ['REPLACE'] as const;
export const PARTY_CONFLICT_ANSWERS = ['ADD', 'REPLACE_MEMBERS'] as const;
export type PartyConflictAnswer = (typeof PARTY_CONFLICT_ANSWERS)[number];

/**
 * `seenParties` is what the manager's screen showed, one per chosen supply: a difference is
 * 409 SUPPLY_PARTY_CHANGED, so nobody overwrites a change they never saw. The answers come from a
 * 409 SUPPLY_PARTY_CONFLICT; `seenPartyMembers` goes with the party answer for the same reason.
 */
export const setSupplyPartyRequestSchema = z
  .strictObject({
    deliveryRefs: z.array(deliveryRefSchema).min(1).max(MAX_SUPPLIES_PER_PARTY_SAVE),
    partyNumber: partyNumberSchema,
    seenParties: z.array(supplyPartyStateSchema).max(MAX_SUPPLIES_PER_PARTY_SAVE),
    onSupplyConflict: z.enum(SUPPLY_CONFLICT_ANSWERS).optional(),
    onPartyConflict: z.enum(PARTY_CONFLICT_ANSWERS).optional(),
    seenPartyMembers: z.array(deliveryRefSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.deliveryRefs).size !== value.deliveryRefs.length) {
      ctx.addIssue({ code: 'custom', path: ['deliveryRefs'], message: 'Duplicate supply' });
    }
    const seen = new Set(value.seenParties.map((s) => s.deliveryRef));
    if (seen.size !== value.deliveryRefs.length || value.deliveryRefs.some((r) => !seen.has(r))) {
      ctx.addIssue({
        code: 'custom',
        path: ['seenParties'],
        message: 'One seen party per chosen supply',
      });
    }
    if ((value.onPartyConflict === undefined) !== (value.seenPartyMembers === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['seenPartyMembers'],
        message: 'The party answer goes with the members the manager saw',
      });
    }
  });
export type SetSupplyPartyRequest = z.input<typeof setSupplyPartyRequestSchema>;

export const setSupplyPartyResponseSchema = z.strictObject({
  /** NOTHING_TO_DO: every chosen supply already has this party and nothing was written. */
  outcome: z.enum(['CHANGED', 'NOTHING_TO_DO']),
  partyNumber: z.string(),
  changed: z.array(
    z.strictObject({
      deliveryRef: z.string(),
      from: z.string().nullable(),
      to: z.string(),
    }),
  ),
  /** Chosen supplies that already had this party. */
  alreadySet: z.array(z.string()),
  /** Supplies that left the party (REPLACE_MEMBERS). */
  removedFromParty: z.array(z.string()),
});
export type SetSupplyPartyResponse = z.infer<typeof setSupplyPartyResponseSchema>;

/** `details` of 409 SUPPLY_PARTY_CONFLICT: both lists can be filled at once. */
export const supplyPartyConflictDetailsSchema = z.strictObject({
  /** Chosen supplies that have another party. */
  supplyConflicts: z.array(z.strictObject({ deliveryRef: z.string(), partyNumber: z.string() })),
  /** Other supplies that already have this party. */
  partyMembers: z.array(z.string()),
});
export type SupplyPartyConflictDetails = z.infer<typeof supplyPartyConflictDetailsSchema>;

/** `details` of 409 SUPPLY_PARTY_CHANGED: how things stand now. */
export const supplyPartyChangedDetailsSchema = z.strictObject({
  parties: z.array(supplyPartyStateSchema),
  partyMembers: z.array(z.string()),
});
export type SupplyPartyChangedDetails = z.infer<typeof supplyPartyChangedDetailsSchema>;

/** `details` of 409 SUPPLY_NOT_AVAILABLE: chosen supplies with no live delivery line left. */
export const supplyNotAvailableDetailsSchema = z.strictObject({
  deliveryRefs: z.array(z.string()),
});

export const SUPPLY_PARTY_ROUTES = Object.freeze({
  /** Live supplies, newest first, searched by supply id. Manager only. */
  listSupplies: route('GET', '/staff/supplies'),
  /** Sets one party number on the chosen supplies. Manager only. */
  setSupplyParty: route('PUT', '/staff/supply-parties'),
});
