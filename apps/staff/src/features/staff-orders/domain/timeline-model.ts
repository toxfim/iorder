import {
  staffTimelineEventSchema,
  staffTimelineResponseSchema,
  timelineNotificationSchema,
  type NotificationType,
  type OrderEventType,
  type StaffTimelineEvent,
  type StaffTimelineResponse,
  type TimelineNotification,
} from '@iorder/shared/staff-orders';
import type { ResponseSchema } from '@core/lib/http-client';

// The timeline is history, and a newer api may know more event or notification types than this
// build does. The shared contract stays strict (the api must never send what it does not declare),
// but the web layer reads those two open enums tolerantly: an unknown value becomes 'UNKNOWN' and is
// shown with a generic label, instead of one new type turning the whole timeline into an error.
export const UNKNOWN_TYPE = 'UNKNOWN' as const;

export type TimelineNotificationRow = Omit<TimelineNotification, 'type'> & {
  type: NotificationType | typeof UNKNOWN_TYPE;
};
export type TimelineEvent = Omit<StaffTimelineEvent, 'type' | 'notifications'> & {
  type: OrderEventType | typeof UNKNOWN_TYPE;
  notifications: TimelineNotificationRow[];
};
export type TimelineResponse = Omit<StaffTimelineResponse, 'events'> & {
  events: TimelineEvent[];
};

// The web app has no zod of its own, so zod's typed fallback (which must be a member of the enum)
// is given as a function. The widened result types above say what really comes out.
const unknownType = ((): typeof UNKNOWN_TYPE => UNKNOWN_TYPE) as never;

const tolerantNotificationSchema = timelineNotificationSchema.extend({
  type: timelineNotificationSchema.shape.type.catch(unknownType),
});

const tolerantEventSchema = staffTimelineEventSchema.extend({
  type: staffTimelineEventSchema.shape.type.catch(unknownType),
  notifications: tolerantNotificationSchema.array(),
});

const tolerantSchema = staffTimelineResponseSchema.extend({
  events: tolerantEventSchema.array(),
});

/** Parses the timeline response; only the event type and the notification type are tolerant. */
export const tolerantTimelineResponseSchema: ResponseSchema<TimelineResponse> = {
  safeParse: (data) => tolerantSchema.safeParse(data),
};
