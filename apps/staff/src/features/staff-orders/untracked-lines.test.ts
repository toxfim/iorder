import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { AllocationPreview } from '@iorder/shared/staff-orders';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { servicesKey } from '@/app/services';
import { createTestServices } from '@/test-utils/create-test-services';
import AllocationPlanPicker from './components/AllocationPlanPicker.vue';
import OrderAllocationsTable from './components/OrderAllocationsTable.vue';
import { useAllocationPlan } from './composables/use-allocation-plan';

// A staff-added product without a sheet «Товар_ID» [C, 2026-11-09] is outside the allocation
// plan: the screens say "Buyurtma orqali" (by order: staff vocabulary [C, owner 2026-11-09], with
// "not kept in the warehouse, stock not tracked" as the tooltip) instead of a supply or a shortage,
// and the approval is not blocked by it (the server decides on the tracked lines).

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = (el: Element | null | undefined): string =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

const preview: AllocationPreview = {
  orderId: ID(1),
  status: 'SUBMITTED',
  rowVersion: 1,
  feasible: true,
  attention: false,
  notAllocated: false,
  lastSheetChangeAt: null,
  items: [
    {
      orderItemId: ID(2),
      productId: ID(3),
      productCode: '10491',
      name: 'Galaxy A15',
      quantity: '2.000',
      stockTracked: true,
      lines: [
        {
          supplyLineId: ID(4),
          deliveryRef: 'SP-1',
          deliveredAt: '2026-10-01T00:00:00.000Z',
          availableQuantity: '9.000',
          heldQuantity: '0.000',
          freeQuantity: '9.000',
        },
      ],
      fifo: [{ supplyLineId: ID(4), deliveryRef: 'SP-1', quantity: '2.000' }],
      shortQuantity: '0.000',
      earlierDemand: { orders: 0, quantity: '0.000' },
      current: [],
    },
    {
      orderItemId: ID(5),
      productId: ID(6),
      productCode: 'IO-000001',
      name: 'Demo powerbank',
      quantity: '5.000',
      stockTracked: false,
      lines: [],
      fifo: [],
      shortQuantity: '0.000',
      earlierDemand: { orders: 0, quantity: '0.000' },
      current: [],
    },
  ],
};

describe('the approval plan with a line outside the plan', () => {
  it('says it is brought by order, offers no supplies for it, and lets the plan be sent', async () => {
    const { services } = createTestServices({ identityId: 'manager' });
    // Held in a box: the composable runs inside the host's setup, after this test's own code.
    const held: { plan: ReturnType<typeof useAllocationPlan> | null } = { plan: null };
    const Host = defineComponent({
      setup() {
        const plan = useAllocationPlan();
        plan.adopt(preview);
        held.plan = plan;
        return () => h(AllocationPlanPicker, { plan, orderId: ID(1) });
      },
    });
    const wrapper = mount(Host, {
      attachTo: document.body,
      global: { provide: { [servicesKey as symbol]: services } },
    });
    wrappers.push(wrapper);
    await flushPromises();

    const untracked = document.body.querySelector('[data-testid="allocation-untracked"]');
    expect(text(untracked)).toBe('Buyurtma orqali');
    expect(untracked?.getAttribute('title')).toBe(
      'Omborda turmaydi: buyurtma kelganda olib kelinadi. Qoldiq kuzatilmaydi.',
    );
    expect(document.body.querySelector('[data-testid="allocation-short"]')).toBeNull();
    expect(held.plan?.canSubmit.value).toBe(true);
    expect(held.plan?.choice.value?.allocations).toEqual([
      { orderItemId: ID(2), supplyLineId: ID(4), quantity: '2' },
    ]);

    // Opening the supply lines shows them for the tracked line only.
    (document.body.querySelector('[data-testid="allocation-toggle"]') as HTMLElement).click();
    await flushPromises();
    expect(document.body.querySelectorAll('.line__input')).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Bu tovar uchun yetkazib berish yo'q.");
  });
});

describe('the order lines table with a line outside the plan', () => {
  it('shows "by order" instead of a supply or "not allocated"', () => {
    const wrapper = mount(OrderAllocationsTable, {
      attachTo: document.body,
      props: {
        status: 'MANAGER_APPROVED',
        total: null,
        lines: [
          {
            id: ID(2),
            productCode: '10491',
            name: 'Galaxy A15',
            unit: 'dona',
            quantity: '2.000',
            allocations: [{ supplyRef: 'SP-1', partyNumber: '5', quantity: '2.000' }],
            stockTracked: true,
          },
          {
            id: ID(5),
            productCode: 'IO-000001',
            name: 'Demo powerbank',
            unit: 'dona',
            quantity: '5.000',
            allocations: [],
            stockTracked: false,
          },
        ],
      },
    });
    wrappers.push(wrapper);
    expect(document.body.querySelectorAll('[data-testid="order-line-supply"]')).toHaveLength(1);
    expect(document.body.querySelector('[data-testid="order-line-not-allocated"]')).toBeNull();
    expect(text(document.body.querySelector('[data-testid="order-line-untracked"]'))).toBe(
      'Buyurtma orqali',
    );
  });
});
