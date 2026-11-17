import type { App } from 'vue';
import { showToast } from '@core/composables/use-toast';
import type { AppI18n } from '@core/i18n';

/**
 * Last line of defence for errors no <AppErrorBoundary> caught (router, async handlers outside
 * a boundary). Logged for developers, and the person gets a toast instead of a silent failure.
 */
export function installErrorHandler(app: App, i18n: AppI18n): void {
  app.config.errorHandler = (caught) => {
    console.error(caught);
    showToast({ message: i18n.global.t('state.error.title') });
  };
}
