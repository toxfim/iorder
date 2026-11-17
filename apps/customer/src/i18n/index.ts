import type { Locale } from '@iorder/shared';
import { createI18nFor, type AppI18n } from '@core/i18n';
import { en } from './messages/en';
import { ru } from './messages/ru';
import { uz } from './messages/uz';

export const messages = { uz, ru, en } as const;

export function createAppI18n(initial?: Locale): AppI18n {
  return createI18nFor(messages, initial);
}
