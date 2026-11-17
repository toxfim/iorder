import { uuidSchema } from '@iorder/shared';
import type {
  SupplyRemovalDecisionResponse,
  SupplyRemovalListResponse,
} from '@iorder/shared/staff-cost';
import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { Actor } from '../../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';
import { IdentityService } from '../../identity/index.js';
import { toDecisionResponse, toRemovalListResponse } from './supply-removal.response.js';
import type { RemovalRequestRow } from './supply-removal.repository.js';
import { SupplyRemovalService } from './supply-removal.service.js';

const idParam = () => Param('id', new ZodValidationPipe(uuidSchema));

// STAFF-ONLY. HTTP only: validation, actor, mapping. The accountant may VIEW the pending list; only
// manager and admin decide.
@Controller()
export class SupplyRemovalController {
  constructor(
    private readonly removals: SupplyRemovalService,
    private readonly identity: IdentityService,
  ) {}

  private async decisionOf(request: RemovalRequestRow): Promise<SupplyRemovalDecisionResponse> {
    const decider = request.decidedBy;
    const names = await this.identity.findDisplayNames(decider === null ? [] : [decider]);
    return toDecisionResponse(request, decider === null ? null : (names.get(decider) ?? null));
  }

  @Get('staff/supply-removals')
  @RequirePermission('VIEW_COST_REFERENCE')
  async list(@CurrentActor() actor: Actor): Promise<SupplyRemovalListResponse> {
    return toRemovalListResponse(await this.removals.listPending(actor));
  }

  @Post('staff/supply-removals/:id/confirm')
  @RequirePermission('DECIDE_SUPPLY_REMOVAL')
  @HttpCode(200)
  async confirm(
    @CurrentActor() actor: Actor,
    @idParam() id: string,
  ): Promise<SupplyRemovalDecisionResponse> {
    return this.decisionOf(await this.removals.confirm(actor, id));
  }

  @Post('staff/supply-removals/:id/dismiss')
  @RequirePermission('DECIDE_SUPPLY_REMOVAL')
  @HttpCode(200)
  async dismiss(
    @CurrentActor() actor: Actor,
    @idParam() id: string,
  ): Promise<SupplyRemovalDecisionResponse> {
    return this.decisionOf(await this.removals.dismiss(actor, id));
  }
}
