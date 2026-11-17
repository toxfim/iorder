import {
  setSupplyPartyRequestSchema,
  supplySearchQuerySchema,
  type SetSupplyPartyRequest,
  type SetSupplyPartyResponse,
  type SupplyListResponse,
  type SupplySearchQuery,
} from '@iorder/shared/staff-cost';
import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import type { Actor } from '../../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';
import { toSupplyListResponse } from './supply-party.response.js';
import { SupplyPartyService } from './supply-party.service.js';

// STAFF-ONLY, manager only. HTTP only: validation, actor, mapping.
@Controller()
export class SupplyPartyController {
  constructor(private readonly parties: SupplyPartyService) {}

  @Get('staff/supplies')
  @RequirePermission('SET_SUPPLY_PARTY')
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(supplySearchQuerySchema)) query: SupplySearchQuery,
  ): Promise<SupplyListResponse> {
    return toSupplyListResponse(await this.parties.listSupplies(actor, query));
  }

  @Put('staff/supply-parties')
  @RequirePermission('SET_SUPPLY_PARTY')
  set(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(setSupplyPartyRequestSchema)) body: SetSupplyPartyRequest,
  ): Promise<SetSupplyPartyResponse> {
    return this.parties.setParty(actor, body);
  }
}
