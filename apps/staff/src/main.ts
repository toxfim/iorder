// Design v8 type: Inter (one variable file covers 400-700) and IBM Plex Mono for codes.
import '@fontsource-variable/inter/index.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@core/styles/tokens.css';
import '@core/styles/base.css';

import { createApp } from 'vue';
import type { Router } from 'vue-router';
import App from './App.vue';
import { createServices } from './app/create-services';
import { FAKE_API_ENABLED } from '@core/app/env';
import { installErrorHandler } from '@core/app/error-handler';
import { readInitData } from '@core/telegram/launch';
import { servicesKey } from './app/services';
import { prepareTelegramLaunch } from './app/telegram-launch';
import { readStoredLocale, toI18nLocale } from '@core/i18n';
import { createAppI18n } from './i18n';
import { createAppRouter } from './router';
import { reevaluateCurrentRoute } from './router/guards';

async function bootstrap(): Promise<void> {
  // The staff fonts apply on every staff page, the login included (it is outside StaffShell,
  // which sets the v8 palette only while it is mounted).
  document.documentElement.setAttribute('data-staff-fonts', '');
  const locale = readStoredLocale();
  document.documentElement.lang = toI18nLocale(locale);
  const i18n = createAppI18n(locale);

  // Telegram puts the launch parameters in the URL fragment (staff open this app as a Mini App
  // too); read them, and move to the page the launch asked for, before the router starts.
  await prepareTelegramLaunch();
  // The router needs the services and the services' 401 handler needs the router: late binding.
  let router: Router | null = null;
  const services = await createServices({
    // The store already dropped the person; re-resolving the current URL lets the guard send
    // them to the login with this URL as the return path (validated again when it is used).
    onSessionExpired: () => {
      if (router) void reevaluateCurrentRoute(router);
    },
  });

  const app = createApp(App);
  installErrorHandler(app, i18n);
  router = createAppRouter(services.currentUser, undefined, i18n, {
    // While this tab holds Telegram's init data, a refused sign-in is explained on its own
    // screen instead of the login form. The demo build signs nobody in through Telegram.
    viaTelegram: () => !FAKE_API_ENABLED && readInitData() !== null,
  });
  app.provide(servicesKey, services).use(i18n).use(router).mount('#app');
}

void bootstrap();
