import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  assignShopOwnerRequestSchema,
  changeMemberRoleRequestSchema,
  staffOrganizationListQuerySchema,
  updateOrganizationRequestSchema,
  uuidSchema,
  type AssignShopOwnerRequest,
  type ChangeMemberRoleRequest,
  type StaffOrganizationListQuery,
  type StaffOrganizationListResponse,
  type StaffOrganizationResponse,
  type UpdateOrganizationRequest,
} from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import {
  toStaffOrganizationResponse,
  toStaffOrganizationSummary,
} from './dto/organization.response.js';
import { OrganizationsService } from './organizations.service.js';

const idPipe = new ZodValidationPipe(uuidSchema);

// HTTP only: validation, actor, mapping. Every route is staff-only (EDIT_CUSTOMERS, its reads
// VIEW_CUSTOMERS, archive/restore ARCHIVE_ORGANIZATION); there is
// no customer-facing organization endpoint in this phase, so no customer can read any
// organization's data through here.
@Controller('staff/organizations')
@RequirePermission('EDIT_CUSTOMERS')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @RequirePermission('VIEW_CUSTOMERS')
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(staffOrganizationListQuerySchema))
    query: StaffOrganizationListQuery,
  ): Promise<StaffOrganizationListResponse> {
    const rows = await this.organizations.listOrganizations(actor, query);
    return { items: rows.map((row) => toStaffOrganizationSummary(row, actor)) };
  }

  @Get(':id')
  @RequirePermission('VIEW_CUSTOMERS')
  async get(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<StaffOrganizationResponse> {
    return toStaffOrganizationResponse(await this.organizations.getOrganization(actor, id), actor);
  }

  @Patch(':id')
  @HttpCode(200)
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateOrganizationRequestSchema)) body: UpdateOrganizationRequest,
  ): Promise<StaffOrganizationResponse> {
    return toStaffOrganizationResponse(
      await this.organizations.updateOrganization(actor, id, body),
      actor,
    );
  }

  @Put(':id/shop-owner')
  async assignShopOwner(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(assignShopOwnerRequestSchema)) body: AssignShopOwnerRequest,
  ): Promise<StaffOrganizationResponse> {
    return toStaffOrganizationResponse(
      await this.organizations.assignShopOwner(actor, id, body.userId),
      actor,
    );
  }

  @Delete(':id/shop-owner')
  async removeShopOwner(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<StaffOrganizationResponse> {
    return toStaffOrganizationResponse(await this.organizations.removeShopOwner(actor, id), actor);
  }

  @Patch(':id/members/:userId')
  @HttpCode(200)
  async changeMemberRole(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Param('userId', idPipe) userId: string,
    @Body(new ZodValidationPipe(changeMemberRoleRequestSchema)) body: ChangeMemberRoleRequest,
  ): Promise<StaffOrganizationResponse> {
    return toStaffOrganizationResponse(
      await this.organizations.changeMemberRole(actor, id, userId, body.role),
      actor,
    );
  }

  /** Admin only [C, owner 2026-11-13]: "delete" = archive; the organization and its history stay. */
  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('ARCHIVE_ORGANIZATION')
  async archive(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<StaffOrganizationResponse> {
    return toStaffOrganizationResponse(
      await this.organizations.archiveOrganization(actor, id),
      actor,
    );
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermission('ARCHIVE_ORGANIZATION')
  async restore(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<StaffOrganizationResponse> {
    return toStaffOrganizationResponse(
      await this.organizations.restoreOrganization(actor, id),
      actor,
    );
  }

  @Post(':id/members/:userId/leave')
  @HttpCode(200)
  async markMemberLeft(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Param('userId', idPipe) userId: string,
  ): Promise<StaffOrganizationResponse> {
    return toStaffOrganizationResponse(
      await this.organizations.markMemberLeft(actor, id, userId),
      actor,
    );
  }
}
