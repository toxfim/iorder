import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/index.js';
import { OrganizationsModule } from '../organizations/index.js';
import { OrdersModule } from '../orders/index.js';
import { PricingModule } from '../pricing/index.js';
import { TelegramModule } from '../telegram/index.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import { OutboxRepository } from './outbox.repository.js';

/** Delivers the outbox to Telegram. Scheduled only by the worker's `outbox-dispatch` job (off by default). */
@Module({
  imports: [IdentityModule, OrganizationsModule, OrdersModule, PricingModule, TelegramModule],
  providers: [OutboxRepository, OutboxDispatcher],
  exports: [OutboxDispatcher],
})
export class NotificationsModule {}
