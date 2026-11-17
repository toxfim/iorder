import {
  STAFF_AUTH_ROUTES,
  customerSiteHandoffResponseSchema,
  customerSiteResponseSchema,
} from '@iorder/shared/staff-auth';
import type { HttpClient } from '@core/lib/http-client';

/**
 * Continuing on the customer site with the dashboard sign-in ([C] 2026-11-09). Both addresses come
 * from the api (its own configuration), so this app needs no build variable to know where the
 * customer site is, and nothing here can be pointed at another site.
 */
export interface CustomerSiteApi {
  /** The customer site this session can be handed over to; null when it cannot (entry hidden). */
  getSite: () => Promise<string | null>;
  /**
   * Asks for a one-time code and answers the address to open: the customer site with the code in
   * the URL fragment. The code works once and for about a minute, so it is asked for right before
   * the browser goes there, never ahead of time.
   */
  requestHandoff: () => Promise<string>;
}

export function createHttpCustomerSiteApi(http: HttpClient): CustomerSiteApi {
  return {
    async getSite() {
      const answer = await http.request(STAFF_AUTH_ROUTES.customerSite, customerSiteResponseSchema);
      return answer.url;
    },
    async requestHandoff() {
      const answer = await http.request(
        STAFF_AUTH_ROUTES.customerSiteHandoff,
        customerSiteHandoffResponseSchema,
        // Empty on purpose: the server decides where the browser goes.
        { body: {} },
      );
      return answer.url;
    },
  };
}
