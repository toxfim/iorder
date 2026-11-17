import {
  TelegramSender,
  TelegramSendError,
  type DocumentFile,
  type SendDocumentOptions,
  type SendMessageOptions,
  type TelegramSendFailure,
} from './telegram-sender.js';

export interface SentMessage {
  chatId: string;
  text: string;
  options: SendMessageOptions | undefined;
}

export interface SentDocument {
  chatId: string;
  file: DocumentFile;
  options: SendDocumentOptions | undefined;
}

/** What the fake does for one chat: succeed (default) or fail in a given way. */
export interface FakeFailure {
  failure: TelegramSendFailure;
  retryAfterSeconds?: number;
  /** How many sends fail before the chat works again; omit for "always". */
  times?: number;
}

/**
 * Test double for `TelegramSender`: records every message and can be told to fail per chat.
 * Lives next to the real sender (like the fake USD rate provider) so unit and integration
 * tests share it. It never touches the network.
 */
export class FakeTelegramSender extends TelegramSender {
  readonly enabled: boolean;
  readonly sent: SentMessage[] = [];
  readonly documents: SentDocument[] = [];
  /** Every attempt, successful or not, in order. */
  readonly attempts: string[] = [];
  /** Every successful removal, in order. */
  readonly removed: { chatId: string; userId: string }[] = [];
  /** Every removal attempt, successful or not. */
  readonly removalAttempts: { chatId: string; userId: string }[] = [];
  private readonly removalFailures = new Map<string, FakeFailure & { used: number }>();
  private readonly failures = new Map<string, FakeFailure & { used: number }>();
  /** Awaited before each send: lets a test hold a send open (crash windows, concurrency). */
  beforeSend: ((chatId: string) => Promise<void>) | undefined;

  constructor(enabled = true) {
    super();
    this.enabled = enabled;
  }

  failFor(chatId: string, failure: FakeFailure): void {
    this.failures.set(chatId, { ...failure, used: 0 });
  }

  /** Makes `removeMember` fail for one chat (any chat-level failure kind). */
  failRemovalFor(chatId: string, failure: FakeFailure): void {
    this.removalFailures.set(chatId, { ...failure, used: 0 });
  }

  clearFailures(): void {
    this.failures.clear();
    this.removalFailures.clear();
  }

  messagesTo(chatId: string): SentMessage[] {
    return this.sent.filter((message) => message.chatId === chatId);
  }

  async sendDocument(
    chatId: string,
    file: DocumentFile,
    options?: SendDocumentOptions,
  ): Promise<void> {
    await this.beforeSend?.(chatId);
    this.attempts.push(chatId);
    const failure = this.failures.get(chatId);
    if (failure && (failure.times === undefined || failure.used < failure.times)) {
      failure.used += 1;
      throw new TelegramSendError(failure.failure, failure.retryAfterSeconds);
    }
    this.documents.push({ chatId, file, options });
  }

  async removeMember(chatId: string, userId: string): Promise<void> {
    await this.beforeSend?.(chatId);
    this.removalAttempts.push({ chatId, userId });
    const failure = this.removalFailures.get(chatId);
    if (failure && (failure.times === undefined || failure.used < failure.times)) {
      failure.used += 1;
      throw new TelegramSendError(failure.failure, failure.retryAfterSeconds);
    }
    this.removed.push({ chatId, userId });
  }

  /** Every answered button press, in order. */
  readonly answeredCallbacks: string[] = [];
  /** Every message whose buttons were removed. */
  readonly clearedButtons: { chatId: string; messageId: number }[] = [];

  answerCallbackQuery(callbackQueryId: string): Promise<void> {
    this.answeredCallbacks.push(callbackQueryId);
    return Promise.resolve();
  }

  clearButtons(chatId: string, messageId: number): Promise<void> {
    this.clearedButtons.push({ chatId, messageId });
    return Promise.resolve();
  }

  async sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<void> {
    await this.beforeSend?.(chatId);
    this.attempts.push(chatId);
    const failure = this.failures.get(chatId);
    if (failure && (failure.times === undefined || failure.used < failure.times)) {
      failure.used += 1;
      throw new TelegramSendError(failure.failure, failure.retryAfterSeconds);
    }
    this.sent.push({ chatId, text, options });
  }
}
