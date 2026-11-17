import { describe, expect, it } from 'vitest';
import { parseUpdate, type BotEvent } from './bot-events.js';
import {
  languageButtons,
  languageChoiceData,
  parseLanguageChoice,
  payloadFitsChoice,
} from './language-choice.js';

// The language buttons of a private /start [C, owner 2026-11-13]: callback data is untrusted.

const ALICE = { id: 111, is_bot: false, first_name: 'Alice', language_code: 'ru' };
const ALICE_CHAT = { id: 111, type: 'private' } as const;
const OTHER_CHAT = { id: 555, type: 'private' } as const;
const GROUP = { id: -1001234567890, type: 'supergroup', title: 'Alpha' } as const;
const IGNORED: BotEvent[] = [{ kind: 'CALLBACK_IGNORED', callbackQueryId: 'cb-1' }];

const press = (data: unknown, overrides: Record<string, unknown> = {}) => ({
  update_id: 10,
  callback_query: {
    id: 'cb-1',
    from: ALICE,
    message: { message_id: 42, chat: ALICE_CHAT },
    data,
    ...overrides,
  },
});

function events(raw: unknown): BotEvent[] {
  const parsed = parseUpdate(raw);
  if (!parsed.ok) throw new Error('update rejected');
  return parsed.events;
}

describe('language choice data', () => {
  it('is lang:<code> with an optional payload, and the two binding payloads fit', () => {
    expect(languageChoiceData('UZ')).toBe('lang:uz');
    const staff = `staff_${'a'.repeat(43)}`;
    const invite = `org_${'b'.repeat(43)}`;
    expect(languageChoiceData('RU', staff)).toBe(`lang:ru:${staff}`);
    expect(payloadFitsChoice(staff)).toBe(true);
    expect(payloadFitsChoice(invite)).toBe(true);
    expect(payloadFitsChoice(undefined)).toBe(true);
  });

  it('refuses a payload that would pass Telegram 64 bytes', () => {
    const long = 'a'.repeat(57);
    expect(languageChoiceData('EN', long)).toBeNull();
    expect(payloadFitsChoice(long)).toBe(false);
    expect(languageButtons(long)).toEqual([]);
  });

  it('round-trips through the strict parser', () => {
    for (const button of languageButtons('org_x')) {
      if (!('callbackData' in button)) throw new Error('not a callback button');
      expect(parseLanguageChoice(button.callbackData)?.startPayload).toBe('org_x');
    }
  });
});

describe('parseUpdate: a language button pressed', () => {
  it('turns a press in the private chat with the presser into a choice', () => {
    expect(events(press('lang:ru'))).toEqual([
      {
        kind: 'LANGUAGE_CHOSEN',
        callbackQueryId: 'cb-1',
        chatId: 111n,
        messageId: 42,
        person: { telegramUserId: 111n, fullName: 'Alice', language: 'RU' },
        language: 'RU',
      },
    ]);
  });

  it('carries a start payload of the Telegram alphabet', () => {
    const payload = `org_${'A'.repeat(43)}`;
    expect(events(press(`lang:en:${payload}`))[0]).toMatchObject({
      kind: 'LANGUAGE_CHOSEN',
      language: 'EN',
      startPayload: payload,
    });
  });

  it.each([
    ['an unknown language', 'lang:de'],
    ['an upper-case code', 'lang:UZ'],
    ['another prefix', 'buy:uz'],
    ['a payload outside the alphabet', 'lang:uz:org_a b'],
    ['an empty payload', 'lang:uz:'],
    ['data over 64 bytes', `lang:uz:${'a'.repeat(57)}`],
    ['no data', undefined],
  ])('answers but ignores %s', (_name, data) => {
    expect(events(press(data))).toEqual(IGNORED);
  });

  it('ignores a press in a group, in another chat, by a bot, or without its message', () => {
    expect(events(press('lang:uz', { message: { message_id: 1, chat: GROUP } }))).toEqual(IGNORED);
    expect(events(press('lang:uz', { message: { message_id: 1, chat: OTHER_CHAT } }))).toEqual(
      IGNORED,
    );
    expect(events(press('lang:uz', { from: { ...ALICE, is_bot: true } }))).toEqual(IGNORED);
    expect(events(press('lang:uz', { message: undefined }))).toEqual(IGNORED);
  });

  it('rejects oversized data, an empty id and a press without its person', () => {
    expect(parseUpdate(press('x'.repeat(300)))).toEqual({ ok: false });
    expect(parseUpdate(press('lang:uz', { id: '' }))).toEqual({ ok: false });
    expect(parseUpdate({ update_id: 2, callback_query: { id: '1' } })).toEqual({ ok: false });
  });
});
