import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Locale } from '@iorder/shared';
import { getBusinessTimeParts } from '../../../common/clock/business-time.js';
import { Clock } from '../../../common/clock/clock.js';
import { IdentityService, type TelegramPerson } from '../../identity/index.js';
import { parseUpdate, type BotEvent } from '../bot-events.js';
import { CommandRateLimiter } from '../command-rate-limiter.js';
import { LANGUAGE_QUESTION, languageButtons } from '../language-choice.js';
import {
  TelegramSendError,
  type SendMessageOptions,
  type TelegramSender,
} from '../telegram-sender.js';
import { STAFF_BOT_SENDER } from '../telegram.tokens.js';
import { WebLinks } from '../web-links.js';
import { greetingName, staffBotStartReply } from './staff-bot-replies.js';

export type StaffBotOutcome = 'REPLIED' | 'IGNORED' | 'RATE_LIMITED' | 'SEND_FAILED' | 'DISABLED';

/** An active person with at least one staff role: the only one the staff bot greets. */
function isActiveStaff(person: TelegramPerson | null): person is TelegramPerson {
  return person !== null && person.status === 'ACTIVE' && person.staffRoles.length > 0;
}

type CommandEvent = Extract<BotEvent, { kind: 'COMMAND' }>;
type ChoiceEvent = Extract<BotEvent, { kind: 'LANGUAGE_CHOSEN' }>;

/**
 * The staff bot (the staff Mini App bot, see telegram.module). It reads its private chat only:
 * `/start` (and `/lang`, owner 2026-11-14) asks the language first [C, owner 2026-11-13]; the chosen language is saved for a person
 * who has a row (the identity module audits it), and the answer is the greeting, what each command
 * does and the two buttons to the staff app. `/help` gives that answer at once in the stored
 * language. Groups, members and orders stay on the main bot; the language is the one thing this
 * bot writes. A failed reply is logged by code and never fails the update (Telegram must not
 * redeliver it).
 */
@Injectable()
export class StaffBotService {
  private readonly logger = new Logger(StaffBotService.name);
  private readonly limiter = new CommandRateLimiter();

  constructor(
    @Inject(STAFF_BOT_SENDER) private readonly sender: TelegramSender | null,
    private readonly identity: IdentityService,
    private readonly links: WebLinks,
    private readonly clock: Clock,
  ) {}

  get configured(): boolean {
    return this.sender?.enabled === true;
  }

  async handleUpdate(raw: unknown): Promise<StaffBotOutcome> {
    const sender = this.sender;
    if (sender === null || !sender.enabled) return 'DISABLED';
    const parsed = parseUpdate(raw);
    if (!parsed.ok) return 'IGNORED';
    for (const event of parsed.events) {
      if (event.kind === 'CALLBACK_IGNORED') {
        await this.answerPress(sender, event.callbackQueryId);
        return 'IGNORED';
      }
      if (event.kind === 'LANGUAGE_CHOSEN') return this.handleChoice(sender, event);
      if (event.kind === 'COMMAND' && event.chatType === 'private') {
        return this.handleCommand(sender, event);
      }
    }
    return 'IGNORED';
  }

  private async handleCommand(
    sender: TelegramSender,
    command: CommandEvent,
  ): Promise<StaffBotOutcome> {
    const chatId = command.chatId.toString();
    // Counted before any database work: a flood must not cost queries.
    if (!this.limiter.tryAcquire(chatId, this.clock.now().getTime())) return 'RATE_LIMITED';
    // The staff bot carries no payload: its deep links are only ever plain starts. `/lang` asks
    // the same question at any time [owner 2026-11-14].
    if (command.command === 'start' || command.command === 'lang') {
      return this.send(sender, chatId, LANGUAGE_QUESTION, { buttons: languageButtons() });
    }
    const stored = await this.identity.findTelegramPerson(command.person.telegramUserId);
    return this.sendStartReply(sender, chatId, stored, stored?.language ?? command.person.language);
  }

  private async handleChoice(
    sender: TelegramSender,
    choice: ChoiceEvent,
  ): Promise<StaffBotOutcome> {
    await this.answerPress(sender, choice.callbackQueryId);
    const chatId = choice.chatId.toString();
    if (!this.limiter.tryAcquire(chatId, this.clock.now().getTime())) return 'RATE_LIMITED';
    try {
      await sender.clearButtons(chatId, choice.messageId);
    } catch {
      // The buttons may already be gone (a second press); the answer still follows.
    }
    await this.identity.setLanguageByTelegram(choice.person.telegramUserId, choice.language);
    const stored = await this.identity.findTelegramPerson(choice.person.telegramUserId);
    return this.sendStartReply(sender, chatId, stored, choice.language);
  }

  private sendStartReply(
    sender: TelegramSender,
    chatId: string,
    stored: TelegramPerson | null,
    locale: Locale,
  ): Promise<StaffBotOutcome> {
    const isStaff = isActiveStaff(stored);
    const reply = staffBotStartReply({
      locale,
      isStaff,
      name: isStaff ? greetingName(stored.fullName) : null,
      tashkentHour: getBusinessTimeParts(this.clock.now()).hour,
      staffAppUrl: this.links.staffHome(),
    });
    return this.send(
      sender,
      chatId,
      reply.text,
      reply.buttons.length > 0 ? { buttons: reply.buttons } : {},
    );
  }

  private async send(
    sender: TelegramSender,
    chatId: string,
    text: string,
    options: Omit<SendMessageOptions, 'disableLinkPreview'>,
  ): Promise<StaffBotOutcome> {
    try {
      await sender.sendMessage(chatId, text, { disableLinkPreview: true, ...options });
      return 'REPLIED';
    } catch (error) {
      const failure = error instanceof TelegramSendError ? error.failure : 'UNKNOWN';
      this.logger.warn(`Staff bot reply failed: ${failure}`);
      return 'SEND_FAILED';
    }
  }

  private async answerPress(sender: TelegramSender, callbackQueryId: string): Promise<void> {
    try {
      await sender.answerCallbackQuery(callbackQueryId);
    } catch (error) {
      const failure = error instanceof TelegramSendError ? error.failure : 'UNKNOWN';
      this.logger.warn(`Staff bot button answer failed: ${failure}`);
    }
  }
}
