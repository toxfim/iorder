import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { IdentityService } from '../identity/index.js';
import { OrganizationsService } from '../organizations/index.js';
import { isStaffActor } from './order-actor.js';
import { mayViewPhones } from './order-directory.service.js';
import {
  buildTimeline,
  personIdsOf,
  type TimelineAudience,
  type TimelineEventView,
  type TimelinePerson,
} from './order-timeline.js';
import { OrdersRepository } from './orders.repository.js';
import { OrdersService } from './orders.service.js';

export interface OrderTimelineView {
  orderId: string;
  audience: TimelineAudience;
  events: TimelineEventView[];
}

/**
 * Reads the history of one order for the person asking. Visibility is the order's own: whoever
 * may not see the order gets NOT FOUND (never forbidden). Then a FIXED number of queries, however
 * long the history is: the order, its events, its outbox rows, the people named, the organization.
 */
@Injectable()
export class OrderTimelineService {
  constructor(
    private readonly repository: OrdersRepository,
    private readonly orders: OrdersService,
    private readonly identity: IdentityService,
    private readonly organizations: OrganizationsService,
  ) {}

  async getTimeline(actor: Actor, orderId: string): Promise<OrderTimelineView> {
    const order = await this.orders.getOrderFor(actor, orderId);
    const audience: TimelineAudience = !isStaffActor(actor)
      ? 'CUSTOMER'
      : order.staff?.detail === 'FULL'
        ? 'FULL'
        : 'FULFILMENT';

    const [events, notifications] = await Promise.all([
      this.repository.findEvents(order.id),
      // The warehouse and the driver see no notifications and no "customer notified" marker.
      audience === 'FULFILMENT' ? Promise.resolve([]) : this.repository.findOutbox(order.id),
    ]);
    const [summaries, organizations] = await Promise.all([
      this.identity.findSummaries(personIdsOf(audience, events, notifications), {
        withPhones: mayViewPhones(actor),
      }),
      audience === 'FULL'
        ? this.organizations.findContactInfo([order.organizationId])
        : Promise.resolve(new Map<string, { name: string }>()),
    ]);

    const people = new Map<string, TimelinePerson>(
      [...summaries.values()].map((person) => [
        person.id,
        { userId: person.id, fullName: person.fullName, phone: person.phone },
      ]),
    );
    return {
      orderId: order.id,
      audience,
      events: buildTimeline({
        audience,
        showsPaymentMethod: can(actor, 'VIEW_PAYMENT_METHOD'),
        order: { placedByUserId: order.placedByUserId },
        events,
        notifications,
        people,
        organizationNames: new Map([...organizations].map(([id, info]) => [id, info.name])),
      }),
    };
  }
}
