import {
  MARKED_ORDER_NOTIFICATION_ROUTES,
  STAFF_NOTIFICATION_ROUTES,
  markedOrderNotificationListResponseSchema,
  staffNotificationLinkResponseSchema,
  staffNotificationStatusResponseSchema,
  type MarkedOrderNotificationListResponse,
  type StaffNotificationLinkResponse,
  type StaffNotificationStatusResponse,
} from '@iorder/shared/staff-auth';
import type { HttpClient } from '@core/lib/http-client';

/**
 * The signed-in staff member's own bot notifications ([C] 2026-10-25): whether the bot reaches
 * them, and a one-time t.me link that connects it. Every staff role but ADMIN; the server
 * refuses the others.
 */
export interface StaffNotificationsApi {
  status: () => Promise<StaffNotificationStatusResponse>;
  createLink: () => Promise<StaffNotificationLinkResponse>;
  /** The purchasing manager only; the server refuses the others. */
  markedOrders: () => Promise<MarkedOrderNotificationListResponse>;
}

export function createHttpStaffNotificationsApi(http: HttpClient): StaffNotificationsApi {
  return {
    status: () =>
      http.request(STAFF_NOTIFICATION_ROUTES.status, staffNotificationStatusResponseSchema),
    createLink: () =>
      http.request(STAFF_NOTIFICATION_ROUTES.createLink, staffNotificationLinkResponseSchema),
    markedOrders: () =>
      http.request(
        MARKED_ORDER_NOTIFICATION_ROUTES.list,
        markedOrderNotificationListResponseSchema,
      ),
  };
}
