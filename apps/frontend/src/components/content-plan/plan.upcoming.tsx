'use client';

// Content plan: the coming weeks (the weeks after this one) with their ideas. An idea can be edited until its week starts.
import React, { FC, useCallback, useEffect, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Textarea } from '@gitroom/react/form/textarea';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  PlanSection,
  PlanThinking,
  planWeekRange,
} from '@gitroom/frontend/components/content-plan/plan.parts';
import { UPCOMING_KEY, usePlanUpcoming } from '@gitroom/frontend/components/content-plan/use.plan.upcoming';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import {
  LIMITS,
  PlanUpcomingView,
  PlanView,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// One coming week: its dates and idea, with an inline edit while the owner may change it.
const PlanUpcomingWeek: FC<{
  week: PlanUpcomingView;
  editable: boolean;
}> = ({ week, editable }) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const [editing, setEditing] = useState(false);
  const [idea, setIdea] = useState(week.idea);

  const save = useCallback(async () => {
    const answer = await send<PlanUpcomingView>(
      'PUT',
      `/content-plan/weeks/${week.id}/idea`,
      { idea: idea.trim() },
      { write: null, refresh: [UPCOMING_KEY] }
    );
    if (answer) {
      setEditing(false);
    }
  }, [idea, send, week.id]);

  const cancel = useCallback(() => {
    setIdea(week.idea);
    setEditing(false);
  }, [week.idea]);

  return (
    <li className="flex flex-col gap-[6px] min-w-0">
      <span className="text-newTextColor/60 text-[15px]">
        {planWeekRange(week.weekStart)}
      </span>
      {editing ? (
        <>
          <Textarea
            label={t('plan_week_idea', 'Idea of this week')}
            name={`planIdea-${week.id}`}
            disableForm={true}
            disabled={pending}
            dir="auto"
            value={idea}
            maxLength={LIMITS.idea}
            className="min-h-[90px] w-full"
            onChange={(event) => setIdea(event.target.value)}
          />
          <div className="flex flex-col sm:flex-row gap-[12px]">
            <Button
              loading={pending}
              disabled={!idea.trim() || idea.trim() === week.idea.trim()}
              onClick={save}
              className="min-h-[44px] w-full sm:w-auto"
            >
              {t('plan_save', 'Save')}
            </Button>
            <Button
              secondary
              disabled={pending}
              onClick={cancel}
              className="min-h-[44px] w-full sm:w-auto"
            >
              {t('plan_cancel', 'Cancel')}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-start gap-[12px] justify-between">
          <span dir="auto" className="break-words min-w-0">
            {week.idea}
          </span>
          {editable && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="min-h-[44px] underline text-[14px] shrink-0"
            >
              {t('plan_edit', 'Edit')}
            </button>
          )}
        </div>
      )}
    </li>
  );
};

// The coming weeks. While the direction is being applied the list is read again as soon as the plan is free.
export const PlanUpcoming: FC<{ plan: PlanView }> = ({ plan }) => {
  const t = useT();
  const { data: weeks, mutate } = usePlanUpcoming();

  useEffect(() => {
    if (!plan.busy) {
      mutate();
    }
  }, [mutate, plan.busy, plan.notice]);

  return (
    <PlanSection title={t('plan_coming_up', 'Coming up')}>
      {plan.busy === 'replan' && <PlanThinking />}
      {!!weeks?.length && (
        <ul className="flex flex-col gap-[14px]">
          {weeks.map((week) => (
            <PlanUpcomingWeek
              key={`${week.id}:${week.idea}`}
              week={week}
              editable={
                plan.canEdit && !plan.busy && week.weekStart > plan.today
              }
            />
          ))}
        </ul>
      )}
    </PlanSection>
  );
};
