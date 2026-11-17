import { Body, Controller, Headers, HttpCode, Inject, Logger, Param, Post } from '@nestjs/common';
import { Public } from '../../common/auth/route-access.js';
import { NotFoundError, UnauthenticatedError } from '../../common/errors/domain-errors.js';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { TelegramBotService } from './telegram-bot.service.js';
import { MAX_UPDATE_FAILURES, UpdateFailureTracker } from './update-failure-tracker.js';
import { checkWebhookRequest } from './webhook-secret.js';

/** The `update_id` of a raw body, or null when it is not a usable number. */
function readUpdateId(body: unknown): number | null {
  if (typeof body !== 'object' || body === null || !('update_id' in body)) return null;
  const id = body.update_id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/**
 * Telegram's webhook. `@Public` because Telegram cannot log in; the request proves itself with
 * the shared secret instead (URL segment AND `X-Telegram-Bot-Api-Secret-Token`, compared in
 * constant time). Anything else gets a bare 404/401 and nothing is processed.
 *
 * A request that proves itself is answered 200 whatever the body (a malformed update must not be
 * redelivered forever). The one exception is an unexpected fault while handling a valid update
 * (database down): that becomes a 5xx so Telegram redelivers it, which is safe because every
 * handler is idempotent.
 */
@Controller('telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);
  private readonly failures = new UpdateFailureTracker();

  constructor(
    @Inject(APP_ENV)
    private readonly env: Pick<Env, 'TELEGRAM_MODE' | 'TELEGRAM_WEBHOOK_SECRET'>,
    private readonly bot: TelegramBotService,
  ) {}

  @Public()
  @Post('webhook/:secret')
  @HttpCode(200)
  async receive(
    @Param('secret') secret: string,
    @Headers('x-telegram-bot-api-secret-token') headerSecret: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const check = checkWebhookRequest({
      mode: this.env.TELEGRAM_MODE,
      expectedSecret: this.env.TELEGRAM_WEBHOOK_SECRET,
      pathSecret: secret,
      headerSecret,
    });
    if (check === 'NOT_FOUND') throw new NotFoundError('Not found');
    if (check === 'UNAUTHORIZED') throw new UnauthenticatedError('Unauthorized');
    await this.handleUpdate(body);
    return { ok: true };
  }

  /**
   * Runs the update. A fault is logged by NAME and update id only (the stack and the arguments of
   * a handler can contain message texts and names), then rethrown as a generic error so the
   * client sees a plain 500 and Telegram redelivers. The same update failing
   * `MAX_UPDATE_FAILURES` times is answered 200 instead, to end a redelivery storm (the tradeoff
   * is documented in `UpdateFailureTracker`).
   */
  private async handleUpdate(body: unknown): Promise<void> {
    const updateId = readUpdateId(body);
    try {
      await this.bot.handleWebhookUpdate(body);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      const failures = updateId === null ? 1 : this.failures.recordFailure(updateId);
      this.logger.error(
        `Telegram update ${updateId ?? 'without id'} failed (${failures}): ${name}`,
      );
      if (updateId !== null && failures >= MAX_UPDATE_FAILURES) {
        this.logger.error(`Telegram update ${updateId} is dropped after ${failures} failures`);
        return;
      }
      // No `cause` on purpose: the original error (its stack, its arguments) may hold message
      // texts and names, and the error filter logs everything it is given.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Telegram update handling failed');
    }
    if (updateId !== null) this.failures.clear(updateId);
  }
}
