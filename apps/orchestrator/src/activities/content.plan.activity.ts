// Content plan: the activities the plan's hourly tick and its jobs run. The state lives on the plan, week and day rows,
// so every method takes one object and a field can be added to it without a new activity.
import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import {
  ContentPlanService,
  PlanJob,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';

@Injectable()
@Activity()
export class ContentPlanActivity {
  constructor(private _contentPlanService: ContentPlanService) {}

  // Advances every ACTIVE plan: leftovers carried on, the week written, the roadmap topped up.
  @ActivityMethod()
  async contentPlanTick(_input: Record<string, never>) {
    return this._contentPlanService.tick(new Date());
  }

  // Runs one job: the proposal or its revision, a week, some days or one day of a week, a replan of the roadmap, or the
  // refining of an instant idea.
  @ActivityMethod()
  async contentPlanRunJob(job: PlanJob) {
    switch (job.kind) {
      case 'proposal':
        return this._contentPlanService.buildProposal(job.id, null);
      case 'revise':
        return this._contentPlanService.buildProposal(job.id, job.feedback ?? null);
      case 'week':
        return this._contentPlanService.generateWeek(job.id);
      case 'days':
        return this._contentPlanService.regenerateDays(job.id, job.fromDate ?? '');
      case 'day':
        return this._contentPlanService.regenerateDay(job.id);
      case 'replan':
        return this._contentPlanService.replan(job.id);
      case 'instant':
        return this._contentPlanService.refineInstantIdea(job.id);
    }
  }

  // Ends a job that did not finish: the plan, week or day is free again and the owner is told it did not work.
  @ActivityMethod()
  async contentPlanJobFailed({ kind, id }: Pick<PlanJob, 'kind' | 'id'>) {
    switch (kind) {
      case 'proposal':
      case 'revise':
        return this._contentPlanService.proposalFailed(id);
      case 'week':
        return this._contentPlanService.weekFailed(id);
      case 'days':
        return this._contentPlanService.daysFailed(id);
      case 'day':
        return this._contentPlanService.dayFailed(id);
      case 'replan':
        return this._contentPlanService.replanFailed(id);
      case 'instant':
        return this._contentPlanService.instantFailed(id);
    }
  }
}
