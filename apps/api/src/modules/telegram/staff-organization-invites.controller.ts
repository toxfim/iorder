import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import {
  createOrganizationRequestSchema,
  uuidSchema,
  type CreateOrganizationRequest,
  type CreateOrganizationResponse,
  type StaffOrganizationInviteResponse,
} from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import {
  OrganizationsService,
  toStaffOrganizationInviteResponse,
  toStaffOrganizationResponse,
} from '../organizations/index.js';
import { BotIdentity } from './bot-identity.js';

const idPipe = new ZodValidationPipe(uuidSchema);

/**
 * The staff organization routes that hand out a bot link [C, owner 2026-11-11; link rules P]. They
 * live here, not in the organizations module, because the link needs the bot's own username (a
 * Telegram fact this module owns); the rules stay in OrganizationsService. Manager and admin
 * (EDIT_CUSTOMERS). A link is a one-time secret: never cached.
 */
@Controller('staff/organizations')
@RequirePermission('EDIT_CUSTOMERS')
export class StaffOrganizationInvitesController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly bot: BotIdentity,
  ) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createOrganizationRequestSchema)) body: CreateOrganizationRequest,
  ): Promise<CreateOrganizationResponse> {
    const { detail, invite } = await this.organizations.createOrganization(actor, body);
    return {
      organization: toStaffOrganizationResponse(detail, actor),
      invite: toStaffOrganizationInviteResponse(invite, await this.bot.username()),
    };
  }

  @Get(':id/invite')
  @Header('Cache-Control', 'no-store')
  async invite(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<StaffOrganizationInviteResponse> {
    const link = await this.organizations.getInviteLink(actor, id);
    return toStaffOrganizationInviteResponse(link, await this.bot.username());
  }

  @Post(':id/invite')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async regenerate(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<StaffOrganizationInviteResponse> {
    const link = await this.organizations.regenerateInvite(actor, id);
    return toStaffOrganizationInviteResponse(link, await this.bot.username());
  }
}
