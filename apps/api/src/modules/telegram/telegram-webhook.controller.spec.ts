import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramWebhookController } from './telegram-webhook.controller.js';
import type { TelegramBotService } from './telegram-bot.service.js';
import { MAX_UPDATE_FAILURES } from './update-failure-tracker.js';

const SECRET = 'unit-test-secret_0123456789abcdef';

function setup(handle: (raw: unknown) => Promise<unknown>) {
  const bot = { handleWebhookUpdate: vi.fn(handle) } as unknown as TelegramBotService;
  const controller = new TelegramWebhookController(
    { TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_SECRET: SECRET },
    bot,
  );
  const receive = (body: unknown) => controller.receive(SECRET, SECRET, body);
  return { receive };
}

describe('webhook controller: faults while handling an update', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers with a generic error (5xx) and logs only the error name and the update id', async () => {
    const secretText = 'PRIVATE-MESSAGE-TEXT-and-a-name';
    const { receive } = setup(() =>
      Promise.reject(new TypeError(`could not handle ${secretText}`)),
    );
    const body = { update_id: 77, message: { text: secretText } };
    const error = await receive(body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Telegram update handling failed');
    expect((error as Error).message).not.toContain(secretText);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('77');
    expect(logged[0]).toContain('TypeError');
    expect(logged.join('\n')).not.toContain(secretText);
    expect(logged.join('\n')).not.toContain('at ');
  });

  it('keeps answering 5xx until the same update has failed MAX times, then answers 200', async () => {
    const { receive } = setup(() => Promise.reject(new Error('database down')));
    for (let attempt = 1; attempt < MAX_UPDATE_FAILURES; attempt += 1) {
      await expect(receive({ update_id: 5 })).rejects.toThrow('Telegram update handling failed');
    }
    expect(await receive({ update_id: 5 })).toEqual({ ok: true });
    // Another update is counted on its own.
    await expect(receive({ update_id: 6 })).rejects.toThrow('Telegram update handling failed');
  });

  it('forgets the failures of an update that finally succeeds', async () => {
    let fail = true;
    const { receive } = setup(() => (fail ? Promise.reject(new Error('x')) : Promise.resolve({})));
    await expect(receive({ update_id: 9 })).rejects.toThrow();
    await expect(receive({ update_id: 9 })).rejects.toThrow();
    fail = false;
    expect(await receive({ update_id: 9 })).toEqual({ ok: true });
    fail = true;
    // Counting starts again: two more failures are still 5xx.
    await expect(receive({ update_id: 9 })).rejects.toThrow();
    await expect(receive({ update_id: 9 })).rejects.toThrow();
  });

  it('an update without a usable id is never dropped (always 5xx on a fault)', async () => {
    const { receive } = setup(() => Promise.reject(new Error('x')));
    for (let i = 0; i < MAX_UPDATE_FAILURES + 2; i += 1) {
      await expect(receive({ update_id: 'nope' })).rejects.toThrow();
    }
  });
});
