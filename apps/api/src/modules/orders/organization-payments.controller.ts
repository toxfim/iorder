import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { uuidSchema, type CustomerBalanceResponse } from '@iorder/shared';
import {
  correctPaymentRequestSchema,
  recordPaymentRequestSchema,
  voidPaymentRequestSchema,
  type CorrectPaymentRequest,
  type OrganizationBalanceResponse,
  type RecordPaymentRequest,
  type VoidPaymentRequest,
} from '@iorder/shared/staff-orders';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, CustomerArea, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import {
  toCustomerBalanceResponse,
  toOrganizationBalanceResponse,
} from './dto/organization-balance.response.js';
import { CustomerAudienceGuard } from './order-audience.guard.js';
import { OrganizationPaymentsService } from './organization-payments.service.js';

const idPipe = new ZodValidationPipe(uuidSchema);

// HTTP only: validation, actor, mapping. The rules live in OrganizationPaymentsService.
@Controller('staff')
export class StaffOrganizationPaymentsController {
  constructor(private readonly payments: OrganizationPaymentsService) {}

  @Get('organizations/:id/balance')
  @RequirePermission('VIEW_ORGANIZATION_BALANCE')
  @Header('Cache-Control', 'no-store')
  async getBalance(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<OrganizationBalanceResponse> {
    return toOrganizationBalanceResponse(await this.payments.getBalance(actor, id));
  }

  @Post('organizations/:id/payments')
  @RequirePermission('RECORD_ORGANIZATION_PAYMENT')
  async recordPayment(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(recordPaymentRequestSchema)) body: RecordPaymentRequest,
  ): Promise<OrganizationBalanceResponse> {
    return toOrganizationBalanceResponse(await this.payments.recordPayment(actor, id, body));
  }

  @Patch('organization-payments/:id')
  @RequirePermission('CORRECT_ORGANIZATION_PAYMENT')
  @HttpCode(200)
  async correctPayment(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(correctPaymentRequestSchema)) body: CorrectPaymentRequest,
  ): Promise<OrganizationBalanceResponse> {
    return toOrganizationBalanceResponse(await this.payments.correctPayment(actor, id, body));
  }

  @Post('organization-payments/:id/void')
  @RequirePermission('CORRECT_ORGANIZATION_PAYMENT')
  @HttpCode(200)
  async voidPayment(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(voidPaymentRequestSchema)) body: VoidPaymentRequest,
  ): Promise<OrganizationBalanceResponse> {
    return toOrganizationBalanceResponse(await this.payments.voidPayment(actor, id, body));
  }
}

// The customer's own organization: only the amount due. A staff viewer has none: zero.
@Controller('me/balance')
@CustomerArea()
@UseGuards(CustomerAudienceGuard)
@RequirePermission('VIEW_OWN_BALANCE')
export class CustomerBalanceController {
  constructor(private readonly payments: OrganizationPaymentsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async getBalance(@CurrentActor() actor: Actor): Promise<CustomerBalanceResponse> {
    return toCustomerBalanceResponse(await this.payments.getOwnAmountDue(actor));
  }
}
