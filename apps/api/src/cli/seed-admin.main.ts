import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClockModule } from '../common/clock/clock.js';
import { DomainError } from '../common/errors/domain-errors.js';
import { DatabaseModule } from '../common/database/database.module.js';
import { ConfigModule } from '../config/config.module.js';
import { IdentityModule, IdentityService } from '../modules/identity/index.js';
import { seedAdmin } from './seed-admin.js';

// Entry point of `pnpm --filter @iorder/api seed:admin`. Uses only the normal DATABASE_URL.
@Module({ imports: [ConfigModule, ClockModule, DatabaseModule, IdentityModule] })
class SeedAdminModule {}

async function main(): Promise<number> {
  const app = await NestFactory.createApplicationContext(SeedAdminModule, {
    logger: ['error', 'warn'],
  });
  try {
    const identity = app.get(IdentityService);
    return await seedAdmin({
      // Read here, not through the boot-time schema: only this script validates it.
      telegramId: process.env['DEVELOPER_TELEGRAM_ID'],
      argv: process.argv.slice(2),
      nodeEnv: process.env['NODE_ENV'],
      databaseUrl: process.env['DATABASE_URL'],
      bootstrapAdmin: (id) => identity.bootstrapAdmin(id),
      log: (line) => console.log(line),
    });
  } finally {
    await app.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Only our own domain messages are printed. Anything else (a database error can echo query
    // parameters such as the Telegram id) is withheld.
    const reason =
      error instanceof DomainError ? error.message : 'unexpected error, details withheld';
    console.error(`seed:admin failed: ${reason}`);
    process.exitCode = 1;
  },
);
