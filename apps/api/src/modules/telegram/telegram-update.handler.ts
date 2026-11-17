import { Injectable, Logger } from '@nestjs/common';
import { OrganizationsService } from '../organizations/index.js';
import { BotIdentity } from './bot-identity.js';
import { needsBotUsername, parseUpdate, type BotEvent } from './bot-events.js';
import { TelegramCommandService } from './telegram-command.service.js';

export interface UpdateSummary {
  /** False when the update did not match the expected shape and was dropped. */
  accepted: boolean;
  events: number;
}

/**
 * Routes one Telegram update to the services that own the rules. No business rule lives here:
 * the update is validated (zod, `parseEnv`-style, in `bot-events.ts`), turned into events, and
 * each event is a call to an exported service. Used by polling and by the webhook alike.
 *
 * An exception from a service means a real fault (for example the database is down): it
 * propagates, so the webhook can answer 5xx and Telegram retries the update. Every handler below
 * is idempotent, so a retry is safe.
 */
@Injectable()
export class TelegramUpdateHandler {
  private readonly logger = new Logger(TelegramUpdateHandler.name);

  constructor(
    private readonly organizations: OrganizationsService,
    private readonly commands: TelegramCommandService,
    private readonly identity: BotIdentity,
  ) {}

  async handle(raw: unknown): Promise<UpdateSummary> {
    // Telegram is asked for the bot's name only for `/command@name` (short wait, see BotIdentity).
    const botUsername = needsBotUsername(raw) ? await this.identity.username() : undefined;
    const parsed = parseUpdate(raw, botUsername);
    if (!parsed.ok) return { accepted: false, events: 0 };
    for (const event of parsed.events) await this.dispatch(event);
    return { accepted: true, events: parsed.events.length };
  }

  private async dispatch(event: BotEvent): Promise<void> {
    switch (event.kind) {
      case 'BOT_ADDED': {
        await this.organizations.registerTelegramGroup({
          chatId: event.chatId,
          title: event.title,
          addedBy: event.addedBy,
          eventAt: event.eventAt,
        });
        return;
      }
      case 'BOT_REMOVED': {
        await this.organizations.deactivateTelegramGroup(event);
        return;
      }
      case 'TITLE_CHANGED': {
        await this.organizations.renameTelegramGroup(event);
        return;
      }
      case 'CHAT_MIGRATED': {
        const result = await this.organizations.migrateTelegramChat({
          chatId: event.fromChatId,
          toChatId: event.toChatId,
          eventAt: event.eventAt,
        });
        if (result.outcome === 'TARGET_EXISTS') {
          this.logger.warn(`Group ${event.fromChatId} migrated to ${event.toChatId}: both exist`);
        }
        return;
      }
      case 'MEMBER_PRESENT': {
        const result = await this.organizations.recordTelegramMemberPresent({
          chatId: event.chatId,
          telegramUserId: event.person.telegramUserId,
          fullName: event.person.fullName,
          language: event.person.language,
          eventAt: event.eventAt,
        });
        if (result.kind === 'CONFLICT') {
          // Nobody is moved. The organizations service already wrote the staff notice (once).
          this.logger.debug(`A person is already a member elsewhere; not added to ${event.chatId}`);
        }
        return;
      }
      case 'MEMBER_LEFT': {
        await this.organizations.recordTelegramMemberLeft({
          chatId: event.chatId,
          telegramUserId: event.telegramUserId,
          eventAt: event.eventAt,
        });
        return;
      }
      case 'COMMAND': {
        await this.commands.handle(event);
        return;
      }
      case 'LANGUAGE_CHOSEN': {
        await this.commands.handleLanguageChosen(event);
        return;
      }
      case 'CALLBACK_IGNORED': {
        await this.commands.handleIgnoredPress(event.callbackQueryId);
        return;
      }
    }
  }
}
