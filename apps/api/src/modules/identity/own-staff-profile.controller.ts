import { Body, Controller, Get, Header, HttpCode, Put } from '@nestjs/common';
import {
  updateOwnStaffProfileRequestSchema,
  type OwnStaffProfileResponse,
  type UpdateOwnStaffProfileRequest,
} from '@iorder/shared/staff-auth';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { Clock } from '../../common/clock/clock.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { toOwnStaffProfileResponse } from './dto/user.response.js';
import { IdentityService } from './identity.service.js';
import { OwnContactThrottle } from './own-contact-throttle.js';

/**
 * A staff member's OWN name and phone [C, 2026-11-09]. No route here takes a user id: the person
 * is the actor the guard resolved, so nobody else can be read or changed. HTTP only; the rules
 * live in IdentityService. Never cached: the answer is personal data.
 */
@Controller('staff/me/profile')
@RequirePermission('EDIT_OWN_STAFF_PROFILE')
export class OwnStaffProfileController {
  constructor(
    private readonly identity: IdentityService,
    private readonly throttle: OwnContactThrottle,
    private readonly clock: Clock,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@CurrentActor() actor: Actor): Promise<OwnStaffProfileResponse> {
    return toOwnStaffProfileResponse(await this.identity.getOwnStaffProfile(actor));
  }

  @Put()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async update(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(updateOwnStaffProfileRequestSchema))
    body: UpdateOwnStaffProfileRequest,
  ): Promise<OwnStaffProfileResponse> {
    this.throttle.check(actor.userId, this.clock.now().getTime());
    return toOwnStaffProfileResponse(await this.identity.updateOwnStaffProfile(actor, body));
  }
}
