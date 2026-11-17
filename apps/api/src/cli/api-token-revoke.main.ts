import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClockModule } from '../common/clock/clock.js';
import { DatabaseModule } from '../common/database/database.module.js';
import { ConfigModule } from '../config/config.module.js';
import { ApiTokenService, IdentityModule } from '../modules/identity/index.js';
import { revokeApiTokenCommand } from './api-token.js';

// Entry point of `pnpm --filter @iorder/api api:token-revoke -- --id <token id>`. Owner only.
@Module({ imports: [ConfigModule, ClockModule, DatabaseModule, IdentityModule] })
class ApiTokenRevokeModule {}

async function main(): Promise<number> {
  const app = await NestFactory.createApplicationContext(ApiTokenRevokeModule, {
    logger: ['error', 'warn'],
  });
  try {
    const tokens = app.get(ApiTokenService);
    return await revokeApiTokenCommand({
      argv: process.argv.slice(2),
      databaseUrl: process.env['DATABASE_URL'],
      revoke: (id) => tokens.revoke(id),
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
  () => {
    console.error('api:token-revoke failed: unexpected error, details withheld');
    process.exitCode = 1;
  },
);
