import { Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import type {
  StaffNotificationLinkResponse,
  StaffNotificationStatusResponse,
} from '@iorder/shared/staff-auth';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ConflictError } from '../../common/errors/domain-errors.js';
import { StaffBotLinkService } from '../identity/index.js';
import { BotIdentity } from './bot-identity.js';

/**
 * The signed-in staff member's own bot notifications ([C] 2026-10-25): whether the bot reaches
 * them, and a one-time deep link that connects it. HTTP only; the rules live in
 * StaffBotLinkService. Never cached: a link is a one-time secret.
 */
@Controller('staff/me/notifications')
@RequirePermission('CONNECT_BOT_NOTIFICATIONS')
export class StaffNotificationsController {
  constructor(
    private readonly botLinks: StaffBotLinkService,
    private readonly bot: BotIdentity,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async status(@CurrentActor() actor: Actor): Promise<StaffNotificationStatusResponse> {
    const status = await this.botLinks.status(actor);
    return { telegramLinked: status.telegramLinked, botConnected: status.botConnected };
  }

  @Post('link')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async createLink(@CurrentActor() actor: Actor): Promise<StaffNotificationLinkResponse> {
    // Asked first: without a bot nobody could press Start, so no token is written for nothing.
    const username = await this.bot.username();
    if (username === undefined) {
      throw new ConflictError('The Telegram bot is not configured', 'BOT_NOT_CONFIGURED');
    }
    const link = await this.botLinks.createLink(actor);
    return {
      url: `https://t.me/${username}?start=${link.startPayload}`,
      expiresAt: link.expiresAt.toISOString(),
    };
  }
}
