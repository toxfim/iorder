import { config } from '@vue/test-utils';
import { createI18nFor } from '@core/i18n';

// Every mounted component can call useI18n(); the shared catalog is all the kit itself needs.
config.global.plugins = [createI18nFor({ uz: {}, ru: {}, en: {} })];
