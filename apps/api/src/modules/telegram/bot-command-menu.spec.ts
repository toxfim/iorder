import { describe, expect, it } from 'vitest';
import type { UserFromGetMe } from 'grammy/types';
import { botMenu, setBotMenus } from './bot-command-menu.js';
import { BOT_COMMANDS } from './bot-events.js';
import { createTelegramBot, type TelegramApiTransport } from './bot-factory.js';

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'Test',
  username: 'test_bot',
} as UserFromGetMe;

function recordingBot(): { bot: ReturnType<typeof createTelegramBot>; calls: unknown[] } {
  const calls: unknown[] = [];
  const transport: TelegramApiTransport = (method, payload) => {
    calls.push({ method, payload });
    return Promise.resolve({ ok: true, result: true });
  };
  return { bot: createTelegramBot({ token: '1:test', botInfo: BOT_INFO, transport }), calls };
}

describe('bot command menu [owner 2026-11-14]', () => {
  it('offers /start, /lang and /price on the main bot, /start and /lang on the staff bot', () => {
    expect(botMenu('CUSTOMER', 'UZ').map((c) => c.command)).toEqual(['start', 'lang', 'price']);
    expect(botMenu('STAFF', 'UZ').map((c) => c.command)).toEqual(['start', 'lang']);
  });

  it('lists only commands the bot answers', () => {
    for (const kind of ['CUSTOMER', 'STAFF'] as const) {
      for (const { command } of botMenu(kind, 'EN')) {
        expect(BOT_COMMANDS).toContain(command);
      }
    }
  });

  it('sets the UZ list as the default and RU and EN under their language codes', async () => {
    const { bot, calls } = recordingBot();
    await setBotMenus(bot, 'CUSTOMER');
    expect(calls).toEqual([
      {
        method: 'setMyCommands',
        payload: { commands: botMenu('CUSTOMER', 'UZ') },
      },
      {
        method: 'setMyCommands',
        payload: { commands: botMenu('CUSTOMER', 'RU'), language_code: 'ru' },
      },
      {
        method: 'setMyCommands',
        payload: { commands: botMenu('CUSTOMER', 'EN'), language_code: 'en' },
      },
    ]);
    expect(botMenu('CUSTOMER', 'RU')[1]).toEqual({ command: 'lang', description: 'Сменить язык' });
  });
});
