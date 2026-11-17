import { ORDER_STATUSES, type OrderStatus } from '@iorder/shared';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { holdsAnyGrantFor } from '../../common/auth/can.js';
import { scopeFor } from '../../common/auth/scope-for.js';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import { formatAmount } from './order-lines.js';
import { isStaffActor } from './order-actor.js';
import { seesFullOrderDetail } from './order-mapper.js';
import { OrdersRepository } from './orders.repository.js';

export interface StatusStat {
  count: number;
  oldestWaitingSince: Date | null;
}

/** Aggregates of the orders ONE staff actor may see. Plain data, no Prisma types. */
export interface OrderStats {
  /** Every status, zero-filled; hidden orders are simply not counted. */
  byStatus: Record<OrderStatus, StatusStat>;
  /** Goods to bring back: only for who can say they are back. */
  goodsToReturn: StatusStat | null;
  /** Money, payment and accounting facts: null for roles that may not see them. */
  full: {
    skippedAccountingToReview: StatusStat;
    unpaidDeliveredCount: number;
    today: { count: number; totalAmount: string };
  } | null;
}

export interface OrderStatsWindow {
  /** Inclusive start and exclusive end of "today" as UTC instants (the caller owns the zone). */
  from: Date;
  to: Date;
}

const EMPTY: StatusStat = Object.freeze({ count: 0, oldestWaitingSince: null });

function emptyByStatus(): Record<OrderStatus, StatusStat> {
  return Object.fromEntries(ORDER_STATUSES.map((status) => [status, EMPTY])) as Record<
    OrderStatus,
    StatusStat
  >;
}

/**
 * Dashboard aggregates over orders. The scope of VIEW_ORDER goes into every query, so a count
 * never includes an order the actor could not open; money, payment and accounting aggregates are
 * computed only for the roles whose order DTO carries those facts (manager, accountant, admin).
 */
@Injectable()
export class OrderStatsService {
  constructor(private readonly repository: OrdersRepository) {}

  async statsFor(actor: Actor, window: OrderStatsWindow): Promise<OrderStats> {
    // Customers have their own endpoints; this is a staff view.
    if (!isStaffActor(actor)) throw new ForbiddenError('Access denied');
    const scope = scopeFor(actor, 'VIEW_ORDER');
    const byStatus = emptyByStatus();
    if (scope.length === 0) return { byStatus, goodsToReturn: null, full: null };

    const full = seesFullOrderDetail(actor);
    const [groups, goodsToReturn, skipped, unpaid, today] = await Promise.all([
      this.repository.countByStatus(scope),
      holdsAnyGrantFor(actor, 'MARK_GOODS_RETURNED')
        ? this.repository.countGoodsToReturn(scope)
        : null,
      full ? this.repository.countSkippedUnreviewed(scope) : null,
      full ? this.repository.countUnpaidDelivered(scope) : null,
      full ? this.repository.sumSubmittedBetween(scope, window.from, window.to) : null,
    ]);
    for (const group of groups) {
      byStatus[group.status] = {
        count: group.count,
        oldestWaitingSince: group.oldestWaitingSince,
      };
    }
    if (skipped === null || unpaid === null || today === null) {
      return { byStatus, goodsToReturn, full: null };
    }
    return {
      byStatus,
      goodsToReturn,
      full: {
        skippedAccountingToReview: skipped,
        unpaidDeliveredCount: unpaid,
        today: { count: today.count, totalAmount: formatAmount(today.total) },
      },
    };
  }
}
