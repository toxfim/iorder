import { config } from '@vue/test-utils';
import { createAppI18n } from '@/i18n';

// Every mounted component can call useI18n(); tests may still install their own instance.
config.global.plugins = [createAppI18n()];
