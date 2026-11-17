import { createApp } from 'vue';
import { installErrorHandler } from '@core/app/error-handler';
import type { AppI18n } from '@core/i18n';
import {
  continueFromCompanySite,
  type HandoffArrival,
} from '@/features/customer-session/site-handoff';
import { readCustomerToken } from '@/features/customer-session/website-session';
import { readInitData } from '@core/telegram/launch';
import CustomerApp from './components/CustomerApp.vue';
import { createCustomerServices } from './create-customer-services';
import { createCustomerRouter } from './router';
import { customerServicesKey } from './services';

/**
 * Starts the customer app (Telegram Mini App and website). `arrival` is what the start-up found in
 * the URL fragment: a one-time handoff code is exchanged here, before anything is shown, and a
 * returning company employee may be sent to the company site once (site-handoff.ts). When the
 * browser is leaving, nothing is mounted: the sign-in page must not flash on the way out.
 */
export async function bootstrapCustomerApp(
  i18n: AppI18n,
  arrival: HandoffArrival = { kind: 'none' },
): Promise<void> {
  const services = await createCustomerServices(i18n);
  const auth = services.auth;
  if (auth) {
    const next = await continueFromCompanySite(arrival, {
      exchange: auth.handoff,
      revokeSession: auth.revokeSession,
      handoffPage: auth.handoffPage,
      hasSession: () => readCustomerToken() !== null,
      currentToken: readCustomerToken,
      inTelegram: () => readInitData() !== null,
      now: Date.now,
    });
    if (next === 'leaving') return;
  }
  const app = createApp(CustomerApp);
  installErrorHandler(app, i18n);
  app.provide(customerServicesKey, services).use(i18n).use(createCustomerRouter()).mount('#app');
}
