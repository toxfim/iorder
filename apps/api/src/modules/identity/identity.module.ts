import { Logger, Module } from '@nestjs/common';
import { ActorResolver } from '../../common/auth/actor-resolver.js';
import { staffOrderingOrganizationOf } from '../../common/auth/staff-viewer.js';
import { Clock } from '../../common/clock/clock.js';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AuditModule } from '../audit/index.js';
import { TelegramInitDataVerifier } from '../telegram/init-data-verifier.js';
import { PasswordHasher } from './password-hasher.js';
import { OwnContactThrottle } from './own-contact-throttle.js';
import { StaffWriteThrottle } from './staff-write-throttle.js';
import { AnonymousFailureAggregator, SignInThrottle, UsedProofs } from './sign-in-guards.js';
import { CustomerAuthController } from './customer-auth.controller.js';
import { AuthController } from './auth.controller.js';
import { ApiTokenRepository } from './api-token.repository.js';
import { ApiTokenService } from './api-token.service.js';
import {
  ApiTokenActorResolver,
  SchemeRoutingActorResolver,
  SessionActorResolver,
} from './session-actor.resolver.js';
import { LOGIN_WIDGET_VERIFIER, STAFF_LOGIN_WIDGET_VERIFIER } from './staff-auth.tokens.js';
import { resolveStaffAuthSettings } from './staff-auth.settings.js';
import { TelegramLoginWidgetVerifier } from '../telegram/login-widget-verifier.js';
import { StaffAccountsController } from './staff-accounts.controller.js';
import { OwnStaffProfileController } from './own-staff-profile.controller.js';
import { StaffAccountsService } from './staff-accounts.service.js';
import { StaffBotLinkRepository } from './staff-bot-link.repository.js';
import { StaffBotLinkService } from './staff-bot-link.service.js';
import { StaffCustomerSiteController } from './staff-customer-site.controller.js';
import { StaffHandoffRepository } from './staff-handoff.repository.js';
import { HandoffIssueThrottle, StaffHandoffService } from './staff-handoff.service.js';
import { StaffAuthRepository } from './staff-auth.repository.js';
import { StaffAuthService } from './staff-auth.service.js';
import { StaffSessionService } from './staff-session.service.js';
import { IdentityRepository } from './identity.repository.js';
import { IdentityService } from './identity.service.js';
import {
  MeController,
  StaffDriversController,
  StaffPeopleController,
  StaffUsersController,
} from './identity.controller.js';
import { TelegramActorResolver } from './telegram-actor.resolver.js';

/**
 * The Telegram (Mini App init data) resolver exists ONLY when a bot token is configured; without
 * one it is null and every `tma` request is unauthenticated. There is no flag that skips
 * verification. The app-wide resolver (below) wraps it together with the staff website sessions.
 *
 * With STAFF_MINI_APP_BOT_TOKEN (off by default) staff actors are bound to that bot: see
 * TelegramActorResolver. Without it BOT_TOKEN's bot signs both Mini Apps, as before.
 */
export function createActorResolver(
  env: Pick<Env, 'BOT_TOKEN'> &
    Partial<
      Pick<
        Env,
        | 'TELEGRAM_INIT_DATA_MAX_AGE_SECONDS'
        | 'STAFF_MINI_APP_BOT_TOKEN'
        | 'STAFF_ORDERING_ORGANIZATION_ID'
      >
    >,
  clock: Clock,
  repository: IdentityRepository,
  logger: Pick<Logger, 'warn'> = new Logger('IdentityModule'),
): ActorResolver | null {
  if (!env.BOT_TOKEN) {
    // Built once at boot, so this is one line per start. Never includes any token content.
    logger.warn('Telegram identity disabled: Mini App sign-in answers 401');
    return null;
  }
  const verifierOf = (botToken: string): TelegramInitDataVerifier =>
    new TelegramInitDataVerifier({
      botToken,
      clock,
      ...(env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS === undefined
        ? {}
        : { maxAgeSeconds: env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS }),
    });
  return new TelegramActorResolver(
    verifierOf(env.BOT_TOKEN),
    repository,
    env.STAFF_MINI_APP_BOT_TOKEN === undefined
      ? null
      : {
          staffVerifier: verifierOf(env.STAFF_MINI_APP_BOT_TOKEN),
          staffOrderingOrganizationId: staffOrderingOrganizationOf(env),
        },
  );
}

/** A Login Widget verifier for one bot, or null without a token (the widget stays closed). */
function createWidgetVerifier(
  botToken: string | undefined,
  env: Env,
  clock: Clock,
): TelegramLoginWidgetVerifier | null {
  if (botToken === undefined) return null;
  return new TelegramLoginWidgetVerifier({
    botToken,
    clock,
    maxAgeSeconds: resolveStaffAuthSettings(env).loginMaxAgeSeconds,
  });
}

@Module({
  imports: [AuditModule],
  controllers: [
    MeController,
    AuthController,
    CustomerAuthController,
    StaffUsersController,
    StaffDriversController,
    StaffPeopleController,
    StaffAccountsController,
    StaffCustomerSiteController,
    OwnStaffProfileController,
  ],
  providers: [
    IdentityRepository,
    StaffAccountsService,
    StaffBotLinkRepository,
    StaffBotLinkService,
    IdentityService,
    StaffAuthRepository,
    StaffSessionService,
    StaffAuthService,
    StaffHandoffRepository,
    StaffHandoffService,
    HandoffIssueThrottle,
    SignInThrottle,
    StaffWriteThrottle,
    OwnContactThrottle,
    UsedProofs,
    AnonymousFailureAggregator,
    ApiTokenRepository,
    ApiTokenService,
    {
      provide: LOGIN_WIDGET_VERIFIER,
      useFactory: (env: Env, clock: Clock) => createWidgetVerifier(env.BOT_TOKEN, env, clock),
      inject: [APP_ENV, Clock],
    },
    {
      // Telegram allows one widget domain per bot: the staff site may use its own bot.
      provide: STAFF_LOGIN_WIDGET_VERIFIER,
      useFactory: (env: Env, clock: Clock) =>
        createWidgetVerifier(env.STAFF_LOGIN_BOT_TOKEN ?? env.BOT_TOKEN, env, clock),
      inject: [APP_ENV, Clock],
    },
    { provide: PasswordHasher, useFactory: () => new PasswordHasher() },
    {
      provide: ActorResolver,
      useFactory: (
        env: Env,
        clock: Clock,
        repository: IdentityRepository,
        sessions: StaffSessionService,
        apiTokens: ApiTokenService,
      ) =>
        new SchemeRoutingActorResolver(
          createActorResolver(env, clock, repository),
          new SessionActorResolver(sessions),
          new ApiTokenActorResolver(apiTokens),
        ),
      inject: [APP_ENV, Clock, IdentityRepository, StaffSessionService, ApiTokenService],
    },
  ],
  exports: [
    IdentityService,
    StaffAccountsService,
    StaffBotLinkService,
    ApiTokenService,
    ActorResolver,
  ],
})
export class IdentityModule {}
