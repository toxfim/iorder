export interface SendDocumentOptions {
  caption?: string;
  /** One URL button under the file. A `url` button works in groups; `web_app` buttons do not. */
  button?: { text: string; url: string };
}

/** A file held in memory; it is generated at send time and never stored. */
export interface DocumentFile {
  fileName: string;
  data: Uint8Array;
}

/** Telegram's button colours: `primary` is blue. Without one the app's own style is used. */
export type MessageButtonStyle = 'primary' | 'success' | 'danger';

/**
 * A button under a message: `url` opens a link; `webAppUrl` opens that https page as a Mini App
 * (Telegram allows `web_app` buttons in private chats only); `callbackData` sends that text back
 * to the bot as a `callback_query` (at most 64 bytes; untrusted when it comes back).
 */
export type MessageButton = (
  | { text: string; url: string }
  | { text: string; webAppUrl: string }
  | { text: string; callbackData: string }
) & { style?: MessageButtonStyle };

/**
 * A piece of the message text that mentions a person by their Telegram id: Telegram's way to
 * mention someone who has no username (it notifies them like `@username` does). `offset` and
 * `length` count UTF-16 code units, which is what a JS string index is. The text itself stays
 * plain text: nothing in it is markup, so a name needs no escaping.
 */
export interface TextMention {
  offset: number;
  length: number;
  /** Decimal string, like every Telegram id here. */
  userId: string;
}

export interface SendMessageOptions {
  /** Links in order messages are enough; the preview card only adds noise in a busy group. */
  disableLinkPreview?: boolean;
  /** One row of buttons under the message. */
  buttons?: readonly MessageButton[];
  mentions?: readonly TextMention[];
}

/**
 * Why a send failed, in the terms the retry policy needs (never Telegram's wording):
 *  - RECIPIENT_UNREACHABLE: 403 (the person blocked the bot or never started it, the bot was
 *    removed from the group) or the chat does not exist. Retrying cannot help.
 *  - RATE_LIMITED: 429; `retryAfterSeconds` says when to come back. Not the message's fault.
 *  - REJECTED: Telegram refused the request itself (400, for example text too long). A retry
 *    sends the same request, so it cannot help either.
 *  - TRANSIENT: network failure, timeout, 5xx or a configuration problem. Worth retrying.
 */
export type TelegramSendFailure =
  'RECIPIENT_UNREACHABLE' | 'RATE_LIMITED' | 'REJECTED' | 'TRANSIENT' | RemoveMemberFailure;

/**
 * Extra failures of `removeMember` only (never thrown by a send). All are final: a retry sends
 * the same request.
 *  - BOT_NOT_ADMIN: the bot is not an administrator of the group or lacks the right to ban.
 *  - NOT_A_MEMBER: Telegram does not know the person in that group.
 *  - CHAT_NOT_FOUND: the group is gone for the bot (deleted, or the bot was removed from it).
 *  - CANNOT_REMOVE: Telegram refuses this person (the group's creator or another administrator).
 *  - CHAT_MIGRATED: the group was upgraded to a supergroup and has a new chat id (kept in
 *    `migratedToChatId` for logs; the stored chat id must be corrected by a person).
 *  - UNBAN_FAILED: the ban succeeded but the unban did not (after its own short retries): the
 *    person may stay on the group's ban list. Staff must be told.
 */
export type RemoveMemberFailure =
  | 'BOT_NOT_ADMIN'
  | 'NOT_A_MEMBER'
  | 'CHAT_NOT_FOUND'
  | 'CANNOT_REMOVE'
  | 'UNBAN_FAILED'
  | 'CHAT_MIGRATED';

/** The only error a sender throws. It never carries a message text or a Telegram error body. */
export class TelegramSendError extends Error {
  constructor(
    readonly failure: TelegramSendFailure,
    readonly retryAfterSeconds?: number,
    /** Only for CHAT_MIGRATED: the new chat id. For logs; never copied to the outbox row. */
    readonly migratedToChatId?: string,
  ) {
    super(`Telegram send failed: ${failure}`);
    this.name = 'TelegramSendError';
  }
}

/**
 * The one way out to Telegram, for command replies and notifications alike. A real
 * implementation wraps grammY; tests use `FakeTelegramSender`. `chatId` is a decimal string
 * (Telegram ids are 64-bit and never travel as JS numbers).
 */
export abstract class TelegramSender {
  /** False when no bot token is configured: nothing can be sent and the outbox is left alone. */
  abstract readonly enabled: boolean;

  /** Resolves when Telegram accepted the message; throws `TelegramSendError` otherwise. */
  abstract sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<void>;

  /** Same contract as `sendMessage`, for a file with an optional caption and URL button. */
  abstract sendDocument(
    chatId: string,
    file: DocumentFile,
    options?: SendDocumentOptions,
  ): Promise<void>;

  /**
   * Removes a person from a group so that they can be invited again later [P]: ban, then unban
   * (`only_if_banned`). Resolves when Telegram accepted both calls; throws `TelegramSendError`
   * otherwise (see `RemoveMemberFailure`; 429 and 5xx keep their usual kinds). Both ids are
   * decimal strings.
   */
  abstract removeMember(chatId: string, userId: string): Promise<void>;

  /**
   * Answers a button press, so that the person's app stops its spinner (Telegram expects it within
   * seconds). Same error contract as `sendMessage`.
   */
  abstract answerCallbackQuery(callbackQueryId: string): Promise<void>;

  /** Removes the buttons under a message the bot sent, so that a choice cannot be pressed twice. */
  abstract clearButtons(chatId: string, messageId: number): Promise<void>;
}

/** Used when no bot token is set: every send fails as TRANSIENT, the dispatcher does not run. */
export class DisabledTelegramSender extends TelegramSender {
  readonly enabled = false;

  sendDocument(): Promise<void> {
    return Promise.reject(new TelegramSendError('TRANSIENT'));
  }

  sendMessage(): Promise<void> {
    return Promise.reject(new TelegramSendError('TRANSIENT'));
  }

  removeMember(): Promise<void> {
    return Promise.reject(new TelegramSendError('TRANSIENT'));
  }

  answerCallbackQuery(): Promise<void> {
    return Promise.reject(new TelegramSendError('TRANSIENT'));
  }

  clearButtons(): Promise<void> {
    return Promise.reject(new TelegramSendError('TRANSIENT'));
  }
}
