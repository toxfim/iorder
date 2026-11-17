import { Body, Controller, Get, Header, Headers, HttpCode, Ip, Post } from '@nestjs/common';
import {
  passwordSignInRequestSchema,
  telegramWidgetSignInRequestSchema,
  type PasswordSignInRequest,
  type StaffCurrentSessionResponse,
  type StaffSignInResponse,
  type TelegramWidgetSignInRequest,
} from '@iorder/shared/staff-auth';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, Public, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { toCurrentSessionResponse, toSignInResponse } from './dto/staff-auth.response.js';
import { IdentityService } from './identity.service.js';
import { StaffAuthService } from './staff-auth.service.js';

/**
 * Website sign-in for STAFF (customers use the Mini App only: a customer who signs in here gets
 * the same 401 as a wrong password). The sign-in routes are public by necessity; they are
 * throttled and answer every failure identically. Responses carrying a token are never cached.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: StaffAuthService,
    private readonly identity: IdentityService,
  ) {}

  @Public()
  @Post('telegram-widget')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async telegramWidget(
    @Body(new ZodValidationPipe(telegramWidgetSignInRequestSchema))
    body: TelegramWidgetSignInRequest,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<StaffSignInResponse> {
    return toSignInResponse(await this.auth.signInWithTelegramWidget(body, { ip, userAgent }));
  }

  @Public()
  @Post('password-login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async passwordLogin(
    @Body(new ZodValidationPipe(passwordSignInRequestSchema)) body: PasswordSignInRequest,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<StaffSignInResponse> {
    return toSignInResponse(await this.auth.signInWithPassword(body, { ip, userAgent }));
  }

  /** Who am I. Works for any authenticated caller; `session` is null unless a Bearer session was used. */
  @Get('session')
  @RequirePermission('VIEW_OWN_PROFILE')
  @Header('Cache-Control', 'no-store')
  async session(@CurrentActor() actor: Actor): Promise<StaffCurrentSessionResponse> {
    const [user, times] = await Promise.all([
      this.identity.getOwnProfile(actor),
      this.auth.currentSession(actor),
    ]);
    return toCurrentSessionResponse(actor, user, times);
  }

  @Post('logout')
  @RequirePermission('VIEW_OWN_PROFILE')
  @HttpCode(204)
  async logout(@CurrentActor() actor: Actor): Promise<void> {
    await this.auth.signOut(actor);
  }
}
