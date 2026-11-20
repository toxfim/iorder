import {
  CUSTOMER_ORDER_GROUP_STATUSES,
  DEFAULT_ORDER_PAGE_SIZE,
  type OrderStatus,
} from '@iorder/shared';
import type { StaffOrderCountsQuery, StaffOrderListQuery } from '@iorder/shared/staff-orders';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { scopeFor } from '../../common/auth/scope-for.js';
import { businessDayOf } from '../../common/clock/business-time.js';
import { Clock } from '../../common/clock/clock.js';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import { IdentityService } from '../identity/index.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { OrganizationsService } from '../organizations/index.js';
import { toUzs, UsdRateService } from '../pricing/index.js';
import { formatAmount } from './order-lines.js';
import { isStaffActor } from './order-actor.js';
import { seesFullOrderDetail, toOrderSummary } from './order-mapper.js';
import type { OrderPage } from './order.views.js';
import { OrdersRepository, type OrderMatchQuery } from './orders.repository.js';

export interface StatusCount {
  count: number;
  /** FULL roles only. */
  totalAmount?: string;
  totalUsd?: string;
  totalUzsEquivalent?: string | null;
}

export interface OrderCounts {
  byStatus: Partial<Record<OrderStatus, StatusCount>>;
  /** Only when grouped by organization. */
  byOrganization?: Record<string, StatusCount>;
}

/** A USD sum in whole so'm at the current rate, like the balance's equivalents; null without a rate. */
function uzsOf(usd: Prisma.Decimal, usdRate: Prisma.Decimal | null): string | null {
  const uzs = toUzs(usd, 'USD', usdRate);
  return uzs === null ? null : formatAmount(uzs);
}

/**
 * The staff order list, filtered and paged on the server so a phone never downloads the whole
 * history, and its per-status counts over the same filters (the stage tabs). The scope of
 * VIEW_ORDER goes into every query, so neither the list nor a count includes an order the actor
 * could not open.
 */
@Injectable()
export class StaffOrderListService {
  constructor(
    private readonly repository: OrdersRepository,
    private readonly organizations: OrganizationsService,
    private readonly identity: IdentityService,
    private readonly usdRate: UsdRateService,
    private readonly clock: Clock,
  ) {}

  async list(actor: Actor, query: StaffOrderListQuery): Promise<OrderPage> {
    const match = await this.match(actor, query);
    if (match === null) return { orders: [], nextCursor: null };
    const page = await this.repository.list({
      ...match,
      ...statusFilter(query),
      limit: query.limit ?? DEFAULT_ORDER_PAGE_SIZE,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const last = page.rows[page.rows.length - 1];
    return {
      orders: page.rows.map((row) => toOrderSummary(row, actor)),
      nextCursor: page.hasMore && last ? last.id : null,
    };
  }

  async counts(actor: Actor, query: StaffOrderCountsQuery): Promise<OrderCounts> {
    const byOrganization = query.groupBy === 'ORGANIZATION';
    const match = await this.match(actor, query);
    if (match === null)
      return byOrganization ? { byStatus: {}, byOrganization: {} } : { byStatus: {} };
    const scoped = {
      ...match,
      ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
    };
    // Money is part of the FULL view only.
    const full = seesFullOrderDetail(actor);
    const [statuses, organizations, usdRate] = await Promise.all([
      this.repository.countMatching(scoped),
      byOrganization ? this.repository.countMatchingByOrganization(scoped) : null,
      full ? this.usdRate.readRateOrNull() : null,
    ]);
    const counted = (group: {
      count: number;
      total: Prisma.Decimal;
      totalUsd: Prisma.Decimal;
    }): StatusCount =>
      full
        ? {
            count: group.count,
            totalAmount: formatAmount(group.total),
            totalUsd: formatAmount(group.totalUsd),
            totalUzsEquivalent: uzsOf(group.totalUsd, usdRate),
          }
        : { count: group.count };
    return {
      byStatus: Object.fromEntries(statuses.map((group) => [group.status, counted(group)])),
      ...(organizations === null
        ? {}
        : {
            byOrganization: Object.fromEntries(
              organizations.map((group) => [group.organizationId, counted(group)]),
            ),
          }),
    };
  }

  /**
   * The filters every staff list and count shares, statuses aside (the list and the counts read
   * them differently); null when the actor may see no order.
   */
  private async match(
    actor: Actor,
    query: Omit<StaffOrderCountsQuery, 'statuses' | 'groupBy'>,
  ): Promise<OrderMatchQuery | null> {
    if (!isStaffActor(actor)) throw new ForbiddenError('Access denied');
    const full = seesFullOrderDetail(actor);
    // The payment status, the payment plan and who placed an order are FULL-view facts (the
    // warehouse and the driver never see a plan); filtering by them would reveal them.
    const fullOnly =
      query.paymentStatus !== undefined ||
      query.paymentPlan !== undefined ||
      query.placedByUserId !== undefined;
    if (fullOnly && !full) throw new ForbiddenError('Access denied');
    const filters = scopeFor(actor, 'VIEW_ORDER');
    if (filters.length === 0) return null;
    const search = query.search;
    const [organizationIds, placedByUserIds] =
      search === undefined
        ? [[], []]
        : await Promise.all([
            this.organizations.findIdsByName(search),
            // Who placed an order is part of the FULL view only.
            full ? this.identity.findIdsByName(search) : [],
          ]);
    const day = query.period === 'TODAY' ? businessDayOf(this.clock.now()) : null;
    return {
      filters,
      ...(query.paymentStatus === undefined ? {} : { paymentStatus: query.paymentStatus }),
      ...(query.paymentPlan === undefined ? {} : { paymentPlan: query.paymentPlan }),
      ...(query.organizationId === undefined ? {} : { organizationId: query.organizationId }),
      ...(query.placedByUserId === undefined ? {} : { placedByUserId: query.placedByUserId }),
      ...(day === null ? {} : { submitted: { from: day.start, to: day.end } }),
      ...(query.goodsReturn === undefined ? {} : { goodsReturnPending: true as const }),
      ...(search === undefined
        ? {}
        : { search: { text: search, organizationIds, placedByUserIds } }),
    };
  }
}

/** The narrowest status filter wins: one status, then a set, then a group. */
function statusFilter(query: StaffOrderListQuery): Pick<OrderMatchQuery, 'status' | 'statuses'> {
  if (query.status !== undefined) return { status: query.status };
  if (query.statuses !== undefined) return { statuses: query.statuses };
  if (query.group !== undefined) return { statuses: CUSTOMER_ORDER_GROUP_STATUSES[query.group] };
  return {};
}
