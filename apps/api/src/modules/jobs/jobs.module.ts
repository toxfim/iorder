import { DynamicModule, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/index.js';
import { PricingModule } from '../pricing/index.js';
import { SheetsSyncModule } from '../sheets-sync/index.js';
import { isTelegramSendingEnabled } from '../telegram/index.js';
import type { TelegramEnv } from './job-definitions.js';
import { JobsService } from './jobs.service.js';

/**
 * Background jobs. Imported ONLY by the worker process (`src/worker.ts`), never by `AppModule`:
 * the API process schedules and runs nothing.
 *
 * `register` loads the notifications module (and with it the Telegram module, which builds the bot
 * and the sender) only when Telegram is on and a bot token exists, so with Telegram off the
 * sender is never even constructed.
 */
@Module({})
export class JobsModule {
  static register(env: TelegramEnv): DynamicModule {
    return {
      module: JobsModule,
      imports: [
        PricingModule,
        SheetsSyncModule,
        ...(isTelegramSendingEnabled(env) ? [NotificationsModule] : []),
      ],
      providers: [JobsService],
      exports: [JobsService],
    };
  }
}
