import { Body, Controller, Headers, HttpCode, Inject, Logger, Param, Post } from '@nestjs/common';
import { Public } from '../../../common/auth/route-access.js';
import { NotFoundError, UnauthenticatedError } from '../../../common/errors/domain-errors.js';
import { APP_ENV } from '../../../config/config.module.js';
import type { Env } from '../../../config/env.js';
import { checkWebhookRequest } from '../webhook-secret.js';
import { StaffBotService } from './staff-bot.service.js';

/**
 * The staff bot's webhook (`setWebhook` of the staff Mini App bot with
 * `secret_token` = STAFF_BOT_WEBHOOK_SECRET, URL `/telegram/webhook-staff/<secret>`,
 * `allowed_updates` = `["message", "callback_query"]`; the second carries the language buttons
 * since 2026-11-13). The same proof as the main webhook: the secret in the URL
 * AND in Telegram's header, compared in constant time. Without the staff bot or its secret the
 * route answers 404, as if it did not exist.
 */
@Controller('telegram')
export class StaffBotWebhookController {
  private readonly logger = new Logger(StaffBotWebhookController.name);

  constructor(
    @Inject(APP_ENV)
    private readonly env: Pick<Env, 'TELEGRAM_MODE' | 'STAFF_BOT_WEBHOOK_SECRET'>,
    private readonly staffBot: StaffBotService,
  ) {}

  @Public()
  @Post('webhook-staff/:secret')
  @HttpCode(200)
  async receive(
    @Param('secret') secret: string,
    @Headers('x-telegram-bot-api-secret-token') headerSecret: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const check = checkWebhookRequest({
      mode: this.env.TELEGRAM_MODE,
      expectedSecret: this.staffBot.configured ? this.env.STAFF_BOT_WEBHOOK_SECRET : undefined,
      pathSecret: secret,
      headerSecret,
    });
    if (check === 'NOT_FOUND') throw new NotFoundError('Not found');
    if (check === 'UNAUTHORIZED') throw new UnauthenticatedError('Unauthorized');
    try {
      await this.staffBot.handleUpdate(body);
    } catch (error) {
      // Only the error's name: its message or stack may quote the update. Telegram redelivers
      // after the 500, which is safe: the reply is the only effect.
      this.logger.error(
        `Staff bot update failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Staff bot update handling failed');
    }
    return { ok: true };
  }
}
