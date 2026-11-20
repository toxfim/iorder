import { describe, expect, it } from 'vitest';
import type { Actor } from '../../common/auth/actor.js';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import type { BrandService, CatalogService } from '../catalog/index.js';
import type { OrderCustomer, OrganizationsService } from '../organizations/index.js';
import type { PricingService } from '../pricing/index.js';
import type { OrdersRepository } from './orders.repository.js';
import { StaffNewOrderService } from './staff-new-order.service.js';

const staff = (role: Actor['staffRoles'][number]): Actor => ({
  userId: `u-${role}`,
  staffRoles: [role],
});

const customer = (id: string, members = 1): OrderCustomer => ({
  id,
  name: `Org ${id}`,
  type: 'GROUP',
  label: 'STANDARD',
  members: Array.from({ length: members }, (_, i) => ({
    userId: `${id}-m${i}`,
    fullName: `Member ${i}`,
    phone: null,
  })),
});

function serviceWith(recentIds: string[], known: OrderCustomer[]): StaffNewOrderService {
  const repository = { recentOrganizationIds: () => Promise.resolve(recentIds) };
  const organizations = {
    findOrderCustomers: (filter: { ids?: readonly string[] }) =>
      Promise.resolve(
        filter.ids === undefined ? known : known.filter((c) => filter.ids?.includes(c.id)),
      ),
  };
  return new StaffNewOrderService(
    repository as unknown as OrdersRepository,
    organizations as unknown as OrganizationsService,
    {} as PricingService,
    {} as CatalogService,
    {} as BrandService,
  );
}

describe('StaffNewOrderService', () => {
  it('is the manager’s alone [C, owner 2026-11-20]', async () => {
    const service = serviceWith([], []);
    for (const role of [
      'ADMIN',
      'ACCOUNTANT',
      'PURCHASING_MANAGER',
      'WAREHOUSE_MANAGER',
      'DRIVER',
    ] as const) {
      await expect(service.customers(staff(role), {})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(service.catalogFor(staff(role), 'org')).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(service.customers(staff('MANAGER'), {})).resolves.toBeDefined();
  });

  it('recent customers [P]: latest first, only orderable ones with members, at most four', async () => {
    const known = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => customer(id));
    known.push(customer('empty', 0));
    // "gone" is inactive or archived: findOrderCustomers does not return it.
    const service = serviceWith(['f', 'gone', 'empty', 'b', 'a', 'c', 'd'], known);
    const { recent } = await service.customers(staff('MANAGER'), {});
    expect(recent.map((c) => c.id)).toEqual(['f', 'b', 'a', 'c']);
  });
});
