import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Bot } from 'grammy';
import { TELEGRAM_BOT } from './telegram.tokens.js';

/** How long an update waits for `getMe` before the command is treated as not addressed to us. */
export const USERNAME_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * The bot's own `@username`, needed to tell `/price@our_bot` from a command for another bot in a
 * group. Read from Telegram (`getMe`) and cached. It is asked for ONLY when an update really
 * contains `/command@name` (see `needsBotUsername`), and the wait is short: a slow or silent
 * Telegram must not hold up the handling of every update. A failure or a timeout returns
 * undefined (such a command is ignored) and the lookup is tried again on a later update.
 */
@Injectable()
export class BotIdentity {
  private readonly logger = new Logger(BotIdentity.name);
  private pending: Promise<string | undefined> | null = null;

  constructor(@Inject(TELEGRAM_BOT) private readonly bot: Bot | null) {}

  async username(timeoutMs: number = USERNAME_LOOKUP_TIMEOUT_MS): Promise<string | undefined> {
    if (this.bot === null) return undefined;
    this.pending ??= this.load(this.bot).then((name) => {
      // Do not cache a failure.
      if (name === undefined) this.pending = null;
      return name;
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    try {
      return await Promise.race([this.pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async load(bot: Bot): Promise<string | undefined> {
    try {
      if (!bot.isInited()) await bot.init();
      return bot.botInfo.username;
    } catch {
      this.logger.warn('Could not read the bot identity from Telegram');
      return undefined;
    }
  }
}
