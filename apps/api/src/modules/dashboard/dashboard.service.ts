import { CURRENCY, ORDER_STATUSES } from '@iorder/shared';
import {
  staffDashboardSummarySchema,
  type StaffDashboardSummary,
} from '@iorder/shared/staff-orders';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { businessDayOf } from '../../common/clock/business-time.js';
import { Clock } from '../../common/clock/clock.js';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain-errors.js';
import { OrderStatsService } from '../orders/index.js';
import { OrganizationsService } from '../organizations/index.js';
import { StaffStockService, UsdRateService } from '../pricing/index.js';
import { SheetSyncRunService } from '../sheets-sync/index.js';
import { buildQueues } from './dashboard-queues.js';

type LastSheetSync = NonNullable<StaffDashboardSummary['lastSheetSync']>;
type UsdRate = NonNullable<StaffDashboardSummary['usdRate']>;

/**
 * The staff dashboard: one read that composes figures from the other modules, each through its
 * exported service. Which sections a caller gets follows the permission matrix, never the UI:
 * a section the role may not see is left out of the answer (the key is absent), and the final
 * strict schema parse means a field added by mistake fails loudly instead of leaking.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly clock: Clock,
    private readonly orders: OrderStatsService,
    private readonly organizations: OrganizationsService,
    private readonly stock: StaffStockService,
    private readonly sheetSyncRuns: SheetSyncRunService,
    private readonly usdRate: UsdRateService,
  ) {}

  async summarize(actor: Actor): Promise<StaffDashboardSummary> {
    // The route gate (VIEW_ORDER) lets customers through; this view is for staff only.
    if (actor.staffRoles.length === 0) throw new ForbiddenError('Access denied');
    const now = this.clock.now();
    const day = businessDayOf(now);

    const maySeeCustomers = can(actor, 'VIEW_CUSTOMERS');
    // Selling prices and the sheet that feeds them; the accountant reads neither figure here.
    const maySeePriceAdmin = can(actor, 'VIEW_PRICE_ADMIN');
    const maySeeRate = can(actor, 'VIEW_COST_REFERENCE');

    const [stats, awaitingActivation, unpriced, lastSync, rate] = await Promise.all([
      this.orders.statsFor(actor, { from: day.start, to: day.end }),
      maySeeCustomers ? this.organizations.countAwaitingActivation(actor) : undefined,
      maySeePriceAdmin ? this.stock.countUnpricedActive(actor) : undefined,
      maySeePriceAdmin ? this.readLastSheetSync(actor) : undefined,
      maySeeRate ? this.readUsdRate(actor) : undefined,
    ]);

    const summary: StaffDashboardSummary = {
      generatedAt: now.toISOString(),
      businessDate: day.date,
      ordersByStatus: Object.fromEntries(
        ORDER_STATUSES.map((status) => [status, stats.byStatus[status].count]),
      ),
      queues: buildQueues(actor.staffRoles, stats, now),
      ...(stats.full === null
        ? {}
        : {
            today: {
              count: stats.full.today.count,
              totalAmount: stats.full.today.totalAmount,
              currency: CURRENCY,
            },
            unpaidDeliveredCount: stats.full.unpaidDeliveredCount,
          }),
      ...(awaitingActivation === undefined
        ? {}
        : { organizationsAwaitingActivationCount: awaitingActivation }),
      ...(unpriced === undefined ? {} : { unpricedProductsCount: unpriced }),
      ...(lastSync === undefined ? {} : { lastSheetSync: lastSync }),
      ...(rate === undefined ? {} : { usdRate: rate }),
    };
    return staffDashboardSummarySchema.parse(summary);
  }

  /** Outcome and times only; the run's rows and counts are not the dashboard's business. */
  private async readLastSheetSync(actor: Actor): Promise<LastSheetSync | null> {
    try {
      const run = await this.sheetSyncRuns.last(actor);
      return { status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt };
    } catch (error) {
      if (error instanceof NotFoundError) return null; // the sync has not run yet
      throw error;
    }
  }

  private async readUsdRate(actor: Actor): Promise<UsdRate | null> {
    const snapshot = await this.usdRate.readSnapshotFor(actor);
    if (snapshot === null) return null;
    return {
      rate: snapshot.rate.toFixed(4),
      source: snapshot.source,
      rateDate: snapshot.rateDate,
    };
  }
}
