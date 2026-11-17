import { Body, Controller, Get, Header, HttpCode, Ip, Post, Put, Headers } from '@nestjs/common';
import {
  customerCredentialsRequestSchema,
  customerHandoffRequestSchema,
  type CustomerCredentialsRequest,
  type CustomerHandoffPageResponse,
  type CustomerHandoffRequest,
} from '@iorder/shared';
import {
  passwordSignInRequestSchema,
  telegramWidgetSignInRequestSchema,
  type PasswordSignInRequest,
  type TelegramWidgetSignInRequest,
} from '@iorder/shared/staff-auth';
import type { Actor } from '../../common/auth/actor.js';
import {
  CurrentActor,
  CustomerArea,
  Public,
  RequirePermission,
} from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { Clock } from '../../common/clock/clock.js';
import { StaffAuthService } from './staff-auth.service.js';
import { StaffHandoffService } from './staff-handoff.service.js';
import { OwnContactThrottle } from './own-contact-throttle.js';

// The two sign-in doors also let a staff member in as the staff viewer ([C] 2026-11-09). The
// credential routes stay customer-only: a viewer (and any staff actor, replaced by the viewer on
// this customer-area controller) is refused by the service.
@Controller('customer/auth')
@CustomerArea()
export class CustomerAuthController {
  constructor(
    private readonly auth: StaffAuthService,
    private readonly handoffs: StaffHandoffService,
    private readonly throttle: OwnContactThrottle,
    private readonly clock: Clock,
  ) {}

  @Header('Cache-Control', 'no-store')
  @Public()
  @Post('password-login')
  @HttpCode(200)
  async password(
    @Body(new ZodValidationPipe(passwordSignInRequestSchema)) body: PasswordSignInRequest,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<{ token: string }> {
    const outcome = await this.auth.signInWithPassword(body, { ip, userAgent }, true);
    return { token: outcome.token };
  }

  @Header('Cache-Control', 'no-store')
  @Public()
  @Post('telegram-widget')
  @HttpCode(200)
  async telegram(
    @Body(new ZodValidationPipe(telegramWidgetSignInRequestSchema))
    body: TelegramWidgetSignInRequest,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<{ token: string }> {
    const outcome = await this.auth.signInWithTelegramWidget(body, { ip, userAgent }, true);
    return { token: outcome.token };
  }

  /**
   * The third way in ([C] 2026-11-09): a one-time code the dashboard gave a signed-in staff member.
   * Public like the other two, throttled like them, and it opens a viewer session only.
   */
  @Header('Cache-Control', 'no-store')
  @Public()
  @Post('handoff')
  @HttpCode(200)
  async handoff(
    @Body(new ZodValidationPipe(customerHandoffRequestSchema)) body: CustomerHandoffRequest,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<{ token: string }> {
    const outcome = await this.auth.signInWithHandoff(body.code, { ip, userAgent });
    return { token: outcome.token };
  }

  /**
   * Where this site may send a returning company employee to be handed over, or null. An address
   * from the api's configuration; nothing of the request is used and nobody is named.
   */
  @Public()
  @Get('handoff')
  handoffPage(): CustomerHandoffPageResponse {
    return { url: this.handoffs.handoffPageUrl() };
  }

  @Header('Cache-Control', 'no-store')
  @Get('credentials')
  @RequirePermission('MANAGE_OWN_CUSTOMER_LOGIN')
  getCredentials(
    @CurrentActor() actor: Actor,
  ): Promise<{ login: string | null; canEdit?: boolean }> {
    return this.auth.ownCustomerCredentials(actor);
  }

  @Header('Cache-Control', 'no-store')
  @Put('credentials')
  @RequirePermission('MANAGE_OWN_CUSTOMER_LOGIN')
  setCredentials(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(customerCredentialsRequestSchema)) body: CustomerCredentialsRequest,
  ): Promise<{ login: string | null; canEdit?: boolean }> {
    this.throttle.check(actor.userId, this.clock.now().getTime());
    return this.auth.setOwnCustomerCredentials(actor, body);
  }
}
