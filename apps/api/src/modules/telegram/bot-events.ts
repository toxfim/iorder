import { DEFAULT_LOCALE, type Locale } from '@iorder/shared';
import { z } from 'zod';
import { parseLanguageChoice } from './language-choice.js';

// Telegram updates are UNTRUSTED input. Every field the bot reads is checked here, once, and the
// rest of the module works with the normalized `BotEvent` list this file produces. Unknown
// fields are dropped (plain z.object); an update that does not match is ignored, never guessed.

/** Telegram ids are 52-bit integers: safe as JS numbers while they travel, bigint in the database. */
const idSchema = z.number().int().safe();
const nameSchema = z.string().max(512);

const userSchema = z.object({
  id: idSchema.positive(),
  is_bot: z.boolean().default(false),
  first_name: nameSchema.default(''),
  last_name: nameSchema.optional(),
  username: z.string().max(64).optional(),
  language_code: z.string().max(16).optional(),
});

const chatSchema = z.object({
  id: idSchema,
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
  title: nameSchema.optional(),
});

const memberStatusSchema = z.enum([
  'creator',
  'administrator',
  'member',
  'restricted',
  'left',
  'kicked',
]);

const chatMemberSchema = z.object({
  status: memberStatusSchema,
  user: userSchema,
  // Only present for `restricted`: a restricted person may still be in the group.
  is_member: z.boolean().optional(),
});

const chatMemberUpdatedSchema = z.object({
  chat: chatSchema,
  date: idSchema.nonnegative(),
  // Who made the change (for the bot itself: who added it to the group). Optional: not trusted.
  from: userSchema.optional(),
  new_chat_member: chatMemberSchema,
});

const messageSchema = z.object({
  date: idSchema.nonnegative(),
  chat: chatSchema,
  from: userSchema.optional(),
  sender_chat: z.object({ id: idSchema }).optional(),
  text: z.string().max(4096).optional(),
  new_chat_members: z.array(userSchema).max(200).optional(),
  left_chat_member: userSchema.optional(),
  new_chat_title: nameSchema.optional(),
  migrate_to_chat_id: idSchema.optional(),
});

// A press of an inline button. `data` is bounded far above Telegram's 64 bytes so that a malformed
// press is still answered (it is then ignored by the strict parse in language-choice.ts).
const callbackQuerySchema = z.object({
  id: z.string().min(1).max(128),
  from: userSchema,
  message: z.object({ message_id: idSchema.positive(), chat: chatSchema }).optional(),
  data: z.string().max(256).optional(),
});

const updateSchema = z.object({
  update_id: idSchema.nonnegative(),
  message: messageSchema.optional(),
  my_chat_member: chatMemberUpdatedSchema.optional(),
  chat_member: chatMemberUpdatedSchema.optional(),
  callback_query: callbackQuerySchema.optional(),
});

/**
 * Telegram's own service accounts. They appear as the "sender" of channel posts and anonymous
 * admin messages and say nothing about who is in the group.
 */
const SERVICE_USER_IDS: ReadonlySet<number> = new Set([777_000, 1_087_968_824, 136_817_688]);

export interface BotPerson {
  telegramUserId: bigint;
  fullName: string;
  language: Locale;
}

export interface BotAddedBy {
  telegramUserId: bigint;
  name: string;
}

export type BotEvent =
  | {
      kind: 'BOT_ADDED';
      chatId: bigint;
      title: string;
      addedBy: BotAddedBy | null;
      eventAt: Date;
    }
  | { kind: 'BOT_REMOVED'; chatId: bigint; eventAt: Date }
  | { kind: 'TITLE_CHANGED'; chatId: bigint; title: string; eventAt: Date }
  | { kind: 'CHAT_MIGRATED'; fromChatId: bigint; toChatId: bigint; eventAt: Date }
  | {
      kind: 'MEMBER_PRESENT';
      chatId: bigint;
      person: BotPerson;
      source: 'JOIN' | 'MESSAGE';
      eventAt: Date;
    }
  | { kind: 'MEMBER_LEFT'; chatId: bigint; telegramUserId: bigint; eventAt: Date }
  | {
      kind: 'COMMAND';
      command: BotCommandName;
      chatId: bigint;
      chatType: 'private' | 'group';
      person: BotPerson;
      /**
       * `/start <payload>` of a deep link, as Telegram allows it: in a private chat (`?start=`), or
       * in a group right after the bot was added through `?startgroup=` (`/start@bot <payload>`).
       */
      startPayload?: string;
      /** The group's title (group commands only); untrusted text. */
      chatTitle?: string;
      /** When Telegram says the message was sent. */
      eventAt: Date;
    }
  | {
      /** A language button of a private /start was pressed [C, owner 2026-11-13]. */
      kind: 'LANGUAGE_CHOSEN';
      callbackQueryId: string;
      chatId: bigint;
      /** The question message, so that its buttons can be removed. */
      messageId: number;
      person: BotPerson;
      language: Locale;
      startPayload?: string;
    }
  | {
      /** Any other button press: only answered, so that the person's spinner stops. */
      kind: 'CALLBACK_IGNORED';
      callbackQueryId: string;
    };

export const BOT_COMMANDS = ['start', 'lang', 'price', 'help'] as const;
export type BotCommandName = (typeof BOT_COMMANDS)[number];

export type ParsedUpdate = { ok: true; events: BotEvent[] } | { ok: false };

/** Maps Telegram's `language_code` (`ru`, `uz`, `en-GB`, ...) to a supported language. */
export function localeFromTelegram(languageCode: string | undefined): Locale {
  const base = languageCode?.toLowerCase().split('-')[0];
  if (base === 'ru') return 'RU';
  if (base === 'en') return 'EN';
  return DEFAULT_LOCALE;
}

type TelegramUser = z.infer<typeof userSchema>;
type TelegramMessage = z.infer<typeof messageSchema>;
type TelegramMemberUpdate = z.infer<typeof chatMemberUpdatedSchema>;

function toPerson(user: TelegramUser): BotPerson {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return {
    telegramUserId: BigInt(user.id),
    fullName: fullName === '' ? (user.username ?? '') : fullName,
    language: localeFromTelegram(user.language_code),
  };
}

const at = (seconds: number): Date => new Date(seconds * 1000);

const isGroup = (type: string): type is 'group' | 'supergroup' =>
  type === 'group' || type === 'supergroup';

/** Is the person in the group after this change? `restricted` people count only with is_member. */
function isInGroupAfter(member: z.infer<typeof chatMemberSchema>): boolean {
  switch (member.status) {
    case 'creator':
    case 'administrator':
    case 'member':
      return true;
    case 'restricted':
      return member.is_member === true;
    case 'left':
    case 'kicked':
      return false;
  }
}

function fromBotMembership(update: TelegramMemberUpdate): BotEvent[] {
  // `my_chat_member` is always about the bot itself. Private chats (a person blocking the bot)
  // and channels are not organizations.
  if (!isGroup(update.chat.type)) return [];
  const chatId = BigInt(update.chat.id);
  const eventAt = at(update.date);
  if (isInGroupAfter(update.new_chat_member)) {
    const person = update.from && !update.from.is_bot ? toPerson(update.from) : null;
    const addedBy = person
      ? { telegramUserId: person.telegramUserId, name: person.fullName }
      : null;
    return [{ kind: 'BOT_ADDED', chatId, title: update.chat.title ?? '', addedBy, eventAt }];
  }
  return [{ kind: 'BOT_REMOVED', chatId, eventAt }];
}

function fromMemberChange(update: TelegramMemberUpdate): BotEvent[] {
  const user = update.new_chat_member.user;
  if (!isGroup(update.chat.type) || user.is_bot) return [];
  const chatId = BigInt(update.chat.id);
  const eventAt = at(update.date);
  return isInGroupAfter(update.new_chat_member)
    ? [{ kind: 'MEMBER_PRESENT', chatId, person: toPerson(user), source: 'JOIN', eventAt }]
    : [{ kind: 'MEMBER_LEFT', chatId, telegramUserId: BigInt(user.id), eventAt }];
}

/** `/price`, `/price@my_bot`, `/price arg`. A command addressed to another bot is not ours. */
export function parseCommand(
  text: string | undefined,
  botUsername: string | undefined,
): BotCommandName | null {
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s|$)/.exec(text ?? '');
  if (!match) return null;
  const [, name, target] = match;
  if (target !== undefined && target.toLowerCase() !== botUsername?.toLowerCase()) return null;
  const command = name?.toLowerCase();
  return BOT_COMMANDS.find((known) => known === command) ?? null;
}

/**
 * The payload of a deep-link start (`/start <payload>`): Telegram allows 1-64 characters of
 * A-Z a-z 0-9 _ -. Anything else is no payload.
 */
export function parseStartPayload(text: string | undefined): string | undefined {
  return /^\/start(?:@[A-Za-z0-9_]{1,64})? ([A-Za-z0-9_-]{1,64})$/.exec(text ?? '')?.[1];
}

/**
 * True only for a message that starts with `/command@name`. Only then does the handler need the
 * bot's own username (a Telegram call); every other update is parsed without it.
 */
export function needsBotUsername(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || !('message' in raw)) return false;
  const message = raw.message;
  if (typeof message !== 'object' || message === null || !('text' in message)) return false;
  return typeof message.text === 'string' && /^\/[A-Za-z0-9_]{1,32}@/.test(message.text);
}

function fromMessage(message: TelegramMessage, botUsername: string | undefined): BotEvent[] {
  const events: BotEvent[] = [];
  const eventAt = at(message.date);

  if (message.migrate_to_chat_id !== undefined) {
    return [
      {
        kind: 'CHAT_MIGRATED',
        fromChatId: BigInt(message.chat.id),
        toChatId: BigInt(message.migrate_to_chat_id),
        eventAt,
      },
    ];
  }

  const chatId = BigInt(message.chat.id);
  const group = isGroup(message.chat.type);
  if (group) {
    for (const user of message.new_chat_members ?? []) {
      if (user.is_bot) continue;
      events.push({
        kind: 'MEMBER_PRESENT',
        chatId,
        person: toPerson(user),
        source: 'JOIN',
        eventAt,
      });
    }
    const left = message.left_chat_member;
    if (left && !left.is_bot) {
      events.push({ kind: 'MEMBER_LEFT', chatId, telegramUserId: BigInt(left.id), eventAt });
    }
    if (message.new_chat_title !== undefined) {
      events.push({ kind: 'TITLE_CHANGED', chatId, title: message.new_chat_title, eventAt });
    }
  }

  const service =
    message.new_chat_members !== undefined ||
    message.left_chat_member !== undefined ||
    message.new_chat_title !== undefined;
  const sender = message.from;
  if (service || !sender || sender.is_bot || SERVICE_USER_IDS.has(sender.id)) return events;
  // A message sent on behalf of a channel or as an anonymous admin proves nothing about a person.
  if (message.sender_chat !== undefined && message.sender_chat.id !== sender.id) return events;

  if (group) {
    events.push({
      kind: 'MEMBER_PRESENT',
      chatId,
      person: toPerson(sender),
      source: 'MESSAGE',
      eventAt,
    });
  }
  const command = parseCommand(message.text, botUsername);
  if (command && (group || message.chat.type === 'private')) {
    const startPayload = command === 'start' ? parseStartPayload(message.text) : undefined;
    events.push({
      kind: 'COMMAND',
      command,
      chatId,
      chatType: group ? 'group' : 'private',
      person: toPerson(sender),
      eventAt,
      ...(startPayload === undefined ? {} : { startPayload }),
      ...(group ? { chatTitle: message.chat.title ?? '' } : {}),
    });
  }
  return events;
}

/** A language button pressed by a person in their private chat with the bot, or nothing ours. */
function fromCallback(query: z.infer<typeof callbackQuerySchema>): BotEvent {
  const ignored: BotEvent = { kind: 'CALLBACK_IGNORED', callbackQueryId: query.id };
  const message = query.message;
  // Only in the private chat with this very person: a button in a group is never a choice.
  if (query.from.is_bot || message === undefined || message.chat.type !== 'private') return ignored;
  if (message.chat.id !== query.from.id) return ignored;
  const choice = parseLanguageChoice(query.data);
  if (choice === null) return ignored;
  return {
    kind: 'LANGUAGE_CHOSEN',
    callbackQueryId: query.id,
    chatId: BigInt(message.chat.id),
    messageId: message.message_id,
    person: toPerson(query.from),
    language: choice.language,
    ...(choice.startPayload === undefined ? {} : { startPayload: choice.startPayload }),
  };
}

/** Validates one raw update and turns it into events. Never throws on bad input. */
export function parseUpdate(raw: unknown, botUsername?: string): ParsedUpdate {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false };
  const update = parsed.data;
  if (update.my_chat_member) return { ok: true, events: fromBotMembership(update.my_chat_member) };
  if (update.chat_member) return { ok: true, events: fromMemberChange(update.chat_member) };
  if (update.message) return { ok: true, events: fromMessage(update.message, botUsername) };
  if (update.callback_query) return { ok: true, events: [fromCallback(update.callback_query)] };
  return { ok: true, events: [] };
}
