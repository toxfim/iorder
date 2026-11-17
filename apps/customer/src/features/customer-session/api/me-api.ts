import {
  IDENTITY_ROUTES,
  meResponseSchema,
  type MeResponse,
  type SetOwnContactRequest,
} from '@iorder/shared';
import type { HttpClient } from '@core/lib/http-client';

/** The caller's own summary: name, language and organization role. Allow-listed by the server. */
export interface MeApi {
  getMe: () => Promise<MeResponse>;
  /** The caller's own name and phone: entered at the first order, changed later in the profile. */
  setContact: (request: SetOwnContactRequest) => Promise<MeResponse>;
}

export function createHttpMeApi(http: HttpClient): MeApi {
  return {
    getMe: () => http.request(IDENTITY_ROUTES.me, meResponseSchema),
    setContact: (request) =>
      http.request(IDENTITY_ROUTES.setOwnContact, meResponseSchema, { body: request }),
  };
}
