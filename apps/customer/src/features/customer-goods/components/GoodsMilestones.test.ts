import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { customerUz } from '@/features/customer-app/messages/uz';
import GoodsMilestones from './GoodsMilestones.vue';

describe('GoodsMilestones', () => {
  it('shows when the unit was ordered and delivered, and no step inside the company', () => {
    const wrapper = mount(GoodsMilestones, {
      props: {
        milestones: {
          orderedAt: '2026-10-23T09:00:00.000Z',
          confirmedAt: '2026-10-23T10:00:00.000Z',
          deliveredAt: '2026-10-24T12:00:00.000Z',
        },
      },
    });
    const rows = wrapper.findAll('li').map((li) => li.get('p').text());
    expect(rows).toEqual([
      customerUz.goods.milestones.orderedAt,
      customerUz.goods.milestones.deliveredAt,
    ]);
    expect(wrapper.findAll('time')).toHaveLength(2);
  });

  it('a unit that is not delivered yet says so', () => {
    const wrapper = mount(GoodsMilestones, {
      props: {
        milestones: { orderedAt: '2026-10-23T09:00:00.000Z', confirmedAt: null, deliveredAt: null },
      },
    });
    expect(wrapper.text()).toContain(customerUz.goods.pending.deliveredAt);
    expect(wrapper.findAll('time')).toHaveLength(1);
  });
});
