import { describe, expect, it } from 'vitest';
import {
  localeFromTelegram,
  needsBotUsername,
  parseCommand,
  parseStartPayload,
  parseUpdate,
  type BotEvent,
} from './bot-events.js';

const GROUP = { id: -1001234567890, type: 'supergroup', title: 'Alpha Trade' } as const;
const PRIVATE = { id: 555, type: 'private' } as const;
const ALICE = {
  id: 111,
  is_bot: false,
  first_name: 'Alice',
  last_name: 'Karimova',
  language_code: 'ru',
};
const BOB = { id: 222, is_bot: false, first_name: 'Bob' };
const BOT = { id: 999, is_bot: true, first_name: 'iOrder', username: 'iorder_bot' };
const DATE = 1_790_000_000;

function events(raw: unknown, username?: string): BotEvent[] {
  const parsed = parseUpdate(raw, username);
  if (!parsed.ok) throw new Error('update rejected');
  return parsed.events;
}

describe('parseUpdate: untrusted input', () => {
  it.each([null, undefined, 42, 'text', [], {}, { update_id: 'x' }, { update_id: -1 }])(
    'rejects %j without throwing',
    (raw) => {
      expect(parseUpdate(raw)).toEqual({ ok: false });
    },
  );

  it('rejects a message whose chat has an unknown type or a non-integer id', () => {
    const base = { update_id: 1, message: { date: DATE, from: ALICE, text: 'hi' } };
    expect(
      parseUpdate({ ...base, message: { ...base.message, chat: { id: 1, type: 'weird' } } }),
    ).toEqual({ ok: false });
    expect(
      parseUpdate({ ...base, message: { ...base.message, chat: { id: 1.5, type: 'group' } } }),
    ).toEqual({ ok: false });
    expect(
      parseUpdate({ ...base, message: { ...base.message, chat: { id: 2 ** 60, type: 'group' } } }),
    ).toEqual({ ok: false });
  });

  it('ignores update kinds the bot does not read', () => {
    expect(events({ update_id: 1, edited_message: { text: 'x' } })).toEqual([]);
    // A button press without the person who pressed it is not a valid update.
    expect(parseUpdate({ update_id: 2, callback_query: { id: '1' } })).toEqual({ ok: false });
  });

  it('turns ids into bigint and ignores unknown fields', () => {
    const [event] = events({
      update_id: 3,
      surprise: { nested: true },
      my_chat_member: {
        chat: GROUP,
        date: DATE,
        from: ALICE,
        old_chat_member: { status: 'left', user: BOT },
        new_chat_member: { status: 'member', user: BOT, extra: 1 },
      },
    });
    expect(event).toEqual({
      kind: 'BOT_ADDED',
      chatId: -1001234567890n,
      title: 'Alpha Trade',
      addedBy: { telegramUserId: 111n, name: 'Alice Karimova' },
      eventAt: new Date(DATE * 1000),
    });
  });

  it('reads who added the bot, and none when Telegram does not say (or it is a bot)', () => {
    const added = (from?: object) =>
      events({
        update_id: 3,
        my_chat_member: {
          chat: GROUP,
          date: DATE,
          ...(from ? { from } : {}),
          new_chat_member: { status: 'member', user: BOT },
        },
      })[0];
    expect(added(ALICE)).toMatchObject({ addedBy: { telegramUserId: 111n } });
    expect(added()).toMatchObject({ addedBy: null });
    expect(added(BOT)).toMatchObject({ addedBy: null });
  });

  it('asks for the bot username only for a command with @name', () => {
    const text = (value: unknown) => ({ update_id: 1, message: { text: value } });
    expect(needsBotUsername(text('/price@iorder_bot'))).toBe(true);
    expect(needsBotUsername(text('/price'))).toBe(false);
    expect(needsBotUsername(text('hello /price@iorder_bot'))).toBe(false);
    expect(needsBotUsername(text(42))).toBe(false);
    expect(needsBotUsername({ update_id: 1 })).toBe(false);
    expect(needsBotUsername(null)).toBe(false);
    expect(needsBotUsername('/price@x')).toBe(false);
  });
});

describe('the bot added to or removed from a chat (my_chat_member)', () => {
  const update = (chat: object, status: string, extra: object = {}) => ({
    update_id: 1,
    my_chat_member: {
      chat,
      date: DATE,
      new_chat_member: { status, user: BOT, ...extra },
    },
  });

  it.each(['member', 'administrator'])('is BOT_ADDED for status %s in a group', (status) => {
    expect(events(update(GROUP, status))[0]?.kind).toBe('BOT_ADDED');
    expect(events(update({ ...GROUP, type: 'group' }, status))[0]?.kind).toBe('BOT_ADDED');
  });

  it.each(['left', 'kicked'])('is BOT_REMOVED for status %s', (status) => {
    expect(events(update(GROUP, status))[0]?.kind).toBe('BOT_REMOVED');
  });

  it('treats a restricted bot as present only while it is still a member', () => {
    expect(events(update(GROUP, 'restricted', { is_member: true }))[0]?.kind).toBe('BOT_ADDED');
    expect(events(update(GROUP, 'restricted', { is_member: false }))[0]?.kind).toBe('BOT_REMOVED');
  });

  it('ignores private chats (a person blocking the bot) and channels', () => {
    expect(events(update(PRIVATE, 'kicked'))).toEqual([]);
    expect(events(update({ id: -1009, type: 'channel', title: 'News' }, 'member'))).toEqual([]);
  });
});

describe('members joining and leaving', () => {
  const change = (status: string, user: object = ALICE, chat: object = GROUP) => ({
    update_id: 1,
    chat_member: { chat, date: DATE, new_chat_member: { status, user } },
  });

  it('chat_member: a new member is MEMBER_PRESENT with the Telegram name and language', () => {
    expect(events(change('member'))).toEqual([
      {
        kind: 'MEMBER_PRESENT',
        chatId: -1001234567890n,
        person: { telegramUserId: 111n, fullName: 'Alice Karimova', language: 'RU' },
        source: 'JOIN',
        eventAt: new Date(DATE * 1000),
      },
    ]);
  });

  it.each(['left', 'kicked'])('chat_member: status %s is MEMBER_LEFT', (status) => {
    expect(events(change(status))[0]).toMatchObject({ kind: 'MEMBER_LEFT', telegramUserId: 111n });
  });

  it('chat_member: other bots and private chats are ignored', () => {
    expect(events(change('member', BOT))).toEqual([]);
    expect(events(change('member', ALICE, PRIVATE))).toEqual([]);
  });

  it('service message new_chat_members yields one event per human, never for bots', () => {
    const result = events({
      update_id: 1,
      message: { date: DATE, chat: GROUP, from: ALICE, new_chat_members: [BOB, BOT] },
    });
    expect(result.map((e) => e.kind)).toEqual(['MEMBER_PRESENT']);
    expect(result[0]).toMatchObject({ person: { telegramUserId: 222n } });
  });

  it('service message left_chat_member is MEMBER_LEFT and does not count the leaver as present', () => {
    const result = events({
      update_id: 1,
      message: { date: DATE, chat: GROUP, from: BOB, left_chat_member: BOB },
    });
    expect(result.map((e) => e.kind)).toEqual(['MEMBER_LEFT']);
  });

  it('a title change is TITLE_CHANGED and not a presence signal for the actor', () => {
    const result = events({
      update_id: 1,
      message: { date: DATE, chat: GROUP, from: ALICE, new_chat_title: 'Alpha Trade LLC' },
    });
    expect(result).toEqual([
      {
        kind: 'TITLE_CHANGED',
        chatId: -1001234567890n,
        title: 'Alpha Trade LLC',
        eventAt: new Date(DATE * 1000),
      },
    ]);
  });

  it('migration to a supergroup is CHAT_MIGRATED', () => {
    const result = events({
      update_id: 1,
      message: {
        date: DATE,
        chat: { id: -4242, type: 'group', title: 'Old' },
        migrate_to_chat_id: -1001234567890,
      },
    });
    expect(result).toEqual([
      {
        kind: 'CHAT_MIGRATED',
        fromChatId: -4242n,
        toChatId: -1001234567890n,
        eventAt: new Date(DATE * 1000),
      },
    ]);
  });
});

describe('messages as presence signals and commands', () => {
  const message = (extra: object, from: object = ALICE, chat: object = GROUP) => ({
    update_id: 1,
    message: { date: DATE, chat, from, ...extra },
  });

  it('a group message from a person is a MESSAGE presence signal', () => {
    expect(events(message({ text: 'hello' }))).toEqual([
      expect.objectContaining({ kind: 'MEMBER_PRESENT', source: 'MESSAGE' }),
    ]);
  });

  it('messages from bots, Telegram service accounts and channels prove nothing', () => {
    expect(events(message({ text: 'x' }, BOT))).toEqual([]);
    expect(
      events(message({ text: 'x' }, { id: 777000, is_bot: false, first_name: 'Telegram' })),
    ).toEqual([]);
    expect(events(message({ text: 'x', sender_chat: { id: -100999 } }))).toEqual([]);
  });

  it('a private message gives no presence signal, but a command is a COMMAND', () => {
    expect(events(message({ text: 'hello' }, ALICE, PRIVATE))).toEqual([]);
    expect(events(message({ text: '/start' }, ALICE, PRIVATE))).toEqual([
      expect.objectContaining({ kind: 'COMMAND', command: 'start', chatType: 'private' }),
    ]);
  });

  it('a command in a group gives presence and the command', () => {
    expect(events(message({ text: '/price' })).map((e) => e.kind)).toEqual([
      'MEMBER_PRESENT',
      'COMMAND',
    ]);
  });

  it('ignores a command addressed to another bot', () => {
    expect(events(message({ text: '/price@other_bot' }), 'iorder_bot').map((e) => e.kind)).toEqual([
      'MEMBER_PRESENT',
    ]);
    expect(events(message({ text: '/price@IOrder_Bot' }), 'iorder_bot').map((e) => e.kind)).toEqual(
      ['MEMBER_PRESENT', 'COMMAND'],
    );
  });

  it('ignores channels entirely', () => {
    expect(events(message({ text: '/start' }, ALICE, { id: -1009, type: 'channel' }))).toEqual([]);
  });
});

describe('parseCommand', () => {
  it.each([
    ['/start', 'start'],
    ['/START', 'start'],
    ['/price', 'price'],
    ['/price 123', 'price'],
    ['/help\nmore', 'help'],
    ['/help@iorder_bot', 'help'],
  ])('%j -> %s', (text, command) => {
    expect(parseCommand(text, 'iorder_bot')).toBe(command);
  });

  it.each(['', 'price', ' /price', '/pricelist', '/unknown', '/price@other', '//price', undefined])(
    '%j -> nothing',
    (text) => {
      expect(parseCommand(text, 'iorder_bot')).toBeNull();
    },
  );

  it('does not accept a bot-addressed command when the bot name is unknown', () => {
    expect(parseCommand('/price@iorder_bot', undefined)).toBeNull();
    expect(parseCommand('/price', undefined)).toBe('price');
  });
});

describe('localeFromTelegram', () => {
  it.each([
    ['ru', 'RU'],
    ['ru-RU', 'RU'],
    ['en', 'EN'],
    ['EN-gb', 'EN'],
    ['uz', 'UZ'],
    ['de', 'UZ'],
    [undefined, 'UZ'],
    ['', 'UZ'],
  ])('%j -> %s (UZ is the default)', (code, locale) => {
    expect(localeFromTelegram(code)).toBe(locale);
  });
});

describe('deep-link start payloads', () => {
  it.each([
    ['/start staff_abc-DEF_123', 'staff_abc-DEF_123'],
    ['/start@iorder_bot staff_x', 'staff_x'],
    ['/start', undefined],
    ['/start ', undefined],
    ['/start two words', undefined],
    ['/start has.dot', undefined],
    [`/start ${'a'.repeat(65)}`, undefined],
    ['/help staff_x', undefined],
  ])('%j -> %s', (text, payload) => {
    expect(parseStartPayload(text)).toBe(payload);
  });

  it('puts the payload on a start in a private chat and in a group (a startgroup link)', () => {
    const message = (type: 'private' | 'supergroup', text: string) => ({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_760_000_000,
        chat: { id: type === 'private' ? 111 : -100, type, title: 'x' },
        from: { id: 111, is_bot: false, first_name: 'A' },
        text,
      },
    });
    const commandOf = (raw: unknown) =>
      (
        parseUpdate(raw) as { ok: true; events: { kind: string; startPayload?: string }[] }
      ).events.find((event) => event.kind === 'COMMAND');
    expect(commandOf(message('private', '/start staff_x'))?.startPayload).toBe('staff_x');
    expect(commandOf(message('supergroup', '/start org_x'))?.startPayload).toBe('org_x');
  });
});
