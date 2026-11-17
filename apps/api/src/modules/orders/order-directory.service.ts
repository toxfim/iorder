import type { StaffRole } from '@iorder/shared';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { IdentityService } from '../identity/index.js';
import { OrganizationsService, type OrganizationContactInfo } from '../organizations/index.js';
import { isStaffActor } from './order-actor.js';
import type { OrderSummaryView } from './order.views.js';

/** The people who may call the customer when the goods arrive (decision: lifecycle §5 roles). */
const CONTACT_ROLES: readonly StaffRole[] = [
  'MANAGER',
  'ADMIN',
  'WAREHOUSE_MANAGER',
  'DRIVER',
  'PURCHASING_MANAGER',
];

/** Decision: only these roles see phone numbers; the accountant needs none. */
export function mayViewPhones(actor: Actor): boolean {
  return actor.staffRoles.some((role) => CONTACT_ROLES.includes(role));
}

export interface PersonView {
  userId: string;
  fullName: string;
  phone: string | null;
}

export interface DeliveryContactView {
  organizationName: string;
  contacts: {
    userId: string;
    fullName: string;
    phone: string | null;
    placedTheOrder: boolean;
    isShopOwner: boolean;
  }[];
}

/** Names and contacts for a set of already-authorized orders. Plain lookups, no rules about orders. */
export class OrderDirectory {
  constructor(
    private readonly people: ReadonlyMap<string, PersonView>,
    private readonly organizations: ReadonlyMap<string, OrganizationContactInfo>,
    private readonly contactsAllowed: boolean,
  ) {}

  person(userId: string | null): PersonView | null {
    return userId === null ? null : (this.people.get(userId) ?? null);
  }

  /** Staff only; a customer is never shown organization names other than their own. */
  organizationName(organizationId: string): string {
    return this.organizations.get(organizationId)?.name ?? '';
  }

  /** Null unless the actor's role gets it (manager, admin, warehouse, driver). */
  deliveryContact(order: OrderSummaryView): DeliveryContactView | null {
    if (!this.contactsAllowed) return null;
    const organization = this.organizations.get(order.organizationId);
    const ownerId = organization?.shopOwnerUserId ?? null;
    const ids = [...new Set([order.placedByUserId, ...(ownerId === null ? [] : [ownerId])])];
    return {
      organizationName: organization?.name ?? '',
      contacts: ids.flatMap((id) => {
        const person = this.people.get(id);
        return person === undefined
          ? []
          : [
              {
                userId: person.userId,
                fullName: person.fullName,
                phone: person.phone,
                placedTheOrder: id === order.placedByUserId,
                isShopOwner: id === ownerId,
              },
            ];
      }),
    };
  }
}

/**
 * Looks up the names the HTTP layer puts next to orders, through the exported services of the
 * identity and organizations modules (never their tables). A fixed number of queries for any
 * number of orders.
 */
@Injectable()
export class OrderDirectoryService {
  constructor(
    private readonly identity: IdentityService,
    private readonly organizations: OrganizationsService,
  ) {}

  async load(
    actor: Actor,
    orders: readonly OrderSummaryView[],
    options: { withContacts?: boolean } = {},
  ): Promise<OrderDirectory> {
    const phonesAllowed = mayViewPhones(actor);
    const contactsAllowed = options.withContacts === true && phonesAllowed;
    const organizations = isStaffActor(actor)
      ? await this.organizations.findContactInfo(orders.map((order) => order.organizationId))
      : new Map<string, OrganizationContactInfo>();

    const ids = new Set<string>();
    for (const order of orders) {
      ids.add(order.placedByUserId);
      if (order.staff?.driverUserId) ids.add(order.staff.driverUserId);
      const ownerId = organizations.get(order.organizationId)?.shopOwnerUserId;
      if (contactsAllowed && ownerId) ids.add(ownerId);
    }
    const summaries = await this.identity.findSummaries([...ids], {
      withPhones: phonesAllowed,
    });
    const people = new Map<string, PersonView>(
      [...summaries.values()].map((person) => [
        person.id,
        { userId: person.id, fullName: person.fullName, phone: person.phone },
      ]),
    );
    return new OrderDirectory(people, organizations, contactsAllowed);
  }
}
