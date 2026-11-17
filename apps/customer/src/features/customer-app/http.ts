import { createHttpCustomerGoodsApi } from '@/features/customer-goods/api/customer-goods-api';
import { createHttpCartApi } from '@/features/customer-cart/api/cart-api';
import { createHttpCustomerPriceApi } from '@/features/customer-catalog/api/customer-price-api';
import { createHttpCustomerBalanceApi } from '@/features/customer-balance/api/customer-balance-api';
import { createHttpCustomerHomeApi } from '@/features/customer-home/api/customer-home-api';
import { createHttpCustomerOrdersApi } from '@/features/customer-orders/api/customer-orders-api';
import { createHttpMeApi } from '@/features/customer-session/api/me-api';
import {
  isSetInThisPage,
  readCustomerToken,
  setCustomerToken,
} from '@/features/customer-session/website-session';
import { readInitData } from '@core/telegram/launch';
import { createHttpClient, type HttpClient } from '@core/lib/http-client';
import type { CustomerApis } from './assemble-services';

export interface CustomerHttpOptions {
  readonly baseUrl: string;
  /** Injected so tests can run without a network. */
  readonly fetchImpl?: typeof fetch;
  /**
   * A 401 on any call: the server no longer accepts the credential the call carried, a website
   * session (`session`: the membership or the session ended) or the init data (`telegram`).
   */
  readonly onUnauthenticated?: (credential: RefusedCredential) => void;
}

export type RefusedCredential = 'session' | 'telegram';

/**
 * The credential a request carries. A website sign-in made in THIS tab wins (the person asked for
 * it; the sign-in also lets the init data go). Otherwise, inside Telegram, the init data wins over
 * a token found in storage: the token outlives the webview (localStorage, [C] 2026-11-09), and a
 * sign-in made earlier on the device must never speak for whoever opens the Mini App next
 * (security review, 2026-11-10). The server verifies either one; the client never inspects them.
 */
export function customerAuthorizationHeader(): Record<string, string> {
  const token = readCustomerToken();
  if (token !== null && isSetInThisPage()) return { Authorization: `Bearer ${token}` };
  const initData = readInitData();
  if (initData !== null) return { Authorization: `tma ${initData}` };
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

/** Which credential a request carried, read from its own headers, so a 401 ends the right one. */
function refusedCredential(init: RequestInit | undefined): RefusedCredential | null {
  const header = new Headers(init?.headers).get('Authorization') ?? '';
  if (/^bearer /i.test(header)) return 'session';
  if (/^tma /i.test(header)) return 'telegram';
  return null;
}

/**
 * The HTTP client of the customer app (Mini App and website). The server verifies the credential
 * of every call; a 401 ends only the credential that was refused: a refused init data (a forged
 * fragment opened in a browser, an unknown person) never drops a website token other tabs may use.
 */
export function createCustomerHttpClient(options: CustomerHttpOptions): HttpClient {
  return createHttpClient({
    baseUrl: options.baseUrl,
    defaultHeaders: customerAuthorizationHeader,
    fetchImpl: async (input, init) => {
      const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
      const response = await doFetch(input, init);
      const credential = refusedCredential(init);
      if (response.status === 401 && credential !== null) {
        if (credential === 'session') setCustomerToken(null);
        options.onUnauthenticated?.(credential);
      }
      return response;
    },
  });
}

export function createHttpCustomerApis(http: HttpClient): CustomerApis {
  return {
    meApi: createHttpMeApi(http),
    goodsApi: createHttpCustomerGoodsApi(http),
    priceApi: createHttpCustomerPriceApi(http),
    cartApi: createHttpCartApi(http),
    ordersApi: createHttpCustomerOrdersApi(http),
    balanceApi: createHttpCustomerBalanceApi(http),
    homeApi: createHttpCustomerHomeApi(http),
  };
}
