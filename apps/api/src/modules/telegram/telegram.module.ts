import { Module } from '@nestjs/common';
import type { Bot } from 'grammy';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { IdentityModule } from '../identity/index.js';
import { OrganizationsModule } from '../organizations/index.js';
import { PricingModule } from '../pricing/index.js';
import { BotIdentity } from './bot-identity.js';
import {
  createTelegramBot,
  GrammyTelegramSender,
  type TelegramApiTransport,
} from './bot-factory.js';
import { TelegramBotService } from './telegram-bot.service.js';
import { TelegramCommandService } from './telegram-command.service.js';
import { DisabledTelegramSender, TelegramSender } from './telegram-sender.js';
import { TelegramUpdateHandler } from './telegram-update.handler.js';
import { StaffNotificationsController } from './staff-notifications.controller.js';
import { StaffOrganizationInvitesController } from './staff-organization-invites.controller.js';
import { StaffBotWebhookController } from './staff-bot/staff-bot-webhook.controller.js';
import { StaffBotService } from './staff-bot/staff-bot.service.js';
import { TelegramWebhookController } from './telegram-webhook.controller.js';
import { STAFF_BOT_SENDER, TELEGRAM_API_TRANSPORT, TELEGRAM_BOT } from './telegram.tokens.js';
import { WebLinks } from './web-links.js';

/**
 * True when messages can really be sent: the mode is not `off` AND a bot token exists. Lives here
 * (with the factory that builds the bot from the token) so no other module reads the token.
 */
export function isTelegramSendingEnabled(env: Pick<Env, 'TELEGRAM_MODE' | 'BOT_TOKEN'>): boolean {
  return env.TELEGRAM_MODE !== 'off' && env.BOT_TOKEN !== undefined;
}

/**
 * The Telegram bot: group events -> organizations and members, commands, the webhook endpoint
 * and the outbound sender.
 *
 * HOW THE OWNER STARTS IT (nothing starts by itself, and an agent never does it):
 *  - Development, by hand, with a TEST bot token: set `TELEGRAM_MODE=polling`, the bot token and
 *    `WEB_APP_URL` in `.env`, then run `pnpm --filter @iorder/api bot:polling` (Ctrl+C stops it).
 *    Add the test bot to a test group: the organization appears.
 *  - Queued order notifications are delivered by `pnpm --filter @iorder/api bot:dispatch-once --
 *    --confirm-send` (real messages!). A scheduler for it is a later task.
 *  - Production: `TELEGRAM_MODE=webhook` + `TELEGRAM_WEBHOOK_SECRET`; the webhook is registered
 *    with Telegram (`setWebhook`, `secret_token` = the same secret, URL `/telegram/webhook/<secret>`)
 *    as a deployment step. `setWebhook` MUST request `allowed_updates` = `["message",
 *    "my_chat_member", "chat_member", "callback_query"]` (`ALLOWED_UPDATES`): Telegram sends
 *    `chat_member` (people joining and leaving) only when it is asked for explicitly, and without
 *    it members of a group are noticed only when they write; without `callback_query` the
 *    language buttons of a private /start do nothing (added 2026-11-13: register again).
 *  - An organization created from a group starts INACTIVE; only staff activate it
 *    (`PATCH /staff/organizations/:id`). The bot never activates one.
 *  - With `TELEGRAM_MODE` unset or `off` the webhook route answers 404 and nothing polls.
 *
 * Without `BOT_TOKEN` there is no Bot, the sender is the disabled one and nothing can reach
 * Telegram. With a token, a Bot is still only an object: it contacts Telegram when something
 * sends, or when polling is started on purpose.
 */
@Module({
  imports: [IdentityModule, OrganizationsModule, PricingModule],
  controllers: [
    TelegramWebhookController,
    StaffNotificationsController,
    StaffBotWebhookController,
    StaffOrganizationInvitesController,
  ],
  providers: [
    // Overridden in tests with a recording fake; null means "use the real network".
    { provide: TELEGRAM_API_TRANSPORT, useValue: null },
    {
      provide: TELEGRAM_BOT,
      useFactory: (
        env: Pick<Env, 'BOT_TOKEN'>,
        transport: TelegramApiTransport | null,
      ): Bot | null =>
        env.BOT_TOKEN === undefined ? null : createTelegramBot({ token: env.BOT_TOKEN, transport }),
      inject: [APP_ENV, TELEGRAM_API_TRANSPORT],
    },
    {
      provide: TelegramSender,
      useFactory: (bot: Bot | null): TelegramSender =>
        bot === null ? new DisabledTelegramSender() : new GrammyTelegramSender(bot),
      inject: [TELEGRAM_BOT],
    },
    {
      // The staff bot answers only its own `/start`; it is off with Telegram off or without its
      // token. It shares the transport, so tests never reach api.telegram.org through it either.
      provide: STAFF_BOT_SENDER,
      useFactory: (
        env: Pick<Env, 'TELEGRAM_MODE' | 'STAFF_MINI_APP_BOT_TOKEN'>,
        transport: TelegramApiTransport | null,
      ): TelegramSender | null =>
        env.TELEGRAM_MODE === 'off' || env.STAFF_MINI_APP_BOT_TOKEN === undefined
          ? null
          : new GrammyTelegramSender(
              createTelegramBot({ token: env.STAFF_MINI_APP_BOT_TOKEN, transport }),
            ),
      inject: [APP_ENV, TELEGRAM_API_TRANSPORT],
    },
    {
      provide: WebLinks,
      useFactory: (
        env: Pick<
          Env,
          | 'WEB_APP_URL'
          | 'TELEGRAM_MINI_APP_URL'
          | 'STAFF_WEB_APP_URL'
          | 'TELEGRAM_STAFF_MINI_APP_URL'
          | 'STAFF_MINI_APP_BOT_TOKEN'
        >,
      ): WebLinks =>
        new WebLinks(env.WEB_APP_URL, env.TELEGRAM_MINI_APP_URL, env.STAFF_WEB_APP_URL, {
          directLink: env.TELEGRAM_STAFF_MINI_APP_URL,
          // Messages are sent by BOT_TOKEN's bot; with a staff bot its launches sign nobody in.
          mainBotSignsStaffIn: env.STAFF_MINI_APP_BOT_TOKEN === undefined,
        }),
      inject: [APP_ENV],
    },
    BotIdentity,
    TelegramCommandService,
    TelegramUpdateHandler,
    TelegramBotService,
    StaffBotService,
  ],
  exports: [TelegramSender, TelegramBotService, WebLinks],
})
export class TelegramModule {}
