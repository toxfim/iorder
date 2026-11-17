import { InputFile } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifySendError,
  createTelegramBot,
  GrammyTelegramSender,
  type TelegramApiResponse,
  type TelegramApiTransport,
} from './bot-factory.js';
import { TelegramSendError } from './telegram-sender.js';

// A fake token: every call below goes to the recording transport, never to the network.
const FAKE_TOKEN = '123456:FAKE-TOKEN-FOR-TESTS-ONLY';
const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: 'iOrder',
  username: 'iorder_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
} as const;

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function recordingTransport(answer: (call: Call) => TelegramApiResponse) {
  const calls: Call[] = [];
  const transport: TelegramApiTransport = (method, payload) => {
    const call = { method, payload };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { calls, transport };
}

const ok: TelegramApiResponse = {
  ok: true,
  result: { message_id: 1, chat: { id: 1 }, date: 1, text: 'x' },
};

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // If anything tried to reach the real network, this makes the test fail loudly.
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('network is forbidden in tests'));
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe('createTelegramBot with an injected transport', () => {
  it('sends through the transport and never touches the network', async () => {
    const { calls, transport } = recordingTransport(() => ok);
    const bot = createTelegramBot({ token: FAKE_TOKEN, botInfo: BOT_INFO, transport });
    await new GrammyTelegramSender(bot).sendMessage('-1001', 'hello', { disableLinkPreview: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'sendMessage',
      payload: { chat_id: '-1001', text: 'hello', link_preview_options: { is_disabled: true } },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('puts a url button and a Mini App button in one row under a message', async () => {
    const { calls, transport } = recordingTransport(() => ok);
    const bot = createTelegramBot({ token: FAKE_TOKEN, botInfo: BOT_INFO, transport });
    await new GrammyTelegramSender(bot).sendMessage('111', 'order', {
      buttons: [
        { text: 'Web', url: 'https://staff.example.uz/staff/orders/o1' },
        { text: 'Mini App', webAppUrl: 'https://staff.example.uz/staff/orders/o1' },
      ],
    });
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Web', url: 'https://staff.example.uz/staff/orders/o1' },
            { text: 'Mini App', web_app: { url: 'https://staff.example.uz/staff/orders/o1' } },
          ],
        ],
      },
    });
  });

  it('passes a button colour on, and leaves it out when none is given', async () => {
    const { calls, transport } = recordingTransport(() => ok);
    const bot = createTelegramBot({ token: FAKE_TOKEN, botInfo: BOT_INFO, transport });
    await new GrammyTelegramSender(bot).sendMessage('111', 'hi', {
      buttons: [
        { text: 'Browser', url: 'https://staff.example.uz/' },
        { text: 'App', webAppUrl: 'https://staff.example.uz/', style: 'primary' },
      ],
    });
    const markup = calls[0]?.payload['reply_markup'] as { inline_keyboard: unknown[][] };
    expect(markup.inline_keyboard).toEqual([
      [
        { text: 'Browser', url: 'https://staff.example.uz/' },
        { text: 'App', web_app: { url: 'https://staff.example.uz/' }, style: 'primary' },
      ],
    ]);
  });

  it('sends a document as an InputFile with a caption and a url button, offline', async () => {
    const { calls, transport } = recordingTransport(() => ok);
    const bot = createTelegramBot({ token: FAKE_TOKEN, botInfo: BOT_INFO, transport });
    await new GrammyTelegramSender(bot).sendDocument(
      '-1001',
      { fileName: 'iorder-price-2026-10-21.xlsx', data: new Uint8Array([1, 2, 3]) },
      { caption: 'cap', button: { text: 'Open', url: 'https://t.me/bot/app' } },
    );
    expect(calls[0]).toMatchObject({
      method: 'sendDocument',
      payload: {
        chat_id: '-1001',
        caption: 'cap',
        reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://t.me/bot/app' }]] },
      },
    });
    expect(calls[0]?.payload['document']).toBeInstanceOf(InputFile);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('classifies a failed document send like a failed message', async () => {
    const { transport } = recordingTransport(() => ({
      ok: false,
      error_code: 403,
      description: 'Forbidden',
    }));
    const bot = createTelegramBot({ token: FAKE_TOKEN, botInfo: BOT_INFO, transport });
    const error = await new GrammyTelegramSender(bot)
      .sendDocument('1', { fileName: 'a.xlsx', data: new Uint8Array() })
      .catch((e: unknown) => e);
    expect((error as TelegramSendError).failure).toBe('RECIPIENT_UNREACHABLE');
  });

  it('does not call getMe when a fake bot identity is given', async () => {
    const { calls, transport } = recordingTransport(() => ok);
    const bot = createTelegramBot({ token: FAKE_TOKEN, botInfo: BOT_INFO, transport });
    await bot.init();
    expect(calls).toEqual([]);
    expect(bot.botInfo.username).toBe('iorder_test_bot');
  });

  it('mentions a person by id with a text_mention entity, the text staying plain', async () => {
    const { calls, transport } = recordingTransport(() => ok);
    const bot = createTelegramBot({ token: FAKE_TOKEN, botInfo: BOT_INFO, transport });
    // The name is hostile on purpose: with an entity nothing in the text is ever markup.
    const name = '<b>Ali</b> & "Vali" \u{1F600}';
    const text = `Order IO-1 approved.\nOrdered by: ${name}`;
    await new GrammyTelegramSender(bot).sendMessage('-1001', text, {
      mentions: [{ offset: text.length - name.length, length: name.length, userId: '5550001' }],
    });
    const payload = calls[0]?.payload;
    expect(payload).not.toHaveProperty('parse_mode');
    expect(payload?.text).toBe(text);
    expect(payload?.entities).toEqual([
      {
        type: 'text_mention',
        offset: text.length - name.length,
        length: name.length,
        user: { id: 5550001, is_bot: false, first_name: name },
      },
    ]);
  });

  it('drops a mention it cannot express and still sends the text', async () => {
    const { calls, transport } = recordingTransport(() => ok);
    const bot = createTelegramBot({ token: FAKE_TOKEN, botInfo: BOT_INFO, transport });
    await new GrammyTelegramSender(bot).sendMessage('-1001', 'hello Ali', {
      mentions: [
        { offset: 6, length: 3, userId: '99999999999999999999' },
        { offset: 6, length: 3, userId: 'abc' },
        { offset: 6, length: 30, userId: '5550001' },
        { offset: -1, length: 3, userId: '5550001' },
      ],
    });
    expect(calls[0]?.payload.text).toBe('hello Ali');
    expect(calls[0]?.payload).not.toHaveProperty('entities');
  });

  it('sends no parse mode: messages are plain text', async () => {
    const { calls, transport } = recordingTransport(() => ok);
    const bot = createTelegramBot({ token: FAKE_TOKEN, botInfo: BOT_INFO, transport });
    await new GrammyTelegramSender(bot).sendMessage('1', '<b>*not markup*</b>');
    expect(calls[0]?.payload).not.toHaveProperty('parse_mode');
  });
});

describe('send failures are classified by code, never by body', () => {
  async function failure(response: TelegramApiResponse): Promise<TelegramSendError> {
    const { transport } = recordingTransport(() => response);
    const sender = new GrammyTelegramSender(
      createTelegramBot({ token: FAKE_TOKEN, botInfo: BOT_INFO, transport }),
    );
    const error = await sender.sendMessage('1', 'secret order text').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramSendError);
    return error as TelegramSendError;
  }

  it('403 (blocked, kicked) is RECIPIENT_UNREACHABLE', async () => {
    const error = await failure({
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    expect(error.failure).toBe('RECIPIENT_UNREACHABLE');
  });

  it('429 is RATE_LIMITED and carries retry_after', async () => {
    const error = await failure({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 17',
      parameters: { retry_after: 17 },
    });
    expect(error.failure).toBe('RATE_LIMITED');
    expect(error.retryAfterSeconds).toBe(17);
  });

  it('400 "chat not found" (a person who never started the bot) is RECIPIENT_UNREACHABLE', async () => {
    const error = await failure({
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    });
    expect(error.failure).toBe('RECIPIENT_UNREACHABLE');
  });

  it('other 400s are REJECTED', async () => {
    const error = await failure({
      ok: false,
      error_code: 400,
      description: 'Bad Request: message is too long',
    });
    expect(error.failure).toBe('REJECTED');
  });

  it.each([500, 502, 401, 404])('%i is TRANSIENT', async (code) => {
    const error = await failure({ ok: false, error_code: code, description: 'Something' });
    expect(error.failure).toBe('TRANSIENT');
  });

  it('a transport that throws (network down) is TRANSIENT', async () => {
    const sender = new GrammyTelegramSender(
      createTelegramBot({
        token: FAKE_TOKEN,
        botInfo: BOT_INFO,
        transport: () => Promise.reject(new Error('ECONNRESET')),
      }),
    );
    const error = (await sender
      .sendMessage('1', 'x')
      .catch((e: unknown) => e)) as TelegramSendError;
    expect(error.failure).toBe('TRANSIENT');
  });

  it('the thrown error carries neither the message text nor the Telegram description', async () => {
    const error = await failure({
      ok: false,
      error_code: 403,
      description: 'Forbidden: SECRET-DESCRIPTION',
    });
    expect(JSON.stringify([error.message, error.name, Object.entries(error)])).not.toMatch(
      /secret order text|SECRET-DESCRIPTION/,
    );
  });

  it('classifySendError keeps a TelegramSendError as it is and maps anything else to TRANSIENT', () => {
    const own = new TelegramSendError('REJECTED');
    expect(classifySendError(own)).toBe(own);
    expect(classifySendError(new Error('boom')).failure).toBe('TRANSIENT');
    expect(classifySendError('weird').failure).toBe('TRANSIENT');
  });
});
