import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClockModule } from '../common/clock/clock.js';
import { DatabaseModule } from '../common/database/database.module.js';
import { ConfigModule } from '../config/config.module.js';
import { TelegramBotService, TelegramModule } from '../modules/telegram/index.js';

// Entry point of `pnpm --filter @iorder/api bot:polling`: the DEVELOPMENT way to run the bot.
//
// NEVER started automatically and NEVER run by an agent: it talks to the real Telegram API with
// the real bot token from .env. The owner runs it by hand, in a terminal, like this:
//
//   1. In .env set TELEGRAM_MODE=polling and the bot token to a token of a TEST bot (not the
//      production one: polling deletes the bot's webhook).
//   2. Make sure the dev database is migrated and WEB_APP_URL points to the dev web app.
//   3. pnpm --filter @iorder/api bot:polling       (Ctrl+C stops it)
//   4. Add the test bot to a test group: the organization appears; people joining become members.
//
// To deliver queued order notifications by hand use `bot:dispatch-once`.
@Module({ imports: [ConfigModule, ClockModule, DatabaseModule, TelegramModule] })
class BotPollingModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(BotPollingModule, {
    logger: ['log', 'error', 'warn'],
  });
  const bot = app.get(TelegramBotService);
  const stop = (): void => {
    void bot.stopPolling();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await bot.startPolling();
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // Telegram errors can echo request payloads: print only our own message or the error name.
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unexpected error';
  console.error(`bot:polling stopped: ${reason}`);
  process.exitCode = 1;
});
