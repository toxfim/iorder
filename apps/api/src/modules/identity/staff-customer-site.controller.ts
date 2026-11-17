import { Body, Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import {
  customerSiteHandoffRequestSchema,
  type CustomerSiteHandoffResponse,
  type CustomerSiteResponse,
} from '@iorder/shared/staff-auth';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { StaffHandoffService } from './staff-handoff.service.js';

/**
 * Strict and empty: there is no "return to" to send (the server decides where the browser goes),
 * so a body with any field is refused. An absent body is fine.
 */
const NO_FIELDS = new ZodValidationPipe(customerSiteHandoffRequestSchema.optional());

/**
 * The dashboard side of "continue on the customer site" ([C] 2026-11-09). HTTP only; the rules
 * live in StaffHandoffService. Staff routes: a viewer session is refused here like on every
 * `/staff` route, so the handoff cannot be used from the customer site. Never cached: the answer
 * of the POST carries a one-time secret.
 */
@Controller('staff/customer-site')
@RequirePermission('OPEN_CUSTOMER_SITE')
export class StaffCustomerSiteController {
  constructor(private readonly handoffs: StaffHandoffService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  site(@CurrentActor() actor: Actor): CustomerSiteResponse {
    return { url: this.handoffs.customerSiteFor(actor) };
  }

  @Post('handoff')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async handoff(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<CustomerSiteHandoffResponse> {
    // Nothing of the body is used: it is only refused when it carries anything at all.
    NO_FIELDS.transform(body);
    const issued = await this.handoffs.issue(actor);
    return { url: issued.url, expiresAt: issued.expiresAt.toISOString() };
  }
}
