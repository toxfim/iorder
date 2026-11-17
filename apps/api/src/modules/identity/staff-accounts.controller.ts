import { Body, Controller, Get, Header, HttpCode, Param, Post, Put } from '@nestjs/common';
import { uuidSchema } from '@iorder/shared';
import {
  createStaffAccountRequestSchema,
  setStaffTelegramRequestSchema,
  type CreateStaffAccountRequest,
  type SetStaffTelegramRequest,
  type StaffAccountListResponse,
  type StaffAccountResponse,
  type StaffDirectoryResponse,
} from '@iorder/shared/staff-auth';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { toStaffAccountResponse, toStaffDirectoryEntry } from './dto/staff-auth.response.js';
import { StaffAccountsService } from './staff-accounts.service.js';

/**
 * Staff accounts: create (POST /staff/users), list, link Telegram. HTTP only; the rules (a manager
 * cannot grant or touch ADMIN) live in StaffAccountsService. Responses are never cached because
 * they describe who can sign in.
 */
@Controller('staff')
@RequirePermission('MANAGE_STAFF_ACCOUNTS')
export class StaffAccountsController {
  constructor(private readonly accounts: StaffAccountsService) {}

  @Post('users')
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createStaffAccountRequestSchema))
    body: CreateStaffAccountRequest,
  ): Promise<StaffAccountResponse> {
    return toStaffAccountResponse(await this.accounts.create(actor, body));
  }

  @Get('accounts/directory')
  @RequirePermission('VIEW_STAFF_DIRECTORY')
  @Header('Cache-Control', 'no-store')
  async directory(@CurrentActor() actor: Actor): Promise<StaffDirectoryResponse> {
    const people = await this.accounts.directory(actor);
    return { items: people.map(toStaffDirectoryEntry) };
  }

  @Get('accounts')
  @Header('Cache-Control', 'no-store')
  async list(@CurrentActor() actor: Actor): Promise<StaffAccountListResponse> {
    const accounts = await this.accounts.list(actor);
    return { items: accounts.map(toStaffAccountResponse) };
  }

  @Put('users/:id/telegram')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async setTelegram(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(setStaffTelegramRequestSchema)) body: SetStaffTelegramRequest,
  ): Promise<StaffAccountResponse> {
    return toStaffAccountResponse(await this.accounts.setTelegram(actor, id, body));
  }
}
