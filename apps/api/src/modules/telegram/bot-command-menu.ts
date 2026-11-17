import type { Locale } from '@iorder/shared';
import type { Bot } from 'grammy';

// The command menu Telegram shows next to the message field (`setMyCommands`) [owner 2026-11-14:
// "/lang /start /price as bot commands"]. Telegram picks the list by the language of the person's
// Telegram app, not by the language stored in iOrder: UZ is the default list (no language code),
// RU and EN have their own. `/help` still answers but stays out of the menu (the owner named three).
// The staff bot gets no `/price`: it answers its private chat only and sends no price file.

export type BotMenuKind = 'CUSTOMER' | 'STAFF';

export interface MenuCommand {
  command: string;
  description: string;
}

const DESCRIPTIONS: Record<Locale, Record<'start' | 'lang' | 'price', string>> = {
  UZ: { start: 'Ilovani ochish', lang: "Tilni o'zgartirish", price: "Narxlar ro'yxati (Excel)" },
  RU: { start: 'Открыть приложение', lang: 'Сменить язык', price: 'Прайс-лист (Excel)' },
  EN: { start: 'Open the app', lang: 'Change the language', price: 'Price list (Excel)' },
};

const COMMANDS_OF: Record<BotMenuKind, readonly ('start' | 'lang' | 'price')[]> = {
  CUSTOMER: ['start', 'lang', 'price'],
  STAFF: ['start', 'lang'],
};

/** Telegram's `language_code` per list; null = the default list (UZ). */
const LANGUAGE_CODE: Record<Locale, 'ru' | 'en' | null> = { UZ: null, RU: 'ru', EN: 'en' };

export function botMenu(kind: BotMenuKind, locale: Locale): MenuCommand[] {
  return COMMANDS_OF[kind].map((command) => ({
    command,
    description: DESCRIPTIONS[locale][command],
  }));
}

/**
 * Replaces the bot's menus: the default list (UZ) and one per other language. Idempotent: running
 * it again sets the same lists. Talks to Telegram, so only the `bot:set-commands` CLI calls it.
 */
export async function setBotMenus(bot: Pick<Bot, 'api'>, kind: BotMenuKind): Promise<void> {
  for (const locale of Object.keys(LANGUAGE_CODE) as Locale[]) {
    const languageCode = LANGUAGE_CODE[locale];
    const commands = botMenu(kind, locale);
    if (languageCode === null) await bot.api.setMyCommands(commands);
    else await bot.api.setMyCommands(commands, { language_code: languageCode });
  }
}
