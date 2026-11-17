import { Controller, Get } from '@nestjs/common';
import type { StaffDashboardSummary } from '@iorder/shared/staff-orders';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { DashboardService } from './dashboard.service.js';

// HTTP only. VIEW_ORDER is a coarse gate that every staff role holds (and customers too, who are
// then refused by the service: they have no staff dashboard).
@Controller('staff/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @RequirePermission('VIEW_ORDER')
  summary(@CurrentActor() actor: Actor): Promise<StaffDashboardSummary> {
    return this.dashboard.summarize(actor);
  }
}
