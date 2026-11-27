'use client';

// Content plan: this week. The week's idea and its brief (the owner may edit it and write the videos again), and one
// card per video.
import React, { FC, useCallback, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Textarea } from '@gitroom/react/form/textarea';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { PlanDayCard } from '@gitroom/frontend/components/content-plan/plan.day.card';
import {
  PLAN_OUTLINE_BUTTON,
  PlanFailed,
  PlanSection,
  planWeekRange,
} from '@gitroom/frontend/components/content-plan/plan.parts';
import { CURRENT_WEEK_KEY } from '@gitroom/frontend/components/content-plan/use.plan.current.week';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import {
  LIMITS,
  PlanView,
  PlanWeekView,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The brief of the week and the button that writes the planned videos again from it. It starts again when the server's
// brief changes (the AI wrote it, or it was saved).
const PlanBrief: FC<{ week: PlanWeekView; canEdit: boolean; working: boolean }> = ({
  week,
  canEdit,
  working,
}) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const saved = week.brief ?? '';
  const [brief, setBrief] = useState(saved);
  const changed = brief.trim() !== saved.trim() && !!brief.trim();

  const regenerate = useCallback(() => {
    return send<PlanWeekView>(
      'PUT',
      `/content-plan/weeks/${week.id}/brief`,
      { brief: brief.trim() },
      { write: CURRENT_WEEK_KEY }
    );
  }, [brief, send, week.id]);

  return (
    <div className="flex flex-col gap-[8px]">
      <Textarea
        label={t('plan_week_brief', 'The brief of this week')}
        name="planBrief"
        disableForm={true}
        disabled={working || !canEdit}
        dir="auto"
        value={brief}
        maxLength={LIMITS.brief}
        className="min-h-[140px] w-full"
        onChange={(event) => setBrief(event.target.value)}
      />
      {canEdit && (
        <div className="flex">
          <Button
            loading={pending}
            disabled={working || !changed}
            onClick={regenerate}
            className={PLAN_OUTLINE_BUTTON}
          >
            {t('plan_regenerate', 'Regenerate')}
          </Button>
        </div>
      )}
    </div>
  );
};

// This week of the plan, drawn by the status of the week.
export const PlanThisWeek: FC<{
  plan: PlanView;
  week: PlanWeekView | null | undefined;
}> = ({ plan, week }) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const retry = useCallback(() => {
    if (!week) {
      return;
    }
    return send<PlanWeekView>(
      'PUT',
      `/content-plan/weeks/${week.id}/brief`,
      { brief: (week.brief ?? week.idea).slice(0, LIMITS.brief) },
      { write: CURRENT_WEEK_KEY }
    );
  }, [send, week]);

  if (!week) {
    return (
      <PlanSection title={t('plan_this_week', 'This week')}>
        <div className="text-newTextColor/70">
          {t('plan_no_week', 'No videos are planned for this week.')}
        </div>
      </PlanSection>
    );
  }

  const written = week.status === 'READY';
  const working = week.status === 'GENERATING' || week.days.some((day) => day.busy);

  return (
    <div className="flex flex-col gap-[12px]">
      <PlanSection title={t('plan_this_week', 'This week')}>
        <div className="text-newTextColor/60 text-[15px]">
          {planWeekRange(week.weekStart)}
        </div>
        <div dir="auto" className="font-[600] break-words">
          {week.idea}
        </div>
        <PlanBrief
          key={`${week.id}:${week.brief ?? ''}`}
          week={week}
          canEdit={plan.canEdit}
          working={working || pending}
        />
      </PlanSection>

      {week.status === 'FAILED' && (
        <PlanFailed
          text={t(
            'plan_week_failed',
            "This week's videos could not be written."
          )}
          loading={pending}
          onRetry={plan.canEdit ? retry : undefined}
        />
      )}
      {(week.status === 'IDEA' || week.status === 'GENERATING') && (
        <div className="text-newTextColor/70 animate-pulse" role="status">
          {t('plan_week_writing', "Writing this week's videos…")}
        </div>
      )}
      {written &&
        week.days.map((day) => (
          <PlanDayCard
            key={day.id}
            day={day}
            today={plan.today}
            canEdit={plan.canEdit}
          />
        ))}
    </div>
  );
};
