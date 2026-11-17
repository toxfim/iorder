import type { Bot } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { BotIdentity } from './bot-identity.js';
import { needsBotUsername } from './bot-events.js';

// A Bot whose getMe never answers: the transport "hangs". No network is involved.
function hangingBot(): { bot: Bot; init: ReturnType<typeof vi.fn> } {
  const init = vi.fn(() => new Promise<void>(() => undefined));
  const bot = { isInited: () => false, init, botInfo: {} } as unknown as Bot;
  return { bot, init };
}

describe('BotIdentity', () => {
  it('gives up after the timeout when Telegram never answers, and keeps asking next time', async () => {
    const { bot, init } = hangingBot();
    const identity = new BotIdentity(bot);
    const started = Date.now();
    expect(await identity.username(30)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await identity.username(30)).toBeUndefined();
    // The lookup is shared: a slow getMe is not started once per update.
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('returns and caches the username when Telegram answers', async () => {
    const init = vi.fn(() => Promise.resolve());
    const bot = {
      isInited: () => false,
      init,
      botInfo: { username: 'iorder_bot' },
    } as unknown as Bot;
    const identity = new BotIdentity(bot);
    expect(await identity.username()).toBe('iorder_bot');
    expect(await identity.username()).toBe('iorder_bot');
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure', async () => {
    const init = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const bot = { isInited: () => false, init, botInfo: { username: 'b' } } as unknown as Bot;
    const identity = new BotIdentity(bot);
    expect(await identity.username()).toBeUndefined();
    expect(await identity.username()).toBe('b');
  });

  it('is undefined without a bot', async () => {
    expect(await new BotIdentity(null).username()).toBeUndefined();
  });
});

describe('an update without /command@name never waits for Telegram', () => {
  it('needs no username for plain text, plain commands and member events', () => {
    for (const raw of [
      { update_id: 1, message: { text: 'hello' } },
      { update_id: 2, message: { text: '/price' } },
      { update_id: 3, my_chat_member: {} },
    ]) {
      expect(needsBotUsername(raw)).toBe(false);
    }
  });
});
