import { describe, expect, it } from 'vitest';
import type { Actor } from '../../common/auth/actor.js';
import type { Clock } from '../../common/clock/clock.js';
import { ConflictError } from '../../common/errors/domain-errors.js';
import type { Env } from '../../config/env.js';
import type { AuditService } from '../audit/index.js';
import type { CatalogService } from '../catalog/index.js';
import type { IdentityService } from '../identity/index.js';
import type { OrganizationsService } from '../organizations/index.js';
import type { SupplyAllocationService } from '../pricing/index.js';
import type { CartService } from './cart.service.js';
import type { OrderItemAllocationsService } from './order-item-allocations.service.js';
import type { OrdersRepository } from './orders.repository.js';
import { OrdersService } from './orders.service.js';
import type { OrganizationPaymentsService } from './organization-payments.service.js';
import type { PickingService } from './picking.service.js';

// [C, owner 2026-11-20] the manager's order on a customer's behalf: the placer is checked UNDER
// the transaction's locks, so a member who leaves or is blocked a moment earlier cannot become it.
const manager: Actor = { userId: 'manager-1', staffRoles: ['MANAGER'] };
const request = {
  organizationId: '0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a01',
  placedByUserId: '0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a02',
  paymentPlan: 'FULL' as const,
  lines: [{ productId: '0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a03', quantity: '1' }],
  expectedTotalAmount: '100.00',
};

function setup(memberNow: boolean) {
  const calls: string[] = [];
  const tx = { $executeRaw: () => (calls.push('advisory-lock'), Promise.resolve(1)) };
  const repository = {
    findByIdempotencyKey: () => Promise.resolve(null),
    transaction: async <T>(work: (t: unknown) => Promise<T>) => {
      calls.push('begin');
      try {
        return await work(tx);
      } finally {
        calls.push('end');
      }
    },
  };
  const organizations = {
    isActive: () => Promise.resolve(true),
    lockActiveMember: (t: unknown) => {
      calls.push(t === tx ? 'member-check-in-tx' : 'member-check-outside');
      return Promise.resolve(memberNow);
    },
  };
  const identity = {
    lockActiveCustomer: (t: unknown) => {
      calls.push(t === tx ? 'person-check-in-tx' : 'person-check-outside');
      return Promise.resolve(true);
    },
  };
  const carts = {
    loadPriceBookForOrganization: () => {
      calls.push('pricing');
      return Promise.resolve(null);
    },
  };
  const service = new OrdersService(
    repository as unknown as OrdersRepository,
    carts as unknown as CartService,
    organizations as unknown as OrganizationsService,
    identity as unknown as IdentityService,
    {} as AuditService,
    { now: () => new Date('2026-11-20T08:00:00Z') } as Clock,
    {} as PickingService,
    {} as OrganizationPaymentsService,
    {} as SupplyAllocationService,
    {} as OrderItemAllocationsService,
    {} as CatalogService,
    {} as Env,
  );
  return { service, calls };
}

describe('OrdersService.createForCustomer: the placer check', () => {
  it('runs inside the transaction, after the advisory lock and before pricing', async () => {
    const { service, calls } = setup(true);
    // No price list in this fake: the call ends with NO_PUBLISHED_VERSION after the checks.
    await expect(service.createForCustomer(manager, 'order-key-0001', request)).rejects.toThrow(
      ConflictError,
    );
    expect(calls).toEqual([
      'begin',
      'advisory-lock',
      'member-check-in-tx',
      'person-check-in-tx',
      'pricing',
      'end',
    ]);
  });

  it('refuses a person who is no longer a member, inside the transaction', async () => {
    const { service, calls } = setup(false);
    const refused = await service
      .createForCustomer(manager, 'order-key-0002', request)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as ConflictError).reason).toBe('PLACER_NOT_MEMBER');
    expect(calls).not.toContain('pricing');
  });
});
