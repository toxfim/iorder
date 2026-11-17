import '@fontsource/onest/400.css';
import '@fontsource/onest/500.css';
import '@fontsource/onest/600.css';
import '@fontsource/onest/700.css';
import '@fontsource/jetbrains-mono/500.css';
import '@core/styles/tokens.css';
import '@core/styles/base.css';

import { readStoredLocale, toI18nLocale } from '@core/i18n';
import { captureLaunchParams, readClientVersion, readInitData } from '@core/telegram/launch';
import { startMiniApp } from '@core/telegram/mini-app-bridge';
import { bootstrapCustomerApp } from './features/customer-app/bootstrap';
import { takeHandoffArrival } from './features/customer-session/site-handoff';
import { createAppI18n } from './i18n';

const locale = readStoredLocale();
document.documentElement.lang = toI18nLocale(locale);
// A one-time handoff code in the URL fragment is taken out of the address bar before anything
// else runs (site-handoff.ts).
const arrival = takeHandoffArrival();
// Telegram puts the launch parameters in the URL fragment; read them before the router starts.
captureLaunchParams();
if (readInitData() !== null) startMiniApp(readClientVersion());
void bootstrapCustomerApp(createAppI18n(locale), arrival);
