// Content plan: the web routes of a brand's AI content plan: the setup rounds, the proposal and its confirmation, and
// the changes an owner makes to a running plan.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { AdminRequiredException } from '@gitroom/nestjs-libraries/database/prisma/brands/brands.service';
import {
  ContentPlanService,
  PlanOrganization,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import { ContentPlanSessionService } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.session.service';
import {
  PlanDayView,
  PlanInstantIdeaView,
  PlanSessionView,
  PlanUpcomingView,
  PlanView,
  PlanWeekView,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The `/content-plan` endpoints: read the plan, answer the setup rounds, ask for and confirm the proposal, and change a
// running plan (direction, facts, videos per week, the weeks and their videos, the owner's own ideas), and the planning
// sessions (a set of videos from the owner's idea).
@ApiTags('Content plan')
@Controller('/content-plan')
export class ContentPlanController {
  // Receives the service that owns the content plan and the one that runs its planning sessions.
  constructor(
    private _contentPlanService: ContentPlanService,
    private _contentPlanSessionService: ContentPlanSessionService
  ) {}

  // The plan of the calling workspace; status NONE when it has none.
  @Get('/')
  view(@GetOrgFromRequest() org: PlanOrganization): Promise<PlanView> {
    return this._contentPlanService.view(org);
  }

  // Starts the setup from the owner's first text and answers round 0; admins only.
  @Post('/setup/start')
  @HttpCode(200)
  startSetup(
    @GetOrgFromRequest() org: PlanOrganization,
    @Body() body: unknown
  ): Promise<PlanView> {
    this.assertAdmin(org);
    return this._contentPlanService.startSetup(org, body);
  }

  // Sends the answers and the edited direction of a round and answers the next one; admins only.
  @Post('/setup/answer')
  @HttpCode(200)
  answer(
    @GetOrgFromRequest() org: PlanOrganization,
    @Body() body: unknown
  ): Promise<PlanView> {
    this.assertAdmin(org);
    return this._contentPlanService.answer(org, body);
  }

  // Starts writing the proposal; the page polls the plan until it is PROPOSED; admins only.
  @Post('/proposal')
  @HttpCode(202)
  propose(
    @GetOrgFromRequest() org: PlanOrganization,
    @Body() body: unknown
  ): Promise<PlanView> {
    this.assertAdmin(org);
    return this._contentPlanService.propose(org, body);
  }

  // Starts writing a new proposal from the owner's feedback; admins only.
  @Post('/proposal/revise')
  @HttpCode(202)
  revise(
    @GetOrgFromRequest() org: PlanOrganization,
    @Body() body: unknown
  ): Promise<PlanView> {
    this.assertAdmin(org);
    return this._contentPlanService.revise(org, body);
  }

  // Makes the proposal the plan; admins only.
  @Post('/confirm')
  @HttpCode(200)
  confirm(
    @GetOrgFromRequest() org: PlanOrganization,
    @Body() body: unknown
  ): Promise<PlanView> {
    this.assertAdmin(org);
    return this._contentPlanService.confirm(org, body);
  }

  // Back to a fresh setup; the current week stays until a new plan is confirmed; admins only.
  @Post('/reset')
  @HttpCode(200)
  reset(@GetOrgFromRequest() org: PlanOrganization): Promise<PlanView> {
    this.assertAdmin(org);
    return this._contentPlanService.reset(org);
  }

  // Saves the facts about the business the owner edited; admins only.
  @Put('/facts')
  saveFacts(
    @GetOrgFromRequest() org: PlanOrganization,
    @Body() body: unknown
  ): Promise<PlanView> {
    this.assertAdmin(org);
    return this._contentPlanService.saveFacts(org, body);
  }

  // Saves the new Content Direction and starts writing the coming weeks' ideas again; admins only.
  @Put('/direction')
  @HttpCode(202)
  direction(
    @GetOrgFromRequest() org: PlanOrganization,
    @Body() body: unknown
  ): Promise<PlanView> {
    this.assertAdmin(org);
    return this._contentPlanService.direction(org, body);
  }

  // Saves how many videos a week gets from the next week on; admins only.
  @Put('/videos-per-week')
  videosPerWeek(
    @GetOrgFromRequest() org: PlanOrganization,
    @Body() body: unknown
  ): Promise<PlanView> {
    this.assertAdmin(org);
    return this._contentPlanService.videosPerWeek(org, body);
  }

  // The week that contains today with its videos; 204 when there is none.
  @Get('/weeks/current')
  async currentWeek(
    @GetOrgFromRequest() org: PlanOrganization,
    @Res({ passthrough: true }) res: Response
  ): Promise<PlanWeekView | undefined> {
    const week = await this._contentPlanService.currentWeek(org);
    if (!week) {
      res.status(204);
      return undefined;
    }
    return week;
  }

  // The weeks after the current one, each with its idea.
  @Get('/weeks/upcoming')
  upcoming(@GetOrgFromRequest() org: PlanOrganization): Promise<PlanUpcomingView[]> {
    return this._contentPlanService.upcoming(org);
  }

  // Saves the brief of the current week and writes its planned videos again; admins only.
  @Put('/weeks/:id/brief')
  @HttpCode(202)
  brief(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<PlanWeekView> {
    this.assertAdmin(org);
    return this._contentPlanService.brief(org, id, body);
  }

  // Saves the idea of a coming week; admins only.
  @Put('/weeks/:id/idea')
  idea(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<PlanUpcomingView> {
    this.assertAdmin(org);
    return this._contentPlanService.idea(org, id, body);
  }

  // Tells the plan about something that happened in the industry; the current week focuses on it; admins only.
  @Post('/weeks/:id/urgent')
  @HttpCode(202)
  urgent(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<PlanWeekView> {
    this.assertAdmin(org);
    return this._contentPlanService.urgent(org, id, body);
  }

  // Writes one planned video again; admins only.
  @Post('/days/:id/regenerate')
  @HttpCode(202)
  regenerate(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string
  ): Promise<PlanDayView> {
    this.assertAdmin(org);
    return this._contentPlanService.regenerate(org, id);
  }

  // Marks a video as recorded; admins only.
  @Post('/days/:id/recorded')
  @HttpCode(200)
  recorded(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string
  ): Promise<PlanDayView> {
    this.assertAdmin(org);
    return this._contentPlanService.recorded(org, id);
  }

  // Starts refining the owner's own idea into a video for a date; the page polls the plan until it shows the script;
  // admins only.
  @Post('/instant-ideas')
  @HttpCode(202)
  startInstantIdea(
    @GetOrgFromRequest() org: PlanOrganization,
    @Body() body: unknown
  ): Promise<PlanView> {
    this.assertAdmin(org);
    return this._contentPlanService.startInstantIdea(org, body);
  }

  // Adds a refined instant idea to the plan on its date; admins only.
  @Post('/instant-ideas/:id/confirm')
  @HttpCode(200)
  confirmInstantIdea(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string
  ): Promise<PlanInstantIdeaView> {
    this.assertAdmin(org);
    return this._contentPlanService.confirmInstantIdea(org, id);
  }

  // The open session of a kind (so the page can resume it), or null; any member of the workspace may read it.
  @Get('/sessions/open')
  openSession(
    @GetOrgFromRequest() org: PlanOrganization,
    @Query('kind') kind: string
  ): Promise<PlanSessionView | null> {
    return this._contentPlanSessionService.open(org, { kind });
  }

  // A session of the workspace with its current round or proposal; any member may read it.
  @Get('/sessions/:id')
  session(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string
  ): Promise<PlanSessionView> {
    return this._contentPlanSessionService.view(org, id);
  }

  // Starts a session from the owner's first text and answers its first round; admins only.
  @Post('/sessions')
  @HttpCode(200)
  startSession(
    @GetOrgFromRequest() org: PlanOrganization,
    @Body() body: unknown
  ): Promise<PlanSessionView> {
    this.assertAdmin(org);
    return this._contentPlanSessionService.start(org, body);
  }

  // Sends the answers and the edited summary of a round and answers the next one; admins only.
  @Post('/sessions/:id/answer')
  @HttpCode(200)
  answerSession(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<PlanSessionView> {
    this.assertAdmin(org);
    return this._contentPlanSessionService.answer(org, id, body);
  }

  // Starts writing the proposal; the page polls the session until it is PROPOSED; admins only.
  @Post('/sessions/:id/propose')
  @HttpCode(202)
  proposeSession(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<PlanSessionView> {
    this.assertAdmin(org);
    return this._contentPlanSessionService.propose(org, id, body);
  }

  // Starts writing a new proposal from the owner's feedback; admins only.
  @Post('/sessions/:id/revise')
  @HttpCode(202)
  reviseSession(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<PlanSessionView> {
    this.assertAdmin(org);
    return this._contentPlanSessionService.revise(org, id, body);
  }

  // Makes the proposal real, with the owner's edits, and ends the session; admins only.
  @Post('/sessions/:id/confirm')
  @HttpCode(200)
  confirmSession(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<PlanSessionView> {
    this.assertAdmin(org);
    return this._contentPlanSessionService.confirm(org, id, body);
  }

  // Ends the session without using its proposal; admins only.
  @Post('/sessions/:id/discard')
  @HttpCode(200)
  discardSession(
    @GetOrgFromRequest() org: PlanOrganization,
    @Param('id') id: string
  ): Promise<PlanSessionView> {
    this.assertAdmin(org);
    return this._contentPlanSessionService.discard(org, id);
  }

  // Refuses a member who is not an admin of the workspace; the policy guard no longer tells roles apart.
  private assertAdmin(org: PlanOrganization) {
    const role = org.users?.[0]?.role;
    if (role !== 'ADMIN' && role !== 'SUPERADMIN') {
      throw new AdminRequiredException();
    }
  }
}
