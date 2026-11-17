import { publishChangesRequestSchema, upsertItemsRequestSchema } from '@iorder/shared';
import { Prisma } from '../../../generated/prisma/client.js';

const optionalDecimal = (value: string | null): Prisma.Decimal | null =>
  value === null ? null : new Prisma.Decimal(value);

/** undefined stays undefined: for the wholesale and Alif tiers an omitted price means "keep the current". */
const keptOrDecimal = (value: string | null | undefined): Prisma.Decimal | null | undefined =>
  value === undefined ? undefined : optionalDecimal(value);

/** One validated item: every price a Decimal, an absent optional price null. */
function toPricedItem(item: {
  productId: string;
  basePrice: string;
  deferredPrice: string | null;
  rrp: string | null;
  wholesalePrice?: string | null | undefined;
  wholesaleDeferredPrice?: string | null | undefined;
  alifPrice?: string | null | undefined;
  alifDeferredPrice?: string | null | undefined;
}): {
  productId: string;
  basePrice: Prisma.Decimal;
  deferredPrice: Prisma.Decimal | null;
  rrp: Prisma.Decimal | null;
  wholesalePrice?: Prisma.Decimal | null | undefined;
  wholesaleDeferredPrice?: Prisma.Decimal | null | undefined;
  alifPrice?: Prisma.Decimal | null | undefined;
  alifDeferredPrice?: Prisma.Decimal | null | undefined;
} {
  return {
    productId: item.productId,
    basePrice: new Prisma.Decimal(item.basePrice),
    deferredPrice: optionalDecimal(item.deferredPrice),
    rrp: optionalDecimal(item.rrp),
    wholesalePrice: keptOrDecimal(item.wholesalePrice),
    wholesaleDeferredPrice: keptOrDecimal(item.wholesaleDeferredPrice),
    alifPrice: keptOrDecimal(item.alifPrice),
    alifDeferredPrice: keptOrDecimal(item.alifDeferredPrice),
  };
}

/**
 * The shared request schema (validation rules live ONLY in @iorder/shared) plus the api-side
 * step that turns the validated decimal strings into Decimal, so no float exists after the
 * boundary (hard rule 1). The service works with Decimal.
 */
export const upsertItemsSchema = upsertItemsRequestSchema.transform((request) => ({
  items: request.items.map(toPricedItem),
}));
export type UpsertItemsInput = ReturnType<(typeof upsertItemsSchema)['parse']>;

/** Same boundary step for the no-draft publish: decimal strings in, Decimal out. */
export const publishChangesSchema = publishChangesRequestSchema.transform((request) => ({
  baseVersionNumber: request.baseVersionNumber,
  upserts: request.upserts.map(toPricedItem),
  removedProductIds: request.removedProductIds,
}));
export type PublishChangesInput = ReturnType<(typeof publishChangesSchema)['parse']>;
