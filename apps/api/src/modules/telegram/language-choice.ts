import type { Locale } from '@iorder/shared';
import type { MessageButton } from './telegram-sender.js';

// The language buttons of a private /start [C, owner 2026-11-13]: the bot asks the language first,
// then explains its commands. A deep-link payload (`org_<token>`, `staff_<token>`) rides in the
// button's callback data, so the binding happens only after the choice, in the chosen language.
// Callback data is UNTRUSTED (anyone can send any bytes): it is parsed strictly here, and the
// payload is checked again by the service that owns it (single use, expiry).

/** Telegram's limit for `callback_data`, in bytes (this format is ASCII only). */
export const CALLBACK_DATA_MAX_BYTES = 64;

const PREFIX = 'lang:';
const CODES = { UZ: 'uz', RU: 'ru', EN: 'en' } as const satisfies Record<Locale, string>;
const LOCALE_OF: Readonly<Record<string, Locale>> = { uz: 'UZ', ru: 'RU', en: 'EN' };

/**
 * The order and labels of the buttons: a flag and each language named in itself [owner
 * 2026-11-14: 🇺🇿 🇷🇺 🇺🇸]. The flag is only on the label; the callback data stays the code.
 */
export const LANGUAGE_BUTTONS: readonly { locale: Locale; label: string }[] = [
  { locale: 'UZ', label: "🇺🇿 O'zbekcha" },
  { locale: 'RU', label: '🇷🇺 Русский' },
  { locale: 'EN', label: '🇺🇸 English' },
];

/** One message in all three languages: the person has not chosen yet. */
export const LANGUAGE_QUESTION = 'Tilni tanlang\nВыберите язык\nChoose a language';

/**
 * `lang:<uz|ru|en>` or `lang:<uz|ru|en>:<payload>`. Null when the payload would not fit Telegram's
 * 64 bytes: the caller then handles that payload at once, as before the language question.
 */
export function languageChoiceData(locale: Locale, payload?: string): string | null {
  const data = `${PREFIX}${CODES[locale]}${payload === undefined ? '' : `:${payload}`}`;
  return data.length <= CALLBACK_DATA_MAX_BYTES ? data : null;
}

/** The three language buttons in one row, each carrying the payload (the staff bot carries none). */
export function languageButtons(payload?: string): MessageButton[] {
  return LANGUAGE_BUTTONS.flatMap(({ locale, label }) => {
    const callbackData = languageChoiceData(locale, payload);
    return callbackData === null ? [] : [{ text: label, callbackData }];
  });
}

/** True when every language button can carry this payload. */
export function payloadFitsChoice(payload: string | undefined): boolean {
  return LANGUAGE_BUTTONS.every(({ locale }) => languageChoiceData(locale, payload) !== null);
}

export interface LanguageChoice {
  language: Locale;
  /** A start payload in Telegram's own alphabet (A-Z a-z 0-9 _ -), when one was carried. */
  startPayload?: string;
}

const CHOICE = /^lang:(uz|ru|en)(?::([A-Za-z0-9_-]{1,64}))?$/;

/** The choice inside callback data, or null for anything else (never guessed). */
export function parseLanguageChoice(data: string | undefined): LanguageChoice | null {
  if (data === undefined || data.length > CALLBACK_DATA_MAX_BYTES) return null;
  const match = CHOICE.exec(data);
  const code = match?.[1];
  const language = code === undefined ? undefined : LOCALE_OF[code];
  if (language === undefined) return null;
  const startPayload = match?.[2];
  return startPayload === undefined ? { language } : { language, startPayload };
}
