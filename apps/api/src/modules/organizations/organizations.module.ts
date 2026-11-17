import { Module } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AuditModule } from '../audit/index.js';
import { IdentityModule } from '../identity/index.js';
import { OrganizationInviteSettings } from './organization-invite.settings.js';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsRepository } from './organizations.repository.js';
import { OrganizationsService } from './organizations.service.js';
import { PendingNoticeLimiter } from './pending-notice-limiter.js';

@Module({
  imports: [AuditModule, IdentityModule],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsRepository,
    OrganizationsService,
    {
      provide: PendingNoticeLimiter,
      useFactory: (env: Env): PendingNoticeLimiter =>
        new PendingNoticeLimiter(
          env.TELEGRAM_PENDING_NOTICES_PER_ADDER_PER_HOUR,
          env.TELEGRAM_PENDING_NOTICES_PER_HOUR,
        ),
      inject: [APP_ENV],
    },
    {
      provide: OrganizationInviteSettings,
      // Test apps pass a partial env: a missing value is the default.
      useFactory: (env: Partial<Env>): OrganizationInviteSettings =>
        new OrganizationInviteSettings(env.ORGANIZATION_INVITE_TTL_SECONDS),
      inject: [APP_ENV],
    },
  ],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
