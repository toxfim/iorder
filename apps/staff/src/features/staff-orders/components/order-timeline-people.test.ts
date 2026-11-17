import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { servicesKey } from '@/app/services';
import { signedInServices } from '@/test-utils/orders';
import type { TimelineEvent, TimelineNotificationRow } from '../domain/timeline-model';
import OrderTimeline from './OrderTimeline.vue';

const ACTOR_ID = '00000000-0000-7000-8000-00000000b001';
const DRIVER_ID = '00000000-0000-7000-8000-00000000b002';
const RECIPIENT_ID = '00000000-0000-7000-8000-00000000b003';

const notification = (
  id: string,
  recipient: Pick<
    TimelineNotificationRow,
    'recipientKind' | 'recipientRole' | 'recipientUserId' | 'recipientName'
  >,
): TimelineNotificationRow => ({
  id,
  type: 'ORDER_STATUS_CHANGED' as TimelineNotificationRow['type'],
  status: 'SENT',
  attempts: 1,
  createdAt: '2026-10-19T05:00:00.000Z',
  sentAt: '2026-10-19T05:00:01.000Z',
  ...recipient,
});

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: '00000000-0000-7000-8000-00000000b010',
  type: 'STATUS_CHANGED',
  occurredAt: '2026-10-19T05:00:00.000Z',
  fromStatus: null,
  toStatus: null,
  actor: { userId: ACTOR_ID, role: 'MANAGER', name: 'Aziza Y.' },
  comment: null,
  accountingMode: null,
  driver: null,
  itemsChange: null,
  paymentChange: null,
  paymentMethodChange: null,
  paymentPlanChange: null,
  notifications: [],
  ...overrides,
});

async function namesOf(identity: string, events: TimelineEvent[]) {
  const { services } = await signedInServices(identity);
  const wrapper = mount(OrderTimeline, {
    props: { events },
    global: { provide: { [servicesKey as symbol]: services } },
  });
  return {
    wrapper,
    people: wrapper.findAll('[data-testid="person-name"]').map((name) => name.text()),
  };
}

describe('OrderTimeline: names of people', () => {
  it('makes the actor, the driver and a person who was messaged hoverable', async () => {
    const { wrapper, people } = await namesOf('manager', [
      event({
        driver: { userId: DRIVER_ID, fullName: 'Bobur D.', phone: null },
        notifications: [
          notification('00000000-0000-7000-8000-00000000b020', {
            recipientKind: 'USER',
            recipientRole: null,
            recipientUserId: RECIPIENT_ID,
            recipientName: 'Sardor S.',
          }),
          notification('00000000-0000-7000-8000-00000000b021', {
            recipientKind: 'ROLE',
            recipientRole: 'ACCOUNTANT',
            recipientUserId: null,
            recipientName: null,
          }),
        ],
      }),
    ]);
    expect(people).toEqual(['Aziza Y.', 'Bobur D.', 'Sardor S.']);
    // The sentences stay whole around the names.
    expect(wrapper.text()).toMatch(/Aziza Y\.\s*·/);
    expect(wrapper.text()).toMatch(/Sardor S\.,\s*\S/);
    wrapper.unmount();
  });

  it('leaves an actor without a name as a role, with nothing to hover', async () => {
    const { wrapper, people } = await namesOf('manager', [
      event({ actor: { userId: null, role: 'MANAGER', name: null } }),
    ]);
    expect(people).toEqual([]);
    expect(wrapper.find('.event__meta').text().length).toBeGreaterThan(0);
    wrapper.unmount();
  });
});
