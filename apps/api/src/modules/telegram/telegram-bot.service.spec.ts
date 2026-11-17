import type { Bot } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { TelegramBotService } from './telegram-bot.service.js';
import type { TelegramUpdateHandler } from './telegram-update.handler.js';

function fakeBot() {
  const bot = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    use: vi.fn(),
    catch: vi.fn(),
    init: vi.fn(),
  };
  return { bot, asBot: bot as unknown as Bot };
}

const handler = { handle: vi.fn(() => Promise.resolve({ accepted: true, events: 0 })) };

function service(mode: 'off' | 'polling' | 'webhook', bot: Bot | null) {
  return new TelegramBotService(
    { TELEGRAM_MODE: mode },
    bot,
    handler as unknown as TelegramUpdateHandler,
  );
}

describe('TelegramBotService never starts anything by itself', () => {
  it.each(['off', 'polling', 'webhook'] as const)(
    'constructing it in %s mode does not poll or init',
    async (mode) => {
      const { bot, asBot } = fakeBot();
      const svc = service(mode, asBot);
      await svc.onModuleDestroy();
      expect(bot.start).not.toHaveBeenCalled();
      expect(bot.init).not.toHaveBeenCalled();
      expect(bot.stop).not.toHaveBeenCalled();
    },
  );

  it.each(['off', 'webhook'] as const)('refuses to start polling in %s mode', async (mode) => {
    const { bot, asBot } = fakeBot();
    await expect(service(mode, asBot).startPolling()).rejects.toThrow(/TELEGRAM_MODE/);
    expect(bot.start).not.toHaveBeenCalled();
  });

  it('refuses to start polling without a bot token', async () => {
    await expect(service('polling', null).startPolling()).rejects.toThrow(/token/);
  });

  it('starts polling only when asked in polling mode, for the update kinds it reads', async () => {
    const { bot, asBot } = fakeBot();
    await service('polling', asBot).startPolling();
    expect(bot.start).toHaveBeenCalledTimes(1);
    const options = bot.start.mock.calls[0] as unknown as [{ allowed_updates: string[] }];
    expect(options[0].allowed_updates).toEqual([
      'message',
      'my_chat_member',
      'chat_member',
      'callback_query',
    ]);
  });
});
