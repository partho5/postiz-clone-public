// Content plan: reads and writes a workspace's plan, the rounds of its setup, its themes and clusters and its weeks.
// Every query that takes an id of a row below the plan also filters by the plan, which belongs to one workspace.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ChatTurn } from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import { addDays } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import {
  PlanAnswer,
  PlanBeat,
  PlanCarryItem,
  PlanOutlineItem,
  PlanProposal,
  PlanQuestion,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// A round of the setup as `saveRound` stores it.
export interface NewPlanRound {
  planId: string;
  index: number;
  direction: string;
  questions: PlanQuestion[];
  readyForPlan: boolean;
  userTurn: string;
  assistantTurn: string;
}

// What the proposal job saves once the plan is written.
export interface SavedProposal {
  proposal: PlanProposal;
  proposalVersion: number;
  proposalTurns: ChatTurn[];
}

// What confirming a proposal writes: themes and clusters with the ids made by the caller, and the 12 weeks.
export interface NewActivePlan {
  planId: string;
  // weeks of the old plan that are not generated yet and start on or after this date are removed
  removeIdleFrom: string;
  themes: { id: string; name: string; description: string; position: number }[];
  clusters: {
    id: string;
    themeId: string;
    title: string;
    problem: string;
    rotationIndex: number;
  }[];
  weeks: {
    id: string;
    clusterId: string;
    weekStart: string;
    idea: string;
    outline: PlanOutlineItem[] | null;
  }[];
  facts: Prisma.InputJsonValue;
}

// One written video of a week: the day it is on, its angle and its script.
export interface WrittenDay {
  dayIndex: number;
  date: string;
  angle: string;
  title: string;
  why: string;
  beats: PlanBeat[];
  closingLine: string;
}

// What the weekly engine saves when it has written a week: its days, and its brief unless the owner edited it.
export interface GeneratedWeek {
  weekId: string;
  organizationId: string;
  days: WrittenDay[];
  brief: string | null;
}

// A video that was written again (a regenerated day): the same row, a new script.
export interface RewrittenDay {
  id: string;
  angle: string;
  title: string;
  why: string;
  beats: PlanBeat[];
  closingLine: string;
}

// The refined script of an instant idea.
export interface RefinedInstantIdea {
  title: string;
  why: string;
  beats: PlanBeat[];
  closingLine: string;
}

// A new week of the roadmap: its cluster and its idea.
export interface NewPlanWeek {
  id: string;
  clusterId: string;
  weekStart: string;
  idea: string;
}

@Injectable()
export class ContentPlanRepository {
  // Receives the Prisma repositories for the plan, its rounds, themes, clusters, weeks, days and instant ideas, and the
  // transaction.
  constructor(
    private _plan: PrismaRepository<'contentPlan'>,
    private _round: PrismaRepository<'contentPlanRound'>,
    private _theme: PrismaRepository<'planTheme'>,
    private _cluster: PrismaRepository<'planCluster'>,
    private _week: PrismaRepository<'planWeek'>,
    private _day: PrismaRepository<'planDay'>,
    private _instant: PrismaRepository<'planInstantIdea'>,
    private _transaction: PrismaTransaction
  ) {}

  // The plan of a workspace, or null when it has none.
  findByOrganization(organizationId: string) {
    return this._plan.model.contentPlan.findUnique({
      where: { organizationId },
    });
  }

  // A plan with the brand columns the AI calls are made from (for the jobs, which know only the plan id).
  findWithOrganization(planId: string) {
    return this._plan.model.contentPlan.findUnique({
      where: { id: planId },
      include: {
        organization: {
          select: { id: true, name: true, locale: true, timezone: true },
        },
      },
    });
  }

  // The plan of a workspace; one is made (status SETUP) when it has none.
  ensure(organizationId: string) {
    return this._plan.model.contentPlan.upsert({
      where: { organizationId },
      create: { organizationId },
      update: {},
    });
  }

  // Writes the given fields of a plan.
  update(planId: string, data: Prisma.ContentPlanUncheckedUpdateInput) {
    return this._plan.model.contentPlan.update({
      where: { id: planId },
      data,
    });
  }

  // Marks the plan as busy with a job; false when another job already holds it.
  async claimBusy(planId: string, busy: string) {
    const { count } = await this._plan.model.contentPlan.updateMany({
      where: { id: planId, busy: null },
      data: { busy },
    });
    return count === 1;
  }

  // Marks the plan as not busy, with any other fields the end of the job changes.
  release(planId: string, data: Prisma.ContentPlanUncheckedUpdateInput = {}) {
    return this.update(planId, { ...data, busy: null });
  }

  // Back to a fresh setup: the rounds are deleted, the proposal and its chat cleared. The weeks stay.
  resetSetup(planId: string, extra: Prisma.ContentPlanUncheckedUpdateInput = {}) {
    return this._transaction.model.$transaction([
      this._round.model.contentPlanRound.deleteMany({ where: { planId } }),
      this._plan.model.contentPlan.update({
        where: { id: planId },
        data: {
          ...extra,
          status: 'SETUP',
          proposal: Prisma.DbNull,
          proposalTurns: Prisma.DbNull,
          notice: null,
        },
      }),
    ]);
  }

  // The rounds of the setup, first to last.
  rounds(planId: string) {
    return this._round.model.contentPlanRound.findMany({
      where: { planId },
      orderBy: { index: 'asc' },
    });
  }

  // Takes the setup back to the round at `index`: the rounds after it are removed and a proposal written from them is
  // dropped, so that round is the latest again.
  rewindTo(planId: string, index: number) {
    return this._transaction.model.$transaction([
      this._round.model.contentPlanRound.deleteMany({
        where: { planId, index: { gt: index } },
      }),
      this._plan.model.contentPlan.update({
        where: { id: planId },
        data: {
          status: 'SETUP',
          proposal: Prisma.DbNull,
          proposalTurns: Prisma.DbNull,
          notice: null,
        },
      }),
    ]);
  }

  // The latest round of the setup, or null.
  latestRound(planId: string) {
    return this._round.model.contentPlanRound.findFirst({
      where: { planId },
      orderBy: { index: 'desc' },
    });
  }

  // Saves a round and makes its direction the plan's, in one write.
  saveRound(round: NewPlanRound) {
    return this._transaction.model.$transaction([
      this._round.model.contentPlanRound.create({
        data: {
          planId: round.planId,
          index: round.index,
          direction: round.direction,
          questions: round.questions as unknown as Prisma.InputJsonValue,
          readyForPlan: round.readyForPlan,
          userTurn: round.userTurn,
          assistantTurn: round.assistantTurn,
        },
      }),
      this._plan.model.contentPlan.update({
        where: { id: round.planId },
        data: { direction: round.direction },
      }),
    ]);
  }

  // Stores the owner's answers on a round of the plan.
  saveAnswers(planId: string, roundId: string, answers: PlanAnswer[]) {
    return this._round.model.contentPlanRound.updateMany({
      where: { id: roundId, planId },
      data: { answers: answers as unknown as Prisma.InputJsonValue },
    });
  }

  // The themes of the plan that are not archived, in order.
  activeThemes(planId: string) {
    return this._theme.model.planTheme.findMany({
      where: { planId, archivedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true, name: true },
    });
  }

  // The week of the plan that is already written or being written (not IDEA) and covers `today`; null when there is
  // none.
  currentWrittenWeek(planId: string, today: string, earliestStart: string) {
    return this._week.model.planWeek.findFirst({
      where: {
        planId,
        weekStart: { lte: today, gte: earliestStart },
        status: { not: 'IDEA' },
      },
      orderBy: { weekStart: 'desc' },
      select: { id: true, weekStart: true },
    });
  }

  // Saves the written proposal and moves the plan to PROPOSED, but only while the proposal job still holds the plan (a
  // reset in the meantime clears it, and the late answer is dropped). Returns whether it was saved.
  async saveProposal(planId: string, saved: SavedProposal) {
    const { count } = await this._plan.model.contentPlan.updateMany({
      where: { id: planId, busy: 'proposal' },
      data: {
        status: 'PROPOSED',
        proposal: saved.proposal as unknown as Prisma.InputJsonValue,
        proposalVersion: saved.proposalVersion,
        proposalTurns: saved.proposalTurns as unknown as Prisma.InputJsonValue,
        busy: null,
        notice: null,
      },
    });
    return count === 1;
  }

  // Makes the proposal the plan, in one transaction: the old themes and clusters are archived, the new ones and the
  // weeks are written, the weeks of the old plan that were not written yet are removed, and the plan is ACTIVE.
  activate(data: NewActivePlan) {
    const { planId } = data;
    return this._transaction.model.$transaction([
      this._cluster.model.planCluster.updateMany({
        where: { planId, archivedAt: null },
        data: { archivedAt: new Date() },
      }),
      this._theme.model.planTheme.updateMany({
        where: { planId, archivedAt: null },
        data: { archivedAt: new Date() },
      }),
      this._week.model.planWeek.deleteMany({
        where: {
          planId,
          status: 'IDEA',
          weekStart: { gte: data.removeIdleFrom },
        },
      }),
      this._theme.model.planTheme.createMany({
        data: data.themes.map((theme) => ({ ...theme, planId })),
      }),
      this._cluster.model.planCluster.createMany({
        data: data.clusters.map((cluster) => ({ ...cluster, planId })),
      }),
      this._week.model.planWeek.createMany({
        data: data.weeks.map((week) => ({
          id: week.id,
          planId,
          clusterId: week.clusterId,
          weekStart: week.weekStart,
          idea: week.idea,
          outline: week.outline
            ? (week.outline as unknown as Prisma.InputJsonValue)
            : undefined,
        })),
      }),
      this._plan.model.contentPlan.update({
        where: { id: planId },
        data: {
          status: 'ACTIVE',
          confirmedAt: new Date(),
          proposal: Prisma.DbNull,
          proposalTurns: Prisma.DbNull,
          facts: data.facts,
          busy: null,
          notice: null,
        },
      }),
    ]);
  }

  // The ACTIVE plans after the one with id `afterId` (null starts from the first), `take` at a time, with the brand
  // columns the weekly engine writes from.
  activePlans(afterId: string | null, take: number) {
    return this._plan.model.contentPlan.findMany({
      where: { status: 'ACTIVE', ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' },
      take,
      include: {
        organization: {
          select: { id: true, name: true, locale: true, timezone: true },
        },
      },
    });
  }

  // The week of the plan whose first day is between the two dates (the week that contains a date), or null.
  currentWeek(planId: string, earliestStart: string, latestStart: string) {
    return this._week.model.planWeek.findFirst({
      where: { planId, weekStart: { gte: earliestStart, lte: latestStart } },
      orderBy: { weekStart: 'desc' },
    });
  }

  // What tells whether the week that contains today changed, without reading it: the week, and for its days and for the
  // instant ideas in its range the newest `updatedAt` and the row count (a deleted row changes the count). Null when the
  // plan has no such week.
  async weekChange(
    planId: string,
    organizationId: string,
    earliestStart: string,
    latestStart: string
  ) {
    const week = await this._week.model.planWeek.findFirst({
      where: { planId, weekStart: { gte: earliestStart, lte: latestStart } },
      orderBy: { weekStart: 'desc' },
      select: { id: true, weekStart: true, status: true, updatedAt: true },
    });
    if (!week) {
      return null;
    }
    const [days, instant] = await Promise.all([
      this._day.model.planDay.aggregate({
        where: { weekId: week.id },
        _max: { updatedAt: true },
        _count: { _all: true },
      }),
      this._instant.model.planInstantIdea.aggregate({
        where: {
          organizationId,
          status: { not: 'DRAFT' },
          date: { gte: week.weekStart, lte: addDays(week.weekStart, 6) },
        },
        _max: { updatedAt: true },
        _count: { _all: true },
      }),
    ]);
    return {
      week,
      daysUpdatedAt: days._max.updatedAt,
      dayCount: days._count._all,
      instantUpdatedAt: instant._max.updatedAt,
      instantCount: instant._count._all,
    };
  }

  // The earliest week of the plan (its weeks are counted from it).
  firstWeek(planId: string) {
    return this._week.model.planWeek.findFirst({
      where: { planId },
      orderBy: { weekStart: 'asc' },
      select: { weekStart: true },
    });
  }

  // The latest week of the plan, which the roadmap grows from.
  lastWeek(planId: string) {
    return this._week.model.planWeek.findFirst({
      where: { planId },
      orderBy: { weekStart: 'desc' },
      select: { weekStart: true, clusterId: true },
    });
  }

  // How many weeks of the plan start on or after a date.
  countWeeksFrom(planId: string, weekStart: string) {
    return this._week.model.planWeek.count({
      where: { planId, weekStart: { gte: weekStart } },
    });
  }

  // The weeks that were written and have ended (they started on or before `lastStart`) and still hold planned days,
  // earliest first, with those days in day order.
  endedWeeksWithPlannedDays(planId: string, lastStart: string) {
    return this._week.model.planWeek.findMany({
      where: {
        planId,
        status: 'READY',
        weekStart: { lte: lastStart },
        days: { some: { status: 'PLANNED' } },
      },
      orderBy: { weekStart: 'asc' },
      include: {
        days: { where: { status: 'PLANNED' }, orderBy: { dayIndex: 'asc' } },
      },
    });
  }

  // The first week that is not written yet and starts on or after a date, which takes the leftovers of a week.
  firstIdeaWeekFrom(planId: string, weekStart: string) {
    return this._week.model.planWeek.findFirst({
      where: { planId, status: 'IDEA', weekStart: { gte: weekStart } },
      orderBy: { weekStart: 'asc' },
    });
  }

  // Closes an ended week: its planned days become MISSED, and the week that takes the leftovers gets its `carryIn`.
  closeWeek(missedDayIds: string[], carry: { weekId: string; items: PlanCarryItem[] } | null) {
    return this._transaction.model.$transaction([
      this._day.model.planDay.updateMany({
        where: { id: { in: missedDayIds }, status: 'PLANNED' },
        data: { status: 'MISSED' },
      }),
      ...(carry
        ? [
            this._week.model.planWeek.update({
              where: { id: carry.weekId },
              data: {
                carryIn: carry.items.length
                  ? (carry.items as unknown as Prisma.InputJsonValue)
                  : Prisma.DbNull,
              },
            }),
          ]
        : []),
    ]);
  }

  // The clusters of the plan that are not archived, in rotation order.
  activeClusters(planId: string) {
    return this._cluster.model.planCluster.findMany({
      where: { planId, archivedAt: null },
      orderBy: { rotationIndex: 'asc' },
      select: { id: true, title: true, problem: true },
    });
  }

  // The ideas of a cluster's latest weeks that start before a date, newest first.
  recentIdeas(planId: string, clusterId: string, before: string, take: number) {
    return this._week.model.planWeek.findMany({
      where: { planId, clusterId, weekStart: { lt: before } },
      orderBy: { weekStart: 'desc' },
      take,
      select: { idea: true },
    });
  }

  // Adds weeks to the roadmap; a week that already starts on the same day is left as it is.
  createWeeks(planId: string, weeks: NewPlanWeek[]) {
    return this._week.model.planWeek.createMany({
      data: weeks.map((week) => ({ ...week, planId })),
      skipDuplicates: true,
    });
  }

  // A week with the plan (and its brand), its cluster and its days, for the jobs that write it.
  weekForWrite(weekId: string) {
    return this._week.model.planWeek.findUnique({
      where: { id: weekId },
      include: {
        cluster: true,
        days: { orderBy: { dayIndex: 'asc' } },
        plan: {
          include: {
            organization: {
              select: { id: true, name: true, locale: true, timezone: true },
            },
          },
        },
      },
    });
  }

  // A day with its week (its cluster and all its days) and the plan, for the job that writes it again.
  dayForWrite(dayId: string) {
    return this._day.model.planDay.findUnique({
      where: { id: dayId },
      include: {
        week: {
          include: {
            cluster: true,
            days: { orderBy: { dayIndex: 'asc' } },
            plan: {
              include: {
                organization: {
                  select: { id: true, name: true, locale: true, timezone: true },
                },
              },
            },
          },
        },
      },
    });
  }

  // Writes the given fields of a week.
  updateWeek(weekId: string, data: Prisma.PlanWeekUncheckedUpdateInput) {
    return this._week.model.planWeek.update({ where: { id: weekId }, data });
  }

  // A week that was being written and did not finish is FAILED.
  failWeek(weekId: string) {
    return this._week.model.planWeek.updateMany({
      where: { id: weekId, status: 'GENERATING' },
      data: { status: 'FAILED' },
    });
  }

  // What the angles of a cluster were used for: its videos that were recorded or are still planned from the current
  // week on, and the weeks from the current one on (whose `carryIn` items count as used too). The week being written is
  // left out.
  async angleUses(
    planId: string,
    clusterId: string,
    exceptWeekId: string,
    currentStart: string
  ) {
    const [days, weeks] = await Promise.all([
      this._day.model.planDay.findMany({
        where: {
          week: { planId, clusterId, id: { not: exceptWeekId } },
          OR: [
            { status: 'RECORDED' },
            { status: 'PLANNED', week: { weekStart: { gte: currentStart } } },
          ],
        },
        select: { angle: true, date: true },
      }),
      this._week.model.planWeek.findMany({
        where: { planId, id: { not: exceptWeekId }, weekStart: { gte: currentStart } },
        select: { weekStart: true, carryIn: true },
      }),
    ]);
    return { days, weeks };
  }

  // Saves a written week: its days (a day that exists is written again, one that is no longer a slot and still planned
  // is removed) and the week as READY, with its brief when given.
  saveGeneratedWeek(data: GeneratedWeek) {
    const { weekId, organizationId } = data;
    return this._transaction.model.$transaction([
      this._day.model.planDay.deleteMany({
        where: {
          weekId,
          status: 'PLANNED',
          dayIndex: { notIn: data.days.map((day) => day.dayIndex) },
        },
      }),
      ...data.days.map((day) => {
        const fields = {
          date: day.date,
          angle: day.angle,
          title: day.title,
          why: day.why,
          beats: day.beats as unknown as Prisma.InputJsonValue,
          closingLine: day.closingLine,
        };
        return this._day.model.planDay.upsert({
          where: { weekId_dayIndex: { weekId, dayIndex: day.dayIndex } },
          create: { ...fields, weekId, organizationId, dayIndex: day.dayIndex, version: 1 },
          update: {
            ...fields,
            status: 'PLANNED',
            busy: false,
            version: { increment: 1 },
          },
        });
      }),
      this._week.model.planWeek.update({
        where: { id: weekId },
        data: {
          status: 'READY',
          generatedAt: new Date(),
          version: { increment: 1 },
          ...(data.brief ? { brief: data.brief } : {}),
        },
      }),
    ]);
  }

  // Marks planned days as being written again.
  holdDays(dayIds: string[]) {
    return this._day.model.planDay.updateMany({
      where: { id: { in: dayIds }, status: 'PLANNED' },
      data: { busy: true },
    });
  }

  // Frees days that were being written again.
  releaseDays(dayIds: string[]) {
    return this._day.model.planDay.updateMany({
      where: { id: { in: dayIds } },
      data: { busy: false },
    });
  }

  // Frees every day of a week that was being written again.
  releaseWeekDays(weekId: string) {
    return this._day.model.planDay.updateMany({
      where: { weekId, busy: true },
      data: { busy: false },
    });
  }

  // Saves videos that were written again: only a day that is still planned is changed, and it is free again. The
  // week's brief is saved when given.
  saveRewrittenDays(days: RewrittenDay[], brief: { weekId: string; text: string } | null) {
    return this._transaction.model.$transaction([
      ...days.map((day) =>
        this._day.model.planDay.updateMany({
          where: { id: day.id, status: 'PLANNED' },
          data: {
            angle: day.angle,
            title: day.title,
            why: day.why,
            beats: day.beats as unknown as Prisma.InputJsonValue,
            closingLine: day.closingLine,
            busy: false,
            version: { increment: 1 },
          },
        })
      ),
      ...(brief
        ? [
            this._week.model.planWeek.update({
              where: { id: brief.weekId },
              data: { brief: brief.text },
            }),
          ]
        : []),
    ]);
  }

  // The weeks that start on or after a date, are not written yet and whose idea the owner did not edit.
  replanWeeks(planId: string, from: string) {
    return this._week.model.planWeek.findMany({
      where: { planId, status: 'IDEA', ideaEdited: false, weekStart: { gte: from } },
      orderBy: { weekStart: 'asc' },
      include: { cluster: { select: { title: true, problem: true } } },
    });
  }

  // Saves new ideas; the outline written for an old idea is cleared.
  saveIdeas(items: { id: string; idea: string }[]) {
    return this._transaction.model.$transaction(
      items.map((item) =>
        this._week.model.planWeek.update({
          where: { id: item.id },
          data: { idea: item.idea, outline: Prisma.DbNull },
        })
      )
    );
  }

  // The week of the plan whose first day is between the two dates (the week that contains a date), with its days in day
  // order, or null.
  currentWeekWithDays(planId: string, earliestStart: string, latestStart: string) {
    return this._week.model.planWeek.findFirst({
      where: { planId, weekStart: { gte: earliestStart, lte: latestStart } },
      orderBy: { weekStart: 'desc' },
      include: { days: { orderBy: { dayIndex: 'asc' } } },
    });
  }

  // The weeks that start on or after a date, earliest first, with the name of their theme (for the list of coming weeks).
  upcomingWeeks(planId: string, from: string, take: number) {
    return this._week.model.planWeek.findMany({
      where: { planId, weekStart: { gte: from } },
      orderBy: { weekStart: 'asc' },
      take,
      include: { cluster: { select: { theme: { select: { name: true } } } } },
    });
  }

  // A week of the workspace's plan with its days and the name of its theme, or null (also for a week of another workspace).
  weekOfOrganization(organizationId: string, weekId: string) {
    return this._week.model.planWeek.findFirst({
      where: { id: weekId, plan: { organizationId } },
      include: {
        days: { orderBy: { dayIndex: 'asc' } },
        cluster: { select: { theme: { select: { name: true } } } },
      },
    });
  }

  // A day of the workspace, or null (also for a day of another workspace).
  dayOfOrganization(organizationId: string, dayId: string) {
    return this._day.model.planDay.findFirst({
      where: { id: dayId, organizationId },
    });
  }

  // Saves the owner's brief of a week.
  saveBrief(weekId: string, brief: string) {
    return this._week.model.planWeek.update({
      where: { id: weekId },
      data: { brief, briefEdited: true },
    });
  }

  // Saves the owner's idea of a week; the outline written for the old idea is cleared.
  saveIdea(weekId: string, idea: string) {
    return this._week.model.planWeek.update({
      where: { id: weekId },
      data: { idea, ideaEdited: true, outline: Prisma.DbNull },
      include: { cluster: { select: { theme: { select: { name: true } } } } },
    });
  }

  // Saves the urgent note of the current week (its brief is written again from it) and, in the same write, the leftovers
  // the note displaces for the week that takes them.
  saveUrgent(weekId: string, note: string, carry: { weekId: string; items: PlanCarryItem[] } | null) {
    return this._transaction.model.$transaction([
      this._week.model.planWeek.update({
        where: { id: weekId },
        data: { urgentNote: note, briefEdited: false },
      }),
      ...(carry
        ? [
            this._week.model.planWeek.update({
              where: { id: carry.weekId },
              data: {
                carryIn: carry.items.length
                  ? (carry.items as unknown as Prisma.InputJsonValue)
                  : Prisma.DbNull,
              },
            }),
          ]
        : []),
    ]);
  }

  // Marks a day as recorded (and free, so a rewrite that was still running cannot leave it busy); a day that already is
  // recorded is left as it is.
  markRecorded(organizationId: string, dayId: string, recordedAt: Date) {
    return this._day.model.planDay.updateMany({
      where: { id: dayId, organizationId, status: { not: 'RECORDED' } },
      data: {
        status: 'RECORDED',
        busy: false,
        recordedAt,
        version: { increment: 1 },
      },
    });
  }

  // Saves the number of videos a week gets. The outlines of the weeks not written yet were made for the old number, so
  // they are cleared; a written week keeps its days.
  saveVideosPerWeek(planId: string, videosPerWeek: number) {
    return this._transaction.model.$transaction([
      this._plan.model.contentPlan.update({
        where: { id: planId },
        data: { videosPerWeek },
      }),
      this._week.model.planWeek.updateMany({
        where: { planId, status: 'IDEA' },
        data: { outline: Prisma.DbNull },
      }),
    ]);
  }

  // The workspace's open instant idea (a DRAFT, refined or not), or null.
  openDraft(organizationId: string) {
    return this._instant.model.planInstantIdea.findFirst({
      where: { organizationId, status: 'DRAFT' },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Starts an instant idea: the workspace's open draft is replaced by a new one with an empty title (it is refined by a
  // job).
  async createDraft(planId: string, organizationId: string, idea: string, date: string) {
    const [, draft] = await this._transaction.model.$transaction([
      this._instant.model.planInstantIdea.deleteMany({
        where: { organizationId, status: 'DRAFT' },
      }),
      this._instant.model.planInstantIdea.create({
        data: { planId, organizationId, idea, date, title: '', why: '', beats: [], closingLine: '' },
      }),
    ]);
    return draft;
  }

  // An instant idea with its plan (and its brand), for the job that refines it.
  instantForWrite(id: string) {
    return this._instant.model.planInstantIdea.findUnique({
      where: { id },
      include: {
        plan: {
          include: {
            organization: {
              select: { id: true, name: true, locale: true, timezone: true },
            },
          },
        },
      },
    });
  }

  // An instant idea of the workspace, or null (also for one of another workspace).
  getInstantIdea(organizationId: string, id: string) {
    return this._instant.model.planInstantIdea.findFirst({
      where: { id, organizationId },
    });
  }

  // Saves the refined script on a draft that is still open (one that was replaced meanwhile is left alone). Returns
  // whether it was saved.
  async saveRefined(organizationId: string, id: string, refined: RefinedInstantIdea) {
    const { count } = await this._instant.model.planInstantIdea.updateMany({
      where: { id, organizationId, status: 'DRAFT' },
      data: {
        title: refined.title,
        why: refined.why,
        beats: refined.beats as unknown as Prisma.InputJsonValue,
        closingLine: refined.closingLine,
      },
    });
    return count === 1;
  }

  // Adds a refined draft to the plan; a draft that is not refined yet (empty title) or not a draft is left as it is.
  // Returns whether it was added.
  async confirm(organizationId: string, id: string) {
    const { count } = await this._instant.model.planInstantIdea.updateMany({
      where: { id, organizationId, status: 'DRAFT', title: { not: '' } },
      data: { status: 'PLANNED' },
    });
    return count === 1;
  }

  // Marks an instant idea as recorded; one that is recorded already (or still a draft) is left as it is.
  markInstantRecorded(organizationId: string, id: string, recordedAt: Date) {
    return this._instant.model.planInstantIdea.updateMany({
      where: { id, organizationId, status: { in: ['PLANNED', 'MISSED'] } },
      data: { status: 'RECORDED', recordedAt },
    });
  }

  // The instant ideas of the workspace dated between the two dates (both included) that were added to the plan, by
  // date.
  instantIdeasBetween(organizationId: string, from: string, to: string) {
    return this._instant.model.planInstantIdea.findMany({
      where: { organizationId, status: { not: 'DRAFT' }, date: { gte: from, lte: to } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
  }

  // Adds the videos of a confirmed video-set session to the plan as planned instant ideas, one per video on its date, all
  // linked to the session, in one write.
  createSessionVideos(
    planId: string,
    organizationId: string,
    sessionId: string,
    idea: string,
    videos: { date: string; title: string; why: string; beats: Prisma.InputJsonValue; closingLine: string }[]
  ) {
    return this._instant.model.planInstantIdea.createMany({
      data: videos.map((video) => ({
        planId,
        organizationId,
        sessionId,
        idea,
        status: 'PLANNED',
        ...video,
      })),
    });
  }

  // Removes the drafts that were never added and are older than a moment.
  purgeStaleDrafts(olderThan: Date) {
    return this._instant.model.planInstantIdea.deleteMany({
      where: { status: 'DRAFT', createdAt: { lt: olderThan } },
    });
  }
}

// A plan with the brand columns the AI calls are made from.
export type PlanWithOrganization = NonNullable<
  Awaited<ReturnType<ContentPlanRepository['findWithOrganization']>>
>;

// A week with its plan, cluster and days.
export type WeekForWrite = NonNullable<
  Awaited<ReturnType<ContentPlanRepository['weekForWrite']>>
>;

// A day with its week and the plan.
export type DayForWrite = NonNullable<
  Awaited<ReturnType<ContentPlanRepository['dayForWrite']>>
>;
