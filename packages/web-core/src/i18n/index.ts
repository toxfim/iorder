import { DEFAULT_LOCALE, LOCALES, type Locale } from '@iorder/shared';
import { createI18n } from 'vue-i18n';
import { readStorage } from '@core/lib/safe-storage';
import { coreEn } from './messages/en';
import { coreRu } from './messages/ru';
import { coreUz } from './messages/uz';

// The shared contract names locales in upper case (UZ, RU, EN); vue-i18n and <html lang> use
// lower case. The mapping lives here only.
export type I18nLocale = 'uz' | 'ru' | 'en';

// Each language is named in itself, in every UI language, so a person who cannot read the
// current language can still find theirs. That is why these are not in the message catalogs.
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  UZ: "O'zbekcha",
  RU: 'Русский',
  EN: 'English',
};

export const LOCALE_STORAGE_KEY = 'iorder.locale';

export function toI18nLocale(locale: Locale): I18nLocale {
  return locale.toLowerCase() as I18nLocale;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function readStoredLocale(): Locale {
  const stored = readStorage(LOCALE_STORAGE_KEY);
  return isLocale(stored) ? stored : DEFAULT_LOCALE;
}

/** The catalog sections every app shares (common words, view states, api errors). */
export const coreMessages = { uz: coreUz, ru: coreRu, en: coreEn } as const;

/** One catalog per language; an app passes its own sections next to the shared ones. */
export type AppMessages = Readonly<Record<I18nLocale, Readonly<Record<string, unknown>>>>;

/**
 * Russian has three plural forms: 1, 21, 101 (one) / 2-4, 22-24 (few) / 0, 5-20, 25-30 (many).
 * Messages that show a count list them in this order: `one | few | many`. English uses
 * vue-i18n's default `singular | plural`; Uzbek counts take no plural form (the message has no
 * `|`), so the same call works in all three languages.
 */
export function russianPlural(choice: number, choicesLength: number): number {
  if (choicesLength !== 3) return choice === 1 ? 0 : 1;
  const n = Math.abs(choice);
  const lastDigit = n % 10;
  const lastTwo = n % 100;
  if (lastDigit === 1 && lastTwo !== 11) return 0;
  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14)) return 1;
  return 2;
}

export function createI18nFor(appMessages: AppMessages, initial: Locale = DEFAULT_LOCALE) {
  const messages = {
    uz: { ...coreMessages.uz, ...appMessages.uz },
    ru: { ...coreMessages.ru, ...appMessages.ru },
    en: { ...coreMessages.en, ...appMessages.en },
  };
  return createI18n({
    // Composition API only; the legacy Options-API mode is not used in these apps.
    legacy: false,
    locale: toI18nLocale(initial),
    // Uzbek is the default and the source of truth, so a missing key falls back to it.
    fallbackLocale: toI18nLocale(DEFAULT_LOCALE),
    // A copy: mergeLocaleMessage (lazy staff labels) writes into what it was given, and the
    // catalogs must stay untouched between instances.
    messages: structuredClone(messages),
    pluralRules: { ru: russianPlural },
  });
}

export type AppI18n = ReturnType<typeof createI18nFor>;
