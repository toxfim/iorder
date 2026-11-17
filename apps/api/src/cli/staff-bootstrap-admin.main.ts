import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClockModule } from '../common/clock/clock.js';
import { DomainError } from '../common/errors/domain-errors.js';
import { DatabaseModule } from '../common/database/database.module.js';
import { ConfigModule } from '../config/config.module.js';
import { IdentityModule, StaffAccountsService } from '../modules/identity/index.js';
import { bootstrapStaffAdmin } from './staff-bootstrap-admin.js';

// Entry point of `pnpm --filter @iorder/api staff:bootstrap-admin`. The login and password are read
// from the environment of this run (BOOTSTRAP_ADMIN_LOGIN / BOOTSTRAP_ADMIN_PASSWORD), never from a
// file in the repository, and are never printed or audited.
@Module({ imports: [ConfigModule, ClockModule, DatabaseModule, IdentityModule] })
class StaffBootstrapAdminModule {}

async function main(): Promise<number> {
  const app = await NestFactory.createApplicationContext(StaffBootstrapAdminModule, {
    logger: ['error', 'warn'],
  });
  try {
    const accounts = app.get(StaffAccountsService);
    return await bootstrapStaffAdmin({
      login: process.env['BOOTSTRAP_ADMIN_LOGIN'],
      password: process.env['BOOTSTRAP_ADMIN_PASSWORD'],
      argv: process.argv.slice(2),
      nodeEnv: process.env['NODE_ENV'],
      databaseUrl: process.env['DATABASE_URL'],
      hasOtherAdmins: (login) => accounts.otherActiveAdminsExist(login),
      bootstrap: (input) => accounts.bootstrapAdminAccount(input),
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
    const reason =
      error instanceof DomainError ? error.message : 'unexpected error, details withheld';
    console.error(`staff:bootstrap-admin failed: ${reason}`);
    process.exitCode = 1;
  },
);
