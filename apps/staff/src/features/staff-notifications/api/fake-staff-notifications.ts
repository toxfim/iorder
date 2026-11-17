import type { StaffNotificationStatusResponse } from '@iorder/shared/staff-auth';
import type { StaffNotificationsApi } from './staff-notifications-api';

// Dev and test only (behind the fake-API gate, never in a production bundle). A new person is
// not connected; asking for a link stands for "opened it and pressed Start", so the next status
// read says connected.
export function createFakeStaffNotificationsApi(
  initial: StaffNotificationStatusResponse = { telegramLinked: false, botConnected: false },
): StaffNotificationsApi & { readonly links: string[] } {
  let state = { ...initial };
  const links: string[] = [];
  return {
    links,
    status: () => Promise.resolve({ ...state }),
    markedOrders: () =>
      Promise.resolve({
        items: [
          {
            id: '01900000-0000-7000-8000-00000000f001',
            type: 'ORDER_SUBMITTED',
            orderId: '01900000-0000-7000-8000-000000000001',
            orderNumber: '1001',
            createdAt: new Date(Date.now() - 600_000).toISOString(),
            lines: [{ productCode: 'DEMO-1', name: 'Demo: Robot pylesos', quantity: '2' }],
          },
        ],
      }),
    createLink: () => {
      const url = `https://t.me/iorder_demo_bot?start=staff_${'x'.repeat(43)}`;
      links.push(url);
      state = { telegramLinked: true, botConnected: true };
      return Promise.resolve({ url, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    },
  };
}
