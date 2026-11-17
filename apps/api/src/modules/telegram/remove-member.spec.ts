import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';
import {
  classifyRemoveError,
  createTelegramBot,
  GrammyTelegramSender,
  type TelegramApiResponse,
  type TelegramApiTransport,
} from './bot-factory.js';
import { TelegramSendError } from './telegram-sender.js';

// No test here reaches Telegram: the bot's transport is a recording fake.
const BOT_INFO = {
  id: 999,
  is_bot: true as const,
  first_name: 'iOrder',
  username: 'iorder_test_bot',
  can_join_groups: true as const,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

const grammyError = (code: number, description: string, retryAfter?: number): GrammyError =>
  new GrammyError(
    'call failed',
    {
      ok: false,
      error_code: code,
      description,
      ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
    },
    'banChatMember',
    {},
  );

describe('classifyRemoveError', () => {
  it.each([
    [400, 'Bad Request: chat not found', 'CHAT_NOT_FOUND'],
    [403, 'Forbidden: bot was kicked from the supergroup chat', 'CHAT_NOT_FOUND'],
    [403, 'Forbidden: bot is not a member of the channel chat', 'CHAT_NOT_FOUND'],
    [400, 'Bad Request: not enough rights to restrict/unrestrict chat member', 'BOT_NOT_ADMIN'],
    [400, 'Bad Request: CHAT_ADMIN_REQUIRED', 'BOT_NOT_ADMIN'],
    [403, 'Forbidden: bot is not an administrator', 'BOT_NOT_ADMIN'],
    [400, 'Bad Request: USER_NOT_PARTICIPANT', 'NOT_A_MEMBER'],
    [400, 'Bad Request: PARTICIPANT_ID_INVALID', 'NOT_A_MEMBER'],
    [400, "Bad Request: can't remove chat owner", 'CANNOT_REMOVE'],
    [400, 'Bad Request: user is an administrator of the chat', 'CANNOT_REMOVE'],
    [400, 'Bad Request: USER_ADMIN_INVALID', 'CANNOT_REMOVE'],
    [400, 'bad request: user_admin_invalid', 'CANNOT_REMOVE'],
    [400, "Bad Request: can't remove chat owner", 'CANNOT_REMOVE'],
    [400, "BAD REQUEST: CAN'T REMOVE CHAT OWNER", 'CANNOT_REMOVE'],
    [400, 'Bad Request: only the chat owner can do this', 'CANNOT_REMOVE'],
    [400, 'Bad Request: user is the owner of the chat', 'CANNOT_REMOVE'],
    [403, "Forbidden: can't ban an administrator", 'CANNOT_REMOVE'],
    [400, 'Bad Request: group chat was upgraded to a supergroup chat', 'CHAT_MIGRATED'],
    [400, 'Bad Request: something we have never seen', 'REJECTED'],
    [500, 'Internal Server Error', 'TRANSIENT'],
    [502, 'Bad Gateway', 'TRANSIENT'],
    [401, 'Unauthorized', 'TRANSIENT'],
  ] as const)('%i %s -> %s', (code, description, expected) => {
    expect(classifyRemoveError(grammyError(code, description)).failure).toBe(expected);
  });

  it('keeps retry_after of a 429 and treats unknown errors as transient', () => {
    const limited = classifyRemoveError(grammyError(429, 'Too Many Requests: retry after 9', 9));
    expect(limited).toMatchObject({ failure: 'RATE_LIMITED', retryAfterSeconds: 9 });
    expect(classifyRemoveError(new Error('socket hang up')).failure).toBe('TRANSIENT');
    const own = new TelegramSendError('NOT_A_MEMBER');
    expect(classifyRemoveError(own)).toBe(own);
  });

  it('a 400 with migrate_to_chat_id is CHAT_MIGRATED and carries the new id for logs only', () => {
    const error = new GrammyError(
      'call failed',
      {
        ok: false,
        error_code: 400,
        description: 'Bad Request: some wording we do not match',
        parameters: { migrate_to_chat_id: -1002233445566 },
      },
      'banChatMember',
      {},
    );
    const classified = classifyRemoveError(error);
    expect(classified).toMatchObject({
      failure: 'CHAT_MIGRATED',
      migratedToChatId: '-1002233445566',
    });
    expect(classified.message).not.toContain('2233445566');
  });

  it('never carries Telegram wording', () => {
    const error = classifyRemoveError(grammyError(400, 'Bad Request: secret details'));
    expect(error.message).not.toContain('secret');
  });
});

describe('GrammyTelegramSender.removeMember: ban succeeded, unban did not', () => {
  const ok: TelegramApiResponse = { ok: true, result: true };
  const fail = (code: number, description: string, retryAfter?: number): TelegramApiResponse => ({
    ok: false,
    error_code: code,
    description,
    ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
  });

  // Each method answers from its queue; the last answer repeats.
  function senderWith(script: Record<string, TelegramApiResponse[]>) {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const transport: TelegramApiTransport = (method) => {
      calls.push(method);
      const queue = script[method] ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return Promise.resolve(next ?? ok);
    };
    const bot = createTelegramBot({
      token: '999:FAKE-TOKEN-FOR-TESTS-ONLY',
      botInfo: BOT_INFO,
      transport,
    });
    const sender = new GrammyTelegramSender(bot, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    return { sender, calls, sleeps };
  }

  it('retries only the unban after a transient failure and then succeeds', async () => {
    const { sender, calls } = senderWith({ unbanChatMember: [fail(502, 'Bad Gateway'), ok] });
    await sender.removeMember('-1001234', '777');
    expect(calls).toEqual(['banChatMember', 'unbanChatMember', 'unbanChatMember']);
  });

  it('honours a short retry_after of the unban', async () => {
    const { sender, calls, sleeps } = senderWith({
      unbanChatMember: [fail(429, 'Too Many Requests', 2), ok],
    });
    await sender.removeMember('-1001234', '777');
    expect(calls).toEqual(['banChatMember', 'unbanChatMember', 'unbanChatMember']);
    expect(sleeps).toEqual([2000]);
  });

  it('ends as UNBAN_FAILED when the unban keeps failing; the ban is never repeated', async () => {
    const { sender, calls } = senderWith({ unbanChatMember: [fail(502, 'Bad Gateway')] });
    await expect(sender.removeMember('-1001234', '777')).rejects.toMatchObject({
      failure: 'UNBAN_FAILED',
    });
    expect(calls.filter((c) => c === 'banChatMember')).toHaveLength(1);
    expect(calls.filter((c) => c === 'unbanChatMember')).toHaveLength(3);
  });

  it('ends as UNBAN_FAILED at once for a terminal unban error (no retry)', async () => {
    const { sender, calls } = senderWith({
      unbanChatMember: [
        fail(400, 'Bad Request: not enough rights to restrict/unrestrict chat member'),
      ],
    });
    await expect(sender.removeMember('-1001234', '777')).rejects.toMatchObject({
      failure: 'UNBAN_FAILED',
    });
    expect(calls).toEqual(['banChatMember', 'unbanChatMember']);
  });

  it('ends as UNBAN_FAILED when the unban is rate limited for longer than we wait', async () => {
    const { sender, calls } = senderWith({
      unbanChatMember: [fail(429, 'Too Many Requests', 600)],
    });
    await expect(sender.removeMember('-1001234', '777')).rejects.toMatchObject({
      failure: 'UNBAN_FAILED',
    });
    expect(calls).toEqual(['banChatMember', 'unbanChatMember']);
  });

  it('a failing ban stays a plain classified failure (nothing to unban)', async () => {
    const { sender, calls } = senderWith({ banChatMember: [fail(502, 'Bad Gateway')] });
    await expect(sender.removeMember('-1001234', '777')).rejects.toMatchObject({
      failure: 'TRANSIENT',
    });
    expect(calls).toEqual(['banChatMember']);
  });
});

describe('GrammyTelegramSender.removeMember', () => {
  function senderWith(respond: (method: string) => TelegramApiResponse) {
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const transport: TelegramApiTransport = (method, payload) => {
      calls.push({ method, payload });
      return Promise.resolve(respond(method));
    };
    const bot = createTelegramBot({
      token: '999:FAKE-TOKEN-FOR-TESTS-ONLY',
      botInfo: BOT_INFO,
      transport,
    });
    return { sender: new GrammyTelegramSender(bot), calls };
  }

  it('bans, then unbans only if banned, so the person can be invited again', async () => {
    const { sender, calls } = senderWith(() => ({ ok: true, result: true }));
    await sender.removeMember('-1001234', '777');
    expect(calls.map((c) => c.method)).toEqual(['banChatMember', 'unbanChatMember']);
    expect(calls[0]?.payload).toMatchObject({ chat_id: '-1001234', user_id: 777 });
    expect(calls[1]?.payload).toMatchObject({
      chat_id: '-1001234',
      user_id: 777,
      only_if_banned: true,
    });
  });

  it('does not unban after a failed ban, and throws the classified error', async () => {
    const { sender, calls } = senderWith(() => ({
      ok: false,
      error_code: 400,
      description: 'Bad Request: not enough rights to restrict/unrestrict chat member',
    }));
    await expect(sender.removeMember('-1001234', '777')).rejects.toMatchObject({
      failure: 'BOT_NOT_ADMIN',
    });
    expect(calls.map((c) => c.method)).toEqual(['banChatMember']);
  });

  it('never removes the bot itself and refuses an id that would lose precision', async () => {
    const { sender, calls } = senderWith(() => ({ ok: true, result: true }));
    await expect(sender.removeMember('-1001234', '999')).rejects.toMatchObject({
      failure: 'CANNOT_REMOVE',
    });
    await expect(sender.removeMember('-1001234', '9007199254740993')).rejects.toMatchObject({
      failure: 'REJECTED',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('GrammyTelegramSender.removeMember: the bot never removes itself', () => {
  const build = (token: string, withInfo: boolean) => {
    const calls: string[] = [];
    const bot = createTelegramBot({
      token,
      ...(withInfo ? { botInfo: BOT_INFO } : {}),
      transport: (method) => {
        calls.push(method);
        return Promise.resolve({ ok: true, result: true });
      },
    });
    return { sender: new GrammyTelegramSender(bot), calls };
  };

  it('holds before the bot identity is loaded (getMe not called)', async () => {
    const { sender, calls } = build('999:FAKE-TOKEN-FOR-TESTS-ONLY', false);
    await expect(sender.removeMember('-1001234', '999')).rejects.toMatchObject({
      failure: 'CANNOT_REMOVE',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses everything when the bot id cannot be read from the token', async () => {
    const { sender, calls } = build('not-a-token', true);
    await expect(sender.removeMember('-1001234', '777')).rejects.toMatchObject({
      failure: 'CANNOT_REMOVE',
    });
    expect(calls).toHaveLength(0);
  });

  it('removes another person normally without the identity loaded', async () => {
    const { sender, calls } = build('999:FAKE-TOKEN-FOR-TESTS-ONLY', false);
    await sender.removeMember('-1001234', '777');
    expect(calls).toEqual(['banChatMember', 'unbanChatMember']);
  });
});
