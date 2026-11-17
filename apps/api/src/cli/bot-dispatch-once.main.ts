import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClockModule } from '../common/clock/clock.js';
import { DatabaseModule } from '../common/database/database.module.js';
import { ConfigModule } from '../config/config.module.js';
import { NotificationsModule, OutboxDispatcher } from '../modules/notifications/index.js';

// Entry point of `pnpm --filter @iorder/api bot:dispatch-once`: one pass over the notification
// outbox (the pg-boss scheduler that will run it regularly is a later task).
//
// NEVER run by an agent: with a real bot token it sends REAL Telegram messages to the people and
// groups named in the outbox rows. It therefore needs `--confirm-send` as an explicit argument:
//
//   pnpm --filter @iorder/api bot:dispatch-once -- --confirm-send [--batch 20]
//
// It prints only counts, never message texts or chat ids.
@Module({ imports: [ConfigModule, ClockModule, DatabaseModule, NotificationsModule] })
class BotDispatchModule {}

function parseBatch(argv: readonly string[]): number | undefined {
  const index = argv.indexOf('--batch');
  if (index === -1) return undefined;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error('--batch needs a positive integer');
  return value;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (!argv.includes('--confirm-send')) {
    console.error('bot:dispatch-once sends real Telegram messages. Add --confirm-send to proceed.');
    return 1;
  }
  const batch = parseBatch(argv);
  const app = await NestFactory.createApplicationContext(BotDispatchModule, {
    logger: ['error', 'warn'],
  });
  try {
    const dispatcher = app.get(OutboxDispatcher);
    // Before anything is sent: a role without the column grants would send and then be unable to
    // record it, so the same message would go out again on every run.
    await dispatcher.assertDeliveryGrants();
    const summary = await dispatcher.runOnce(batch);
    console.log(
      `claimed ${summary.claimed}, sent ${summary.sent}, retry later ${summary.retried}, failed ${summary.failed}, errors ${summary.errors}`,
    );
    return 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unexpected error';
    console.error(`bot:dispatch-once failed: ${reason}`);
    process.exitCode = 1;
  },
);
