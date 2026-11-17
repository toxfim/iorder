import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClockModule } from '../common/clock/clock.js';
import { DatabaseModule } from '../common/database/database.module.js';
import { ConfigModule } from '../config/config.module.js';
import { ApiTokenService, IdentityModule } from '../modules/identity/index.js';
import { issueApiTokenCommand } from './api-token.js';

// Entry point of `pnpm --filter @iorder/api api:token-issue -- --user <login> --name <label>
// --scope MANAGE_PRODUCT_IMAGES [--days 7]`. Run by the owner only; see docs/api/product-images-api.md.
@Module({ imports: [ConfigModule, ClockModule, DatabaseModule, IdentityModule] })
class ApiTokenIssueModule {}

async function main(): Promise<number> {
  const app = await NestFactory.createApplicationContext(ApiTokenIssueModule, {
    logger: ['error', 'warn'],
  });
  try {
    const tokens = app.get(ApiTokenService);
    return await issueApiTokenCommand({
      argv: process.argv.slice(2),
      databaseUrl: process.env['DATABASE_URL'],
      issue: (input) => tokens.issue(input),
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
    console.error('api:token-issue failed: unexpected error, details withheld');
    process.exitCode = 1;
  },
);
