import { BY_ORDER_OPEN_STATUSES, type ByOrderOpenStatus } from '@iorder/shared/staff-cost';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { scopeFor } from '../../common/auth/scope-for.js';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { OrganizationsService } from '../organizations/index.js';
import { isStaffActor } from './order-actor.js';
import { OrdersRepository } from './orders.repository.js';

/** One line of an open order that waits for a product outside the allocation plan. */
export interface OpenDemandLine {
  productId: string;
  orderId: string;
  orderNumber: string;
  organizationName: string;
  status: ByOrderOpenStatus;
  quantity: Prisma.Decimal;
  submittedAt: Date;
}

/**
 * What open orders still wait for, of the products outside the allocation plan (staff-added, no
 * sheet «Товар_ID»: they are brought when an order arrives, so nothing is held for them and the
 * stock never says how many are needed). For other modules (the "by order" page); the scope of
 * VIEW_ORDER goes into the query, so a line of an order the actor could not open is never counted.
 * Two queries whatever the number of orders.
 */
@Injectable()
export class OpenDemandService {
  constructor(
    private readonly repository: OrdersRepository,
    private readonly organizations: OrganizationsService,
  ) {}

  /** The lines, the order that waits longest first. */
  async linesOutsidePlan(actor: Actor): Promise<OpenDemandLine[]> {
    // Customers never learn which products are brought by order: this is a staff read.
    if (!isStaffActor(actor)) throw new ForbiddenError('Access denied');
    const scope = scopeFor(actor, 'VIEW_ORDER');
    if (scope.length === 0) return [];
    const rows = await this.repository.findOpenLinesOutsidePlan(scope, BY_ORDER_OPEN_STATUSES);
    const organizations = await this.organizations.findContactInfo(
      rows.map((row) => row.organizationId),
    );
    return rows.map((row) => ({
      productId: row.productId,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      organizationName: organizations.get(row.organizationId)?.name ?? '',
      status: row.status,
      quantity: row.quantity,
      submittedAt: row.submittedAt,
    }));
  }
}
