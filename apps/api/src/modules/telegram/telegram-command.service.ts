import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock/clock.js';
import { NotFoundError } from '../../common/errors/domain-errors.js';
import { DEFAULT_LOCALE, type PriceTier } from '@iorder/shared';
import { STAFF_LINK_START_PREFIX } from '@iorder/shared/staff-auth';
import { IdentityService, StaffBotLinkService, type TelegramPerson } from '../identity/index.js';
import {
  isInvitePayload,
  OrganizationsService,
  type InviteBindOutcome,
} from '../organizations/index.js';
import { PriceListExportService } from '../pricing/index.js';
import type { BotEvent } from './bot-events.js';
import { replyTexts } from './bot-replies.js';
import { CommandRateLimiter } from './command-rate-limiter.js';
import { LANGUAGE_QUESTION, languageButtons, payloadFitsChoice } from './language-choice.js';
import { TelegramSender, TelegramSendError, type SendMessageOptions } from './telegram-sender.js';
import { WebLinks } from './web-links.js';

export type CommandEvent = Extract<BotEvent, { kind: 'COMMAND' }>;
export type LanguageChosenEvent = Extract<BotEvent, { kind: 'LANGUAGE_CHOSEN' }>;

const withSuffix = (text: string, suffix: string | undefined): string =>
  suffix === undefined ? text : `${text}\n\n${suffix}`;

/** The deep-link payloads a language button carries: the ones that bind something. */
function carriedPayload(payload: string | undefined): string | undefined {
  if (payload === undefined) return undefined;
  return payload.startsWith(STAFF_LINK_START_PREFIX) || isInvitePayload(payload)
    ? payload
    : undefined;
}
export type CommandOutcome = 'REPLIED' | 'RATE_LIMITED' | 'SEND_FAILED' | 'DISABLED';

/**
 * Answers `/start`, `/lang`, `/price` and `/help`. Holds no business rule beyond "who may see the price
 * link": the facts come from the identity module, the reply goes out through the same
 * `TelegramSender` as notifications. A failed reply is logged by code and never fails the update.
 */
@Injectable()
export class TelegramCommandService {
  private readonly logger = new Logger(TelegramCommandService.name);
  private readonly limiter = new CommandRateLimiter();

  constructor(
    private readonly identity: IdentityService,
    private readonly sender: TelegramSender,
    private readonly links: WebLinks,
    private readonly clock: Clock,
    private readonly organizations: OrganizationsService,
    private readonly priceExport: PriceListExportService,
    private readonly botLinks: StaffBotLinkService,
  ) {}

  async handle(event: CommandEvent): Promise<CommandOutcome> {
    // An organization invite binds the chat even when replies cannot be sent: the binding is the
    // point, the greeting only an extra.
    const invite = event.command === 'start' && isInvitePayload(event.startPayload);
    if (!this.sender.enabled && !invite) return 'DISABLED';
    const chatId = event.chatId.toString();
    // Counted before any database work: a flood must not cost queries. Keyed by chat AND person,
    // so one member's spam cannot use up the budget of everybody else in the group.
    const key = `${chatId}:${event.person.telegramUserId}`;
    if (!this.limiter.tryAcquire(key, this.clock.now().getTime())) return 'RATE_LIMITED';
    // A private /start asks the language first [C, owner 2026-11-13]; a binding payload rides in
    // the buttons and runs after the choice. Without a working sender (no question can be sent),
    // or for a payload too long for the buttons, the payload is handled at once as before.
    const carried = carriedPayload(event.startPayload);
    if (
      event.command === 'start' &&
      event.chatType === 'private' &&
      this.sender.enabled &&
      payloadFitsChoice(carried)
    ) {
      return this.reply(chatId, LANGUAGE_QUESTION, { buttons: languageButtons(carried) });
    }
    // `/lang` asks the same question at any time [owner 2026-11-14], in a private chat only: a
    // press is a choice only in the private chat of the person who pressed (bot-events), and a
    // group always speaks UZ, so a group `/lang` gets the command list instead [P].
    if (event.command === 'lang' && event.chatType === 'private' && this.sender.enabled) {
      return this.reply(chatId, LANGUAGE_QUESTION, { buttons: languageButtons() });
    }
    if (invite && event.startPayload !== undefined) {
      return this.handleInvite(event, chatId, event.startPayload);
    }

    const stored = await this.identity.findTelegramPerson(event.person.telegramUserId);
    const texts = replyTexts(stored?.language ?? event.person.language);
    if (event.command === 'price') return this.handlePrice(event, chatId, stored, texts);
    if (event.command === 'start' && event.chatType === 'private') {
      return this.handlePrivateStart(event, chatId, stored, texts);
    }
    const text = event.command === 'start' ? texts.start(this.links.home()) : texts.help;
    return this.reply(chatId, text);
  }

  /**
   * A language button was pressed [C, owner 2026-11-13]: the press is answered, the buttons go
   * away, the language is saved for a person who has a row (audited by the identity module), and
   * then comes what the /start was for, in that language: the binding of a carried payload, or
   * the explanation of the commands.
   */
  async handleLanguageChosen(event: LanguageChosenEvent): Promise<CommandOutcome> {
    await this.answerPress(event.callbackQueryId);
    if (!this.sender.enabled) return 'DISABLED';
    const chatId = event.chatId.toString();
    const key = `${chatId}:${event.person.telegramUserId}`;
    if (!this.limiter.tryAcquire(key, this.clock.now().getTime())) return 'RATE_LIMITED';
    await this.removeButtons(chatId, event.messageId);
    await this.identity.setLanguageByTelegram(event.person.telegramUserId, event.language);

    // The rest is the ordinary private /start, with the chosen language as the person's. Only a
    // binding payload counts; anything else a crafted press carries is dropped.
    const payload = carriedPayload(event.startPayload);
    const start: CommandEvent = {
      kind: 'COMMAND',
      command: 'start',
      chatId: event.chatId,
      chatType: 'private',
      person: { ...event.person, language: event.language },
      eventAt: this.clock.now(),
      ...(payload === undefined ? {} : { startPayload: payload }),
    };
    const texts = replyTexts(event.language);
    if (start.startPayload === undefined) {
      const stored = await this.identity.findTelegramPerson(event.person.telegramUserId);
      return this.handlePrivateStart(start, chatId, stored, texts);
    }
    // A carried payload: its own answer, and under it the commands, in one message.
    const commands = texts.commands(this.links.home());
    return isInvitePayload(start.startPayload)
      ? this.handleInvite(start, chatId, start.startPayload, commands)
      : this.handlePrivateStart(
          start,
          chatId,
          await this.identity.findTelegramPerson(event.person.telegramUserId),
          texts,
          commands,
        );
  }

  /** Any other button press: answered only, so that the person's app stops waiting. */
  async handleIgnoredPress(callbackQueryId: string): Promise<void> {
    if (this.sender.enabled) await this.answerPress(callbackQueryId);
  }

  /**
   * `/start org_<token>` [P]: a PERSON invite in a private chat binds the person; a GROUP invite in
   * a group (sent by Telegram right after `?startgroup=` added the bot) binds the group. The rules
   * live in OrganizationsService; this answers each outcome in the person's language (a group in
   * UZ, like every group message).
   */
  private async handleInvite(
    event: CommandEvent,
    chatId: string,
    payload: string,
    /** Text added under the answer (the commands, after a language choice). */
    suffix?: string,
  ): Promise<CommandOutcome> {
    const isGroup = event.chatType === 'group';
    const outcome: InviteBindOutcome = isGroup
      ? await this.organizations.bindGroupByInvite(payload, {
          chatId: event.chatId,
          title: event.chatTitle ?? '',
          eventAt: event.eventAt,
          addedBy: {
            telegramUserId: event.person.telegramUserId,
            name: event.person.fullName,
          },
        })
      : await this.organizations.bindPersonByInvite(payload, {
          telegramUserId: event.person.telegramUserId,
          fullName: event.person.fullName,
          language: event.person.language,
        });
    if (outcome.kind === 'LINKED') {
      if (isGroup) {
        // The person who added the bot is in the group: recorded now, not at their next message.
        await this.organizations.recordTelegramMemberPresent({
          chatId: event.chatId,
          telegramUserId: event.person.telegramUserId,
          fullName: event.person.fullName,
          language: event.person.language,
          eventAt: event.eventAt,
        });
      } else {
        // They pressed Start: the bot may write to them from now on.
        await this.botLinks.recordStarted(event.person.telegramUserId);
      }
    }
    if (!this.sender.enabled) return 'DISABLED';
    const texts = replyTexts(isGroup ? DEFAULT_LOCALE : event.person.language).invite;
    let text: string;
    if (outcome.kind === 'LINKED') {
      text = isGroup ? texts.groupLinked : texts.personLinked(greetingName(event.person.fullName));
    } else {
      text = texts[outcome.kind];
    }
    return this.reply(chatId, withSuffix(text, suffix));
  }

  /**
   * A private `/start`: from now on the bot may write to this person. With a staff connect
   * payload (the deep link from the staff app) it also links the Telegram id to the staff
   * account that asked for the link ([C] 2026-10-25).
   */
  private async handlePrivateStart(
    event: CommandEvent,
    chatId: string,
    stored: TelegramPerson | null,
    texts: ReturnType<typeof replyTexts>,
    suffix?: string,
  ): Promise<CommandOutcome> {
    if (event.startPayload?.startsWith(STAFF_LINK_START_PREFIX)) {
      const outcome = await this.botLinks.connectByStart(event.startPayload, {
        telegramUserId: event.person.telegramUserId,
      });
      return this.reply(chatId, withSuffix(texts.connect[outcome], suffix));
    }
    if (stored !== null) await this.botLinks.recordStarted(event.person.telegramUserId);
    return this.reply(chatId, texts.commands(this.links.home()));
  }

  /**
   * `/price`: the Excel file of the published price list. Two checks, both on the server: the
   * person may see prices, and in a group the person belongs to THAT group's organization, which is
   * ACTIVE (a member of another organization, or of an inactive one, gets the refusal). Groups always get UZ
   * (question 28 in the work log); a private chat uses the person's language. The file is built
   * in memory at send time, so nothing about it needs the outbox (which carries text only).
   */
  private async handlePrice(
    event: CommandEvent,
    chatId: string,
    stored: TelegramPerson | null,
    personTexts: ReturnType<typeof replyTexts>,
  ): Promise<CommandOutcome> {
    const isGroup = event.chatType === 'group';
    const texts = isGroup ? replyTexts(DEFAULT_LOCALE) : personTexts;
    const allowed = mayOpenPrices(stored) && (!isGroup || (await this.mayUseGroup(stored, event)));
    if (!allowed) return this.reply(chatId, texts.priceRefused);

    const lang = isGroup ? DEFAULT_LOCALE : (stored?.language ?? event.person.language);
    try {
      // The tier of the chat's organization [C, owner 2026-11-11]: in a group the GROUP's (whoever
      // asks, staff included: the file lands in that group), in a private chat the person's own
      // organization's; staff in a private chat get STANDARD.
      const file = await this.priceExport.buildCurrent(
        lang,
        await this.priceTierFor(event, stored),
      );
      const miniApp = this.links.miniApp();
      await this.sender.sendDocument(
        chatId,
        { fileName: file.fileName, data: file.data },
        {
          caption: texts.priceCaption(file.versionNumber, file.publishedAtLabel),
          ...(miniApp === null ? {} : { button: { text: texts.priceButton, url: miniApp } }),
        },
      );
      return 'REPLIED';
    } catch (error) {
      if (error instanceof NotFoundError) return this.reply(chatId, texts.priceNoList);
      // Only a code or an error class name is logged: never a message, which could carry data.
      const failure =
        error instanceof TelegramSendError
          ? error.failure
          : error instanceof Error
            ? error.name
            : 'UNKNOWN';
      this.logger.warn(`Price file reply failed: ${failure}`);
      // The person must not be left without an answer, unless the chat itself cannot be reached
      // (the reply would fail the same way). A failure of this reply is logged by reply().
      if (error instanceof TelegramSendError && error.failure !== 'RECIPIENT_UNREACHABLE') {
        await this.reply(chatId, texts.priceFailed);
      }
      return 'SEND_FAILED';
    }
  }

  /**
   * In a group the person must belong to THAT group's organization, which must be ACTIVE: a
   * member of organization A typing in organization B's group must not get B's chat to carry the
   * file. Staff are never members and stay allowed in any active organization's group.
   */
  private async mayUseGroup(person: TelegramPerson | null, event: CommandEvent): Promise<boolean> {
    const groupOrganizationId = await this.organizations.findActiveOrganizationIdByChat(
      event.chatId,
    );
    if (groupOrganizationId === null) return false;
    if (person !== null && person.staffRoles.length > 0) return true;
    return person?.membership?.organizationId === groupOrganizationId;
  }

  private async priceTierFor(
    event: CommandEvent,
    person: TelegramPerson | null,
  ): Promise<PriceTier> {
    const organizationId =
      event.chatType === 'group'
        ? await this.organizations.findActiveOrganizationIdByChat(event.chatId)
        : (person?.membership?.organizationId ?? null);
    return organizationId === null ? 'STANDARD' : this.organizations.findPriceTier(organizationId);
  }

  private async reply(
    chatId: string,
    text: string,
    options: Omit<SendMessageOptions, 'disableLinkPreview'> = {},
  ): Promise<CommandOutcome> {
    try {
      await this.sender.sendMessage(chatId, text, { disableLinkPreview: true, ...options });
      return 'REPLIED';
    } catch (error) {
      const failure = error instanceof TelegramSendError ? error.failure : 'UNKNOWN';
      this.logger.warn(`Command reply failed: ${failure}`);
      return 'SEND_FAILED';
    }
  }

  /** Best effort: a press that cannot be answered still gets its reply. Logged by code only. */
  private async answerPress(callbackQueryId: string): Promise<void> {
    try {
      await this.sender.answerCallbackQuery(callbackQueryId);
    } catch (error) {
      const failure = error instanceof TelegramSendError ? error.failure : 'UNKNOWN';
      this.logger.warn(`Button answer failed: ${failure}`);
    }
  }

  /** Best effort, like answerPress: the buttons may already be gone (a second press). */
  private async removeButtons(chatId: string, messageId: number): Promise<void> {
    try {
      await this.sender.clearButtons(chatId, messageId);
    } catch (error) {
      const failure = error instanceof TelegramSendError ? error.failure : 'UNKNOWN';
      this.logger.debug(`Removing the language buttons failed: ${failure}`);
    }
  }
}

/**
 * Members of an ACTIVE organization see the customer price page. Staff get the link too: the
 * web app sends each role to its own pages and the server enforces access, so the link grants
 * nothing. A blocked person gets the refusal.
 */
/** A short, printable name for the greeting: Telegram's name, bounded; never empty. */
function greetingName(fullName: string): string {
  const trimmed = fullName.trim().slice(0, 64);
  return trimmed === '' ? 'mijoz' : trimmed;
}

function mayOpenPrices(person: TelegramPerson | null): boolean {
  if (!person || person.status !== 'ACTIVE') return false;
  if (person.staffRoles.length > 0) return true;
  return person.membership?.organizationActive === true;
}
