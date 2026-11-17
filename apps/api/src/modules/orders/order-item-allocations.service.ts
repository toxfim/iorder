import { Injectable } from '@nestjs/common';
import type { DbClient } from '../../common/database/db-client.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { SupplyAllocationService, SupplyPartyService } from '../pricing/index.js';
import { OrdersRepository } from './orders.repository.js';

export interface OrderItemAllocationView {
  supplyRef: string;
  partyNumber: string | null;
  quantity: Prisma.Decimal;
}

/** Per order line; a line without an entry has no allocation. */
export type ItemAllocations = ReadonlyMap<string, readonly OrderItemAllocationView[]>;

/**
 * Which supply and party each piece of ONE order comes from. One order per call: the lists carry no
 * items and a queue card reads its order when it opens, so this never runs per row of a list. The
 * caller authorizes. Party numbers are read live, not copied: a number set later shows here too.
 */
@Injectable()
export class OrderItemAllocationsService {
  constructor(
    private readonly supply: SupplyAllocationService,
    private readonly parties: SupplyPartyService,
    private readonly orders: OrdersRepository,
  ) {}

  async ofOrder(orderId: string, db: DbClient = this.orders.db): Promise<ItemAllocations> {
    const rows = await this.supply.standingSupplies(db, orderId);
    const refs = [...new Set(rows.map((row) => row.deliveryRef))];
    const partyOf = await this.parties.partyNumbersByRefs(refs, db);
    const byItem = new Map<string, OrderItemAllocationView[]>();
    for (const row of rows) {
      const list = byItem.get(row.orderItemId) ?? [];
      list.push({
        supplyRef: row.deliveryRef,
        partyNumber: partyOf.get(row.deliveryRef) ?? null,
        quantity: row.quantity,
      });
      byItem.set(row.orderItemId, list);
    }
    return byItem;
  }
}
