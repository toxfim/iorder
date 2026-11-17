import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  staffRoleSchema,
  staffUserListQuerySchema,
  telegramUserIdSchema,
  setOwnContactRequestSchema,
  updateUserRequestSchema,
  uuidSchema,
  type MeResponse,
  type SetOwnContactRequest,
  type StaffPersonCard,
  type StaffRole,
  type StaffUserListQuery,
  type StaffUserListResponse,
  type StaffUserResponse,
  type UpdateUserRequest,
} from '@iorder/shared';
import {
  setStaffCredentialsRequestSchema,
  type SetStaffCredentialsRequest,
  type StaffCredentialsResponse,
} from '@iorder/shared/staff-auth';
import {
  blockUserRequestSchema,
  type BlockUserRequest,
  type BlockUserResponse,
  type GroupRemovalStatusResponse,
  type StaffDriverListResponse,
} from '@iorder/shared/staff-orders';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { Clock } from '../../common/clock/clock.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { toCredentialsResponse } from './dto/staff-auth.response.js';
import {
  toMeResponse,
  toStaffDriverResponse,
  toStaffPersonCard,
  toStaffUserResponse,
} from './dto/user.response.js';
import { IdentityService } from './identity.service.js';
import { OwnContactThrottle } from './own-contact-throttle.js';
import { StaffAuthService } from './staff-auth.service.js';

const idPipe = new ZodValidationPipe(uuidSchema);
const rolePipe = new ZodValidationPipe(staffRoleSchema);

/** The caller's own summary for the web app. The id comes from the guard's actor, never the URL. */
@Controller('me')
export class MeController {
  constructor(
    private readonly identity: IdentityService,
    private readonly throttle: OwnContactThrottle,
    private readonly clock: Clock,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermission('VIEW_OWN_PROFILE')
  async me(@CurrentActor() actor: Actor): Promise<MeResponse> {
    return toMeResponse(
      actor,
      await this.identity.getOwnProfile(actor),
      await this.identity.getOwnOrganizationName(actor),
      await this.identity.getStaffViewerInfo(actor),
    );
  }

  /** A customer's own name + phone: first order, then the profile. Unverified customer input. */
  @Put('contact')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermission('SET_OWN_CONTACT')
  async setContact(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(setOwnContactRequestSchema)) body: SetOwnContactRequest,
  ): Promise<MeResponse> {
    this.throttle.check(actor.userId, this.clock.now().getTime());
    return toMeResponse(
      actor,
      await this.identity.setOwnContact(actor, body),
      await this.identity.getOwnOrganizationName(actor),
    );
  }
}

/**
 * The driver choice for releasing an order. Its own controller and permission: the warehouse
 * manager cannot read the user directory (`staff/users`, EDIT_CUSTOMERS).
 */
@Controller('staff/drivers')
@RequirePermission('LIST_DRIVERS')
export class StaffDriversController {
  constructor(private readonly identity: IdentityService) {}

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<StaffDriverListResponse> {
    const drivers = await this.identity.listActiveDrivers(actor);
    return { items: drivers.map(toStaffDriverResponse) };
  }
}

/**
 * The hover card on a person's name. Its own controller and permission: the accountant reads this
 * narrow card but not the user directory (`staff/users`, EDIT_CUSTOMERS).
 */
@Controller('staff/people')
@RequirePermission('VIEW_PERSON_CARD')
export class StaffPeopleController {
  constructor(private readonly identity: IdentityService) {}

  @Get('by-telegram/:telegramUserId')
  @RequirePermission('FIND_PERSON_BY_TELEGRAM')
  async cardByTelegram(
    @CurrentActor() actor: Actor,
    @Param('telegramUserId', new ZodValidationPipe(telegramUserIdSchema)) telegramUserId: string,
  ): Promise<StaffPersonCard> {
    return toStaffPersonCard(
      await this.identity.getPersonCardByTelegram(actor, BigInt(telegramUserId)),
      actor,
    );
  }

  @Get(':id')
  async card(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<StaffPersonCard> {
    return toStaffPersonCard(await this.identity.getPersonCard(actor, id), actor);
  }
}

// HTTP only: validation, actor, mapping. Rules (including "changing a staff member needs
// MANAGE_STAFF") live in IdentityService.
@Controller('staff/users')
@RequirePermission('EDIT_CUSTOMERS')
export class StaffUsersController {
  constructor(
    private readonly identity: IdentityService,
    private readonly auth: StaffAuthService,
  ) {}

  @Get()
  @RequirePermission('VIEW_CUSTOMERS')
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(staffUserListQuerySchema)) query: StaffUserListQuery,
  ): Promise<StaffUserListResponse> {
    const users = await this.identity.listUsers(actor, query);
    return { items: users.map((user) => toStaffUserResponse(user, actor)) };
  }

  @Get(':id')
  @RequirePermission('VIEW_CUSTOMERS')
  async get(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<StaffUserResponse> {
    return toStaffUserResponse(await this.identity.getUser(actor, id), actor);
  }

  @Patch(':id')
  @HttpCode(200)
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateUserRequestSchema)) body: UpdateUserRequest,
  ): Promise<StaffUserResponse> {
    return toStaffUserResponse(await this.identity.updateUser(actor, id, body), actor);
  }

  @Post(':id/block')
  @HttpCode(200)
  async block(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(blockUserRequestSchema)) body: BlockUserRequest,
  ): Promise<BlockUserResponse> {
    const result = await this.identity.setBlocked(actor, id, true, {
      removeFromGroups: body.removeFromGroups,
    });
    // Without the flag the answer is exactly the old one; the extra key appears only when asked.
    return result.groupRemoval.requested
      ? { ...toStaffUserResponse(result, actor), groupRemoval: result.groupRemoval }
      : toStaffUserResponse(result, actor);
  }

  /** Per Telegram group: has the bot removed this blocked person yet? Staff-only. */
  @Get(':id/removal-status')
  @RequirePermission('VIEW_CUSTOMERS')
  @Header('Cache-Control', 'no-store')
  async removalStatus(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<GroupRemovalStatusResponse> {
    return { items: await this.identity.getRemovalStatus(actor, id) };
  }

  @Post(':id/unblock')
  @HttpCode(200)
  async unblock(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<StaffUserResponse> {
    return toStaffUserResponse(await this.identity.setBlocked(actor, id, false), actor);
  }

  /** Sets or resets the website login and password. Never returns the password or its hash. */
  @Put(':id/credentials')
  @RequirePermission('MANAGE_STAFF_CREDENTIALS')
  @Header('Cache-Control', 'no-store')
  async setCredentials(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(setStaffCredentialsRequestSchema)) body: SetStaffCredentialsRequest,
  ): Promise<StaffCredentialsResponse> {
    return toCredentialsResponse(await this.auth.setCredentials(actor, id, body));
  }

  @Put(':id/roles/:role')
  @RequirePermission('MANAGE_STAFF')
  async assignRole(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Param('role', rolePipe) role: StaffRole,
  ): Promise<StaffUserResponse> {
    return toStaffUserResponse(await this.identity.assignStaffRole(actor, id, role), actor);
  }

  @Delete(':id/roles/:role')
  @RequirePermission('MANAGE_STAFF')
  async removeRole(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Param('role', rolePipe) role: StaffRole,
  ): Promise<StaffUserResponse> {
    return toStaffUserResponse(await this.identity.removeStaffRole(actor, id, role), actor);
  }
}
