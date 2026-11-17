import { Bot, GrammyError, HttpError, InputFile } from 'grammy';
import type { MessageEntity, UserFromGetMe } from 'grammy/types';
import {
  TelegramSender,
  TelegramSendError,
  type DocumentFile,
  type MessageButton,
  type MessageButtonStyle,
  type SendDocumentOptions,
  type SendMessageOptions,
  type TelegramSendFailure,
  type TextMention,
} from './telegram-sender.js';

export const SEND_TIMEOUT_MS = 30_000;

/** grammY types its signal with the `abort-controller` package; Node's own signal is compatible at runtime. */
type GrammySignal = NonNullable<Parameters<Bot['api']['sendMessage']>[3]>;

/** What Telegram's HTTP API answers, reduced to what the bot reads. */
export type TelegramApiResponse =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error_code: number;
      description: string;
      parameters?: { retry_after?: number; migrate_to_chat_id?: number };
    };

/**
 * Replaces the network: every Bot API call goes here instead of api.telegram.org. Tests inject a
 * recording fake, so no test (and no accidental run without a real token) can reach Telegram.
 */
export type TelegramApiTransport = (
  method: string,
  payload: Record<string, unknown>,
) => Promise<TelegramApiResponse>;

export interface BotFactoryOptions {
  token: string;
  /** Skips the `getMe` call grammY makes on start. Tests pass a fake identity. */
  botInfo?: UserFromGetMe;
  transport?: TelegramApiTransport | null;
}

/**
 * The only place a grammY `Bot` is built. Constructing a Bot does not contact Telegram; calls
 * start only when something sends, `init()` or `start()` runs.
 */
export function createTelegramBot(options: BotFactoryOptions): Bot {
  const bot = new Bot(options.token, options.botInfo ? { botInfo: options.botInfo } : {});
  if (options.transport) {
    const transport = options.transport;
    // An API transformer that never calls `prev`: the request ends here.
    bot.api.config.use(async (_prev, method, payload) => {
      const response = await transport(method, payload as Record<string, unknown>);
      return response as never;
    });
  }
  return bot;
}

/** Maps a grammY failure to the retry-relevant kind. Reads only codes, never the body or text. */
export function classifySendError(error: unknown): TelegramSendError {
  if (error instanceof TelegramSendError) return error;
  if (error instanceof GrammyError) {
    const retryAfter = error.parameters.retry_after;
    const failure = failureOfCode(error.error_code, error.description);
    return new TelegramSendError(failure, failure === 'RATE_LIMITED' ? retryAfter : undefined);
  }
  // HttpError (network, timeout) and anything unexpected: worth another try.
  if (error instanceof HttpError) return new TelegramSendError('TRANSIENT');
  return new TelegramSendError('TRANSIENT');
}

function failureOfCode(code: number, description: string): TelegramSendFailure {
  if (code === 403) return 'RECIPIENT_UNREACHABLE';
  if (code === 429) return 'RATE_LIMITED';
  // A person who never started the bot is answered "400 chat not found", not 403.
  if (code === 400 && /chat not found/i.test(description)) return 'RECIPIENT_UNREACHABLE';
  // Other 400s ("message is too long", "group chat was upgraded to a supergroup"): a retry
  // sends the same request, so they are final for this row.
  if (code === 400) return 'REJECTED';
  return 'TRANSIENT';
}

/**
 * Maps a failure of ban/unban to the kinds the removal job understands. Reads only the numeric
 * code and Telegram's short description, never forwards them. The order matters: "the bot is not
 * a member of the chat" must win over the generic "no rights" patterns. Everything is matched on
 * the lower-cased description AND the numeric code; the wording is a guess to verify on a real group.
 */
export function classifyRemoveError(error: unknown): TelegramSendError {
  if (error instanceof TelegramSendError) return error;
  if (!(error instanceof GrammyError)) return new TelegramSendError('TRANSIENT');
  const code = error.error_code;
  const text = error.description.toLowerCase();
  if (code === 429) return new TelegramSendError('RATE_LIMITED', error.parameters.retry_after);
  if (code >= 500 || (code !== 400 && code !== 403)) return new TelegramSendError('TRANSIENT');
  // The group became a supergroup: this chat id is dead for good. The new id is for the log only.
  const migrated = error.parameters.migrate_to_chat_id;
  if (code === 400 && (migrated !== undefined || /upgraded to a supergroup/.test(text))) {
    return new TelegramSendError(
      'CHAT_MIGRATED',
      undefined,
      migrated === undefined ? undefined : String(migrated),
    );
  }
  if (
    /chat not found|bot was kicked|bot is not a member|chat_id_invalid|chat was deleted/.test(text)
  ) {
    return new TelegramSendError('CHAT_NOT_FOUND');
  }
  if (
    /chat owner|owner of the chat|user_admin_invalid|user is an administrator|can't remove|cannot remove|can't ban|cannot ban/.test(
      text,
    )
  ) {
    return new TelegramSendError('CANNOT_REMOVE');
  }
  if (
    /user_not_participant|participant_id_invalid|user not found|member not found|user_id_invalid/.test(
      text,
    )
  ) {
    return new TelegramSendError('NOT_A_MEMBER');
  }
  if (
    code === 403 ||
    /not enough rights|chat_admin_required|administrator rights|no rights/.test(text)
  ) {
    return new TelegramSendError('BOT_NOT_ADMIN');
  }
  return new TelegramSendError('REJECTED');
}

/** Tries of the unban after a successful ban, the first included. */
export const UNBAN_MAX_ATTEMPTS = 3;
/** A 429 on the unban is waited out only when Telegram asks for at most this long. */
const UNBAN_MAX_RETRY_AFTER_SECONDS = 10;
const UNBAN_BACKOFF_MS = [1000, 3000] as const;

/** Milliseconds to wait before the next unban try, or null when the unban is given up. */
function unbanRetryWaitMs(failure: TelegramSendError, attempt: number): number | null {
  if (attempt >= UNBAN_MAX_ATTEMPTS) return null;
  if (failure.failure === 'TRANSIENT') return UNBAN_BACKOFF_MS[attempt - 1] ?? 3000;
  if (failure.failure === 'RATE_LIMITED') {
    const seconds = failure.retryAfterSeconds ?? 1;
    return seconds <= UNBAN_MAX_RETRY_AFTER_SECONDS ? Math.max(seconds, 1) * 1000 : null;
  }
  return null;
}

const removeSignal = (): GrammySignal =>
  AbortSignal.timeout(SEND_TIMEOUT_MS) as unknown as GrammySignal;

/** A bot token is "<bot id>:<secret>"; the id is the part before the colon. Null if malformed. */
export function botIdOfToken(token: string): number | null {
  const id = Number(token.split(':')[0]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

type InlineButton = (
  | { text: string; url: string }
  | { text: string; web_app: { url: string } }
  | { text: string; callback_data: string }
) & {
  style?: MessageButtonStyle;
};

function toInlineButton(button: MessageButton): InlineButton {
  const style = button.style === undefined ? {} : { style: button.style };
  if ('url' in button) return { text: button.text, url: button.url, ...style };
  if ('webAppUrl' in button)
    return { text: button.text, web_app: { url: button.webAppUrl }, ...style };
  return { text: button.text, callback_data: button.callbackData, ...style };
}

type TextMentionEntity = Extract<MessageEntity, { type: 'text_mention' }>;

/**
 * A `text_mention` entity. Telegram reads only the user's id; the other fields are required by
 * the type and carry the mentioned text. Null for a span outside the text or an id that would
 * lose precision as a number: the message then goes out with the name as plain text.
 */
function toMentionEntity(mention: TextMention, text: string): TextMentionEntity | null {
  const id = Number(mention.userId);
  const end = mention.offset + mention.length;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (mention.offset < 0 || mention.length <= 0 || end > text.length) return null;
  return {
    type: 'text_mention',
    offset: mention.offset,
    length: mention.length,
    user: { id, is_bot: false, first_name: text.slice(mention.offset, end) },
  };
}

/**
 * The real sender: grammY's `sendMessage`. Plain text only (no parse mode, nothing to escape);
 * a mention is a message entity beside the text, never markup inside it.
 */
export class GrammyTelegramSender extends TelegramSender {
  readonly enabled = true;

  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly bot: Bot,
    options: { sleep?: (ms: number) => Promise<void> } = {},
  ) {
    super();
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async sendDocument(
    chatId: string,
    file: DocumentFile,
    options?: SendDocumentOptions,
  ): Promise<void> {
    try {
      await this.bot.api.sendDocument(
        chatId,
        new InputFile(file.data, file.fileName),
        {
          ...(options?.caption === undefined ? {} : { caption: options.caption }),
          ...(options?.button
            ? {
                reply_markup: {
                  inline_keyboard: [[{ text: options.button.text, url: options.button.url }]],
                },
              }
            : {}),
        },
        AbortSignal.timeout(SEND_TIMEOUT_MS) as unknown as GrammySignal,
      );
    } catch (error) {
      throw classifySendError(error);
    }
  }

  /**
   * Ban, then unban with `only_if_banned`: the person leaves the group but is not left on the ban
   * list, so a group admin can invite them again after an unblock [P]. Once the ban succeeded only
   * the unban is repeated (a few short tries; both calls are idempotent). If it still fails the
   * person may stay banned for good: that is the distinct, final failure UNBAN_FAILED, which the
   * dispatcher surfaces to the manager. A failing ban is an ordinary classified failure.
   */
  async removeMember(chatId: string, userId: string): Promise<void> {
    const id = Number(userId);
    // Telegram ids stay far below 2^53 today; refuse anything that would lose precision.
    if (!Number.isSafeInteger(id)) throw new TelegramSendError('REJECTED');
    // Never the bot itself. Decided from the configured token (its prefix is the bot's id), not
    // from getMe, so the guard also holds before the bot's identity was loaded.
    const botId = botIdOfToken(this.bot.token);
    if (botId === null || botId === id) throw new TelegramSendError('CANNOT_REMOVE');
    try {
      await this.bot.api.banChatMember(chatId, id, {}, removeSignal());
    } catch (error) {
      throw classifyRemoveError(error);
    }
    await this.unbanAfterBan(chatId, id);
  }

  private async unbanAfterBan(chatId: string, id: number): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.bot.api.unbanChatMember(chatId, id, { only_if_banned: true }, removeSignal());
        return;
      } catch (error) {
        const failure = classifyRemoveError(error);
        const waitMs = unbanRetryWaitMs(failure, attempt);
        if (waitMs === null) throw new TelegramSendError('UNBAN_FAILED');
        await this.sleep(waitMs);
      }
    }
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    try {
      await this.bot.api.answerCallbackQuery(
        callbackQueryId,
        {},
        AbortSignal.timeout(SEND_TIMEOUT_MS) as unknown as GrammySignal,
      );
    } catch (error) {
      throw classifySendError(error);
    }
  }

  async clearButtons(chatId: string, messageId: number): Promise<void> {
    try {
      await this.bot.api.editMessageReplyMarkup(
        chatId,
        messageId,
        { reply_markup: { inline_keyboard: [] } },
        AbortSignal.timeout(SEND_TIMEOUT_MS) as unknown as GrammySignal,
      );
    } catch (error) {
      throw classifySendError(error);
    }
  }

  async sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<void> {
    const entities = (options?.mentions ?? []).flatMap(
      (mention) => toMentionEntity(mention, text) ?? [],
    );
    try {
      await this.bot.api.sendMessage(
        chatId,
        text,
        {
          ...(options?.disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
          ...(options?.buttons?.length
            ? { reply_markup: { inline_keyboard: [options.buttons.map(toInlineButton)] } }
            : {}),
          ...(entities.length > 0 ? { entities } : {}),
        },
        // grammY's own limit is 500 s (sized for long polling). A send that hangs must not outlive
        // the outbox claim lease (see CLAIM_LEASE_SECONDS), or another worker would repeat it.
        AbortSignal.timeout(SEND_TIMEOUT_MS) as unknown as GrammySignal,
      );
    } catch (error) {
      throw classifySendError(error);
    }
  }
}
