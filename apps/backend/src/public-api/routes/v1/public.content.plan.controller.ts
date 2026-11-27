// Content plan, phone side: the public routes the app uses to show this week's videos and to report that one was recorded.
import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as Sentry from '@sentry/nestjs';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import {
  ContentPlanService,
  PlanOrganization,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import { PhoneWeekStamp, PhoneWeekView } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';
import { RequireScope } from '@gitroom/backend/services/auth/scopes/require.scope';
import { ScopeGuard } from '@gitroom/backend/services/auth/scopes/scope.guard';
import { FeatureGuard } from '@gitroom/backend/services/auth/scopes/feature.guard';

// `/public/v1/content-plan`: any member's device may read the week and report a recording (no role check).
@ApiTags('Public API')
@Controller('/public/v1')
@UseGuards(ScopeGuard, FeatureGuard)
export class PublicContentPlanController {
  // Receives the service that owns the content plan.
  constructor(private _contentPlanService: ContentPlanService) {}

  // The week that contains today: its status, and its videos once it is written.
  @Get('/content-plan/week')
  @RequireScope('posts:read')
  week(@GetOrgFromRequest() org: PlanOrganization): Promise<PhoneWeekView> {
    Sentry.metrics.count('public_api-request', 1);
    return this._contentPlanService.phoneWeek(org);
  }

  // A cheap value that changes whenever `/content-plan/week` would answer something else, so the phone fetches the week
  // only then. Still 200 with a stable value when the brand has no plan or week.
  @Get('/content-plan/week/stamp')
  @RequireScope('posts:read')
  weekStamp(@GetOrgFromRequest() org: PlanOrganization): Promise<PhoneWeekStamp> {
    Sentry.metrics.count('public_api-request', 1);
    return this._contentPlanService.weekStamp(org);
  }

  // The owner recorded this video; answers the same 200 when it was recorded already, 404 for another workspace's.
  @Post('/content-plan/days/:id/recorded')
  @HttpCode(200)
  @RequireScope('posts:write')
  async recorded(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const day = await this._contentPlanService.recorded(org, id);
    return { id: day.id, status: day.status };
  }
}
