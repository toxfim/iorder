import { IDENTITY_ROUTES, staffPersonCardSchema, type StaffPersonCard } from '@iorder/shared';
import type { HttpClient } from '@core/lib/http-client';

/** Who a name in the dashboard belongs to: a user id, or a Telegram id when only that is known. */
export type PersonRef =
  | { readonly userId: string; readonly telegramUserId?: undefined }
  | { readonly userId?: undefined; readonly telegramUserId: string };

/** The hover card on a person's name (manager, accountant, admin, purchasing manager). */
export interface PeopleApi {
  card: (person: PersonRef) => Promise<StaffPersonCard>;
}

export function createHttpPeopleApi(http: HttpClient): PeopleApi {
  return {
    card: (person) =>
      person.userId !== undefined
        ? http.request(IDENTITY_ROUTES.personCard, staffPersonCardSchema, {
            params: { id: person.userId },
          })
        : http.request(IDENTITY_ROUTES.personCardByTelegram, staffPersonCardSchema, {
            params: { telegramUserId: person.telegramUserId },
          }),
  };
}
