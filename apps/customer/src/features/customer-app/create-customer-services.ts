import { createHttpClient } from '@core/lib/http-client';
import { createCustomerAuthApi } from '@/features/customer-session/api/customer-auth-api';
import type { MeResponse } from '@iorder/shared';
import { API_BASE_URL, FAKE_API_ENABLED } from '@core/app/env';
import { LOCALE_STORAGE_KEY, toI18nLocale, type AppI18n } from '@core/i18n';
import { reloadPage } from '@core/lib/app-outdated';
import { readStorage } from '@core/lib/safe-storage';
import { onCustomerTokenChangedElsewhere } from '@/features/customer-session/website-session';
import { assembleCustomerServices } from './assemble-services';
import { createCustomerHttpClient, createHttpCustomerApis } from './http';
import type { CustomerServices } from './services';

/**
 * The person's own language wins once they have picked one; until then the language stored on
 * their profile is used. Nothing is written, so a later choice is still a first choice.
 */
function adoptProfileLocale(i18n: AppI18n): (me: MeResponse) => void {
  return (me) => {
    if (readStorage(LOCALE_STORAGE_KEY) !== null) return;
    const next = toI18nLocale(me.locale);
    i18n.global.locale.value = next;
    document.documentElement.lang = next;
  };
}

/**
 * Picks the API adapters. Fakes exist only on the dev server or in a build with
 * VITE_USE_FAKE_API=true; in a normal production build the branch is a compile-time `false`, so
 * the dynamic import (and every fixture behind it) leaves the bundle. `pnpm check:bundle`
 * verifies it.
 */
export async function createCustomerServices(i18n: AppI18n): Promise<CustomerServices> {
  const onMe = adoptProfileLocale(i18n);
  if (FAKE_API_ENABLED) {
    const { createFakeCustomerServices } =
      await import('@/features/customer-app/fake-customer-services');
    return createFakeCustomerServices(onMe);
  }

  // The website token is shared by every tab of the browser: when another tab signs in or out,
  // this tab starts again so that it shows the person the token belongs to (or the sign-in page).
  onCustomerTokenChangedElsewhere(reloadPage);

  let services: CustomerServices | null = null;
  const http = createCustomerHttpClient({
    baseUrl: API_BASE_URL,
    onUnauthenticated: (credential) => {
      if (credential === 'telegram') services?.session.markDenied();
      else services?.session.signedOut();
    },
  });
  services = {
    ...assembleCustomerServices(createHttpCustomerApis(http), onMe),
    auth: createCustomerAuthApi(http, createHttpClient({ baseUrl: API_BASE_URL })),
  };
  return services;
}
