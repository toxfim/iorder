import { beforeEach, describe, expect, it } from 'vitest';
import type { NewOrderCustomer } from '@iorder/shared/staff-orders';
import { createOrdersStore } from './orders-store';
import { useNewOrderDraft } from './new-order-draft';
import type { StaffOrdersApi } from '../api/staff-orders-api';

const member = { userId: 'u-1', fullName: 'Dilnoza', phone: null };
const customer: NewOrderCustomer = {
  organizationId: 'org-1',
  name: 'Orion Mobile',
  type: 'GROUP',
  label: 'PARTNER',
  members: [member],
};

beforeEach(() => useNewOrderDraft().reset());

describe('the new order draft', () => {
  it('keeps the key for a retry of the unchanged order', () => {
    const draft = useNewOrderDraft();
    draft.choose(customer, member);
    draft.lines.value = [{ productId: 'p1', quantity: 2 }];
    draft.plan.value = 'FULL';
    const key = draft.idempotencyKey.value;
    // The same content again (a catalog reload rebuilding the list) is still the same order.
    draft.lines.value = [{ productId: 'p1', quantity: 2 }];
    draft.comment.value = '';
    expect(draft.idempotencyKey.value).toBe(key);
  });

  it.each([
    ['the lines', (d: ReturnType<typeof useNewOrderDraft>) => (d.lines.value = [])],
    ['the plan', (d: ReturnType<typeof useNewOrderDraft>) => (d.plan.value = 'DEFERRED')],
    ['the comment', (d: ReturnType<typeof useNewOrderDraft>) => (d.comment.value = 'Ertaga')],
    [
      'the member',
      (d: ReturnType<typeof useNewOrderDraft>) =>
        d.choose(customer, { userId: 'u-2', fullName: 'Bobur', phone: null }),
    ],
  ])(
    'gives a new key when %s change, so an edit is never answered with the earlier order',
    (_n, change) => {
      const draft = useNewOrderDraft();
      draft.choose(customer, member);
      draft.lines.value = [{ productId: 'p1', quantity: 2 }];
      draft.plan.value = 'FULL';
      const key = draft.idempotencyKey.value;
      change(draft);
      expect(draft.idempotencyKey.value).not.toBe(key);
    },
  );

  it('is emptied with the per-person data when the session changes', () => {
    const draft = useNewOrderDraft();
    draft.choose(customer, member);
    draft.lines.value = [{ productId: 'p1', quantity: 2 }];
    createOrdersStore({} as StaffOrdersApi).reset();
    expect(draft.customer.value).toBeNull();
    expect(draft.lines.value).toEqual([]);
  });
});
