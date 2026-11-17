import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { uuidSchema } from '@iorder/shared';
import {
  MAX_IMEI_SLOTS,
  unitCodeKindSchema,
  type PickingResponse,
  type UnitCodeKind,
} from '@iorder/shared/staff-orders';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { toPickingResponse } from './dto/picking.response.js';
import { StaffAudienceGuard } from './order-audience.guard.js';
import { PickingService } from './picking.service.js';

const idPipe = new ZodValidationPipe(uuidSchema);

// HTTP only. The body of a scan is validated in PickingService (the same schema), which also
// decides with the order's facts: 404 for an order the caller may not see, 409 when the order is
// not being picked or the code is taken.
@Controller('staff/orders/:id')
@UseGuards(StaffAudienceGuard)
export class PickingController {
  constructor(private readonly picking: PickingService) {}

  @Get('picking')
  @RequirePermission('VIEW_UNIT_CODES')
  async get(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<PickingResponse> {
    return toPickingResponse(await this.picking.getPicking(actor, id));
  }

  @Put('units/:unitId/codes')
  @HttpCode(200)
  @RequirePermission('RECORD_UNIT_CODES')
  async record(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Param('unitId', idPipe) unitId: string,
    @Body() body: unknown,
  ): Promise<PickingResponse> {
    return toPickingResponse(await this.picking.recordCode(actor, id, unitId, body));
  }

  @Delete('units/:unitId/codes/:kind/:slot')
  @HttpCode(200)
  @RequirePermission('RECORD_UNIT_CODES')
  async clear(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Param('unitId', idPipe) unitId: string,
    @Param('kind', new ZodValidationPipe(unitCodeKindSchema)) kind: UnitCodeKind,
    @Param('slot', new ZodValidationPipe(z.coerce.number().int().min(1).max(MAX_IMEI_SLOTS)))
    slot: number,
  ): Promise<PickingResponse> {
    return toPickingResponse(await this.picking.clearCode(actor, id, unitId, kind, slot));
  }
}
