import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../../common/clock/clock.js';
import type { IdentityService, TelegramPerson } from '../../identity/index.js';
import { FakeTelegramSender } from '../fake-telegram-sender.js';
import { WebLinks } from '../web-links.js';
import { StaffBotWebhookController } from './staff-bot-webhook.controller.js';
import { StaffBotService } from './staff-bot.service.js';

const SECRET = 'staff-bot-secret_0123456789abcdef';
const STAFF_URL = 'https://dashboard.example.uz';
// 03:00 UTC = 08:00 in Tashkent: a morning greeting.
const MORNING = new Date('2026-11-10T03:00:00Z');

class FixedClock extends Clock {
  constructor(private readonly at: Date) {
    super();
  }
  now(): Date {
    return this.at;
  }
}

const person = (fields: Partial<TelegramPerson>): TelegramPerson => ({
  userId: 'u1',
  telegramUserId: 111n,
  fullName: 'Sardor Aliyev',
  language: 'UZ',
  status: 'ACTIVE',
  staffRoles: ['MANAGER'],
  membership: null,
  ...fields,
});

function privateCommand(
  text: string,
  chat: { id: number; type: string } = { id: 111, type: 'private' },
) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_790_000_000,
      chat,
      from: { id: 111, is_bot: false, first_name: 'Sardor', language_code: 'uz' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
    },
  };
}

function setup(
  options: { stored?: TelegramPerson | null; sender?: FakeTelegramSender | null } = {},
) {
  const sender = options.sender === undefined ? new FakeTelegramSender() : options.sender;
  const identity = {
    findTelegramPerson: vi.fn(() =>
      Promise.resolve(options.stored === undefined ? person({}) : options.stored),
    ),
    setLanguageByTelegram: vi.fn(() => Promise.resolve('CHANGED')),
  } as unknown as IdentityService;
  const service = new StaffBotService(
    sender,
    identity,
    new WebLinks('https://order.example.uz', undefined, STAFF_URL),
    new FixedClock(MORNING),
  );
  return { service, sender, identity };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function press(data: string, chat: { id: number; type: string } = { id: 111, type: 'private' }) {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb-1',
      from: { id: 111, is_bot: false, first_name: 'Sardor', language_code: 'uz' },
      message: { message_id: 42, chat },
      data,
    },
  };
}

const COMMANDS_UZ =
  "Buyruqlar:\n/start: tilni tanlash va ilovani ochish\n/lang: tilni o'zgartirish\n" +
  '/help: ilova tugmalari va shu yordam';

describe('StaffBotService', () => {
  it('answers /start with the language question and three buttons, writing nothing', async () => {
    const { service, sender, identity } = setup();
    expect(await service.handleUpdate(privateCommand('/start'))).toBe('REPLIED');
    expect(sender?.sent).toEqual([
      {
        chatId: '111',
        text: 'Tilni tanlang\nВыберите язык\nChoose a language',
        options: {
          disableLinkPreview: true,
          buttons: [
            { text: "🇺🇿 O'zbekcha", callbackData: 'lang:uz' },
            { text: '🇷🇺 Русский', callbackData: 'lang:ru' },
            { text: '🇺🇸 English', callbackData: 'lang:en' },
          ],
        },
      },
    ]);
    expect(identity.setLanguageByTelegram).not.toHaveBeenCalled();
  });

  it('asks the language again on /lang [owner 2026-11-14]', async () => {
    const { service, sender, identity } = setup();
    expect(await service.handleUpdate(privateCommand('/lang'))).toBe('REPLIED');
    expect(sender?.sent[0]?.text).toBe('Tilni tanlang\nВыберите язык\nChoose a language');
    expect(sender?.sent[0]?.options?.buttons).toHaveLength(3);
    expect(identity.setLanguageByTelegram).not.toHaveBeenCalled();
  });

  it('after the choice greets an active staff member, explains the commands, both buttons', async () => {
    const { service, sender, identity } = setup();
    expect(await service.handleUpdate(press('lang:uz'))).toBe('REPLIED');
    expect(sender?.answeredCallbacks).toEqual(['cb-1']);
    expect(sender?.clearedButtons).toEqual([{ chatId: '111', messageId: 42 }]);
    expect(identity.setLanguageByTelegram).toHaveBeenCalledWith(111n, 'UZ');
    expect(sender?.sent).toEqual([
      {
        chatId: '111',
        text: `Xayrli tong, Sardor!\n\n${COMMANDS_UZ}\n\niOrder ilovasini oching:`,
        options: {
          disableLinkPreview: true,
          buttons: [
            { text: 'Brauzerda ochish', url: `${STAFF_URL}/` },
            { text: 'Ilovada ochish', webAppUrl: `${STAFF_URL}/`, style: 'primary' },
          ],
        },
      },
    ]);
  });

  it('answers in the chosen language, whatever was stored before', async () => {
    const { service, sender } = setup({ stored: person({ language: 'UZ' }) });
    await service.handleUpdate(press('lang:ru'));
    expect(sender?.sent[0]?.text).toMatch(/^Доброе утро, Sardor!\n\nКоманды:/);
  });

  it("answers /help at once in the staff member's stored language", async () => {
    const { service, sender } = setup({ stored: person({ language: 'RU' }) });
    await service.handleUpdate(privateCommand('/help'));
    expect(sender?.sent[0]?.text).toMatch(/^Доброе утро, Sardor!/);
    expect(sender?.sent[0]?.options?.buttons).toHaveLength(2);
  });

  it.each([
    ['an unknown person', null],
    ['a customer', person({ staffRoles: [] })],
    ['a blocked staff member', person({ status: 'BLOCKED' })],
  ])('tells %s after the choice only that the bot is for staff', async (_label, stored) => {
    const { service, sender } = setup({ stored });
    expect(await service.handleUpdate(press('lang:uz'))).toBe('REPLIED');
    expect(sender?.sent).toEqual([
      {
        chatId: '111',
        text: 'Bu bot faqat iOrder xodimlari uchun.',
        options: { disableLinkPreview: true },
      },
    ]);
  });

  it('answers any other press without a reply', async () => {
    const { service, sender, identity } = setup();
    expect(await service.handleUpdate(press('buy:1'))).toBe('IGNORED');
    expect(sender?.answeredCallbacks).toEqual(['cb-1']);
    expect(sender?.sent).toEqual([]);
    expect(identity.setLanguageByTelegram).not.toHaveBeenCalled();
  });

  it('ignores group messages, plain text and malformed updates without a query', async () => {
    const { service, sender, identity } = setup();
    const group = privateCommand('/start', { id: -1001, type: 'supergroup' });
    expect(await service.handleUpdate(group)).toBe('IGNORED');
    const text = privateCommand('salom');
    text.message.entities = [];
    expect(await service.handleUpdate(text)).toBe('IGNORED');
    expect(await service.handleUpdate({ update_id: 'x' })).toBe('IGNORED');
    expect(sender?.sent).toEqual([]);
    expect(identity.findTelegramPerson).not.toHaveBeenCalled();
  });

  it('does nothing without a staff bot', async () => {
    const { service } = setup({ sender: null });
    expect(service.configured).toBe(false);
    expect(await service.handleUpdate(privateCommand('/start'))).toBe('DISABLED');
  });

  it('logs only the failure kind when the reply cannot be sent', async () => {
    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    const sender = new FakeTelegramSender();
    sender.failFor('111', { failure: 'RECIPIENT_UNREACHABLE' });
    const { service } = setup({ sender });
    expect(await service.handleUpdate(privateCommand('/start'))).toBe('SEND_FAILED');
    expect(warnings).toEqual(['Staff bot reply failed: RECIPIENT_UNREACHABLE']);
  });

  it('stops answering a chat that floods it, presses included', async () => {
    const { service } = setup();
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      outcomes.push(await service.handleUpdate(privateCommand('/start')));
      outcomes.push(await service.handleUpdate(press('lang:uz')));
    }
    expect(outcomes.filter((o) => o === 'RATE_LIMITED').length).toBeGreaterThan(0);
  });
});

describe('StaffBotWebhookController', () => {
  // `secret: null` = not configured (a default parameter would swallow `undefined`).
  const controller = (service: StaffBotService, secret: string | null = SECRET) =>
    new StaffBotWebhookController(
      { TELEGRAM_MODE: 'webhook', STAFF_BOT_WEBHOOK_SECRET: secret ?? undefined },
      service,
    );

  it('handles an update that carries the secret in the URL and the header', async () => {
    const { service, sender } = setup();
    expect(await controller(service).receive(SECRET, SECRET, privateCommand('/start'))).toEqual({
      ok: true,
    });
    expect(sender?.sent).toHaveLength(1);
  });

  it('is 404 without the secret, without the staff bot, or with a wrong URL; 401 with a wrong header', async () => {
    const { service, sender } = setup();
    await expect(controller(service, null).receive(SECRET, SECRET, {})).rejects.toThrow(
      'Not found',
    );
    await expect(
      controller(setup({ sender: null }).service).receive(SECRET, SECRET, {}),
    ).rejects.toThrow('Not found');
    await expect(controller(service).receive('wrong-secret', SECRET, {})).rejects.toThrow(
      'Not found',
    );
    await expect(controller(service).receive(SECRET, 'wrong', {})).rejects.toThrow('Unauthorized');
    expect(sender?.sent).toEqual([]);
  });

  it('turns a fault into a generic error that quotes nothing of the update', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service } = setup();
    vi.spyOn(service, 'handleUpdate').mockRejectedValue(new TypeError('secret text'));
    const error = await controller(service)
      .receive(SECRET, SECRET, {})
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe('Staff bot update handling failed');
  });
});
