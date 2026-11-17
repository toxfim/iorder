import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Bot } from 'grammy';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { TELEGRAM_BOT } from './telegram.tokens.js';
import { TelegramUpdateHandler, type UpdateSummary } from './telegram-update.handler.js';

/**
 * The update kinds the bot reads; asking for fewer keeps Telegram's traffic small. `callback_query`
 * carries the language buttons of a private /start [C, owner 2026-11-13].
 */
export const ALLOWED_UPDATES = [
  'message',
  'my_chat_member',
  'chat_member',
  'callback_query',
] as const;

/**
 * Runs the bot. NOTHING here starts by itself: the application never begins polling on boot, and
 * the webhook route answers only when `TELEGRAM_MODE=webhook`. Polling is started by hand, in
 * development, by the `bot:polling` script (see `apps/api/src/cli/bot-polling.main.ts`).
 */
@Injectable()
export class TelegramBotService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private polling = false;

  constructor(
    @Inject(APP_ENV) private readonly env: Pick<Env, 'TELEGRAM_MODE'>,
    @Inject(TELEGRAM_BOT) private readonly bot: Bot | null,
    private readonly handler: TelegramUpdateHandler,
  ) {}

  get mode(): Env['TELEGRAM_MODE'] {
    return this.env.TELEGRAM_MODE;
  }

  /** One update from the webhook. Throws only on a real fault, so the caller can answer 5xx. */
  handleWebhookUpdate(raw: unknown): Promise<UpdateSummary> {
    return this.handler.handle(raw);
  }

  /**
   * Long polling for development. Resolves when polling stops. Refuses to run unless
   * `TELEGRAM_MODE=polling` was set on purpose and a bot token exists. grammY deletes a registered
   * webhook when polling starts, so this must never be run against the production bot.
   */
  async startPolling(): Promise<void> {
    if (this.env.TELEGRAM_MODE !== 'polling') {
      throw new Error('TELEGRAM_MODE must be "polling" to start polling');
    }
    if (this.bot === null) throw new Error('The bot token is not configured');
    if (this.polling) throw new Error('Polling is already running');
    const bot = this.bot;
    bot.use(async (context) => {
      await this.handler.handle(context.update);
    });
    // The error text can carry a payload (a message text): log only that it happened.
    bot.catch((error) => {
      this.logger.error(
        `Update handling failed: ${error.error instanceof Error ? error.error.name : 'unknown'}`,
      );
    });
    this.polling = true;
    try {
      await bot.start({
        allowed_updates: [...ALLOWED_UPDATES],
        onStart: () => this.logger.log('Polling started'),
      });
    } finally {
      this.polling = false;
    }
  }

  async stopPolling(): Promise<void> {
    if (this.polling && this.bot !== null) await this.bot.stop();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopPolling();
  }
}
