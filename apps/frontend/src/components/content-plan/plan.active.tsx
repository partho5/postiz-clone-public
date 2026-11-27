'use client';

// Content plan: the running plan. This week with its videos, what to do when something happens, the coming weeks, and the
// settings of the plan (direction, videos per week, facts) with the way to start over.
import React, { FC, useCallback } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { PLAN_OUTLINE_BUTTON } from '@gitroom/frontend/components/content-plan/plan.parts';
import { PlanDirection } from '@gitroom/frontend/components/content-plan/plan.direction';
import { PlanFactsEditor } from '@gitroom/frontend/components/content-plan/plan.facts';
import { PlanThisWeek } from '@gitroom/frontend/components/content-plan/plan.this.week';
import { PlanUpcoming } from '@gitroom/frontend/components/content-plan/plan.upcoming';
import { PlanUrgent } from '@gitroom/frontend/components/content-plan/plan.urgent';
import { PlanVideos } from '@gitroom/frontend/components/content-plan/plan.videos';
import { usePlanCurrentWeek } from '@gitroom/frontend/components/content-plan/use.plan.current.week';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import { PlanView } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// "Start over": after the owner confirms, the plan goes back to the setup. The current week stays until a new plan is
// confirmed.
const PlanStartOver: FC<{ plan: PlanView }> = ({ plan }) => {
  const t = useT();
  const { send, pending } = usePlanRequest();

  const startOver = useCallback(async () => {
    if (
      !(await deleteDialog(
        t(
          'plan_start_over_question',
          'Your current week stays until you confirm a new plan. Start over?'
        ),
        t('plan_start_over_yes', 'Yes, start over'),
        t('plan_start_over', 'Start over')
      ))
    ) {
      return;
    }
    await send('POST', '/content-plan/reset');
  }, [send, t]);

  return (
    <div className="flex">
      <Button
        loading={pending}
        disabled={pending || !!plan.busy}
        onClick={startOver}
        className={PLAN_OUTLINE_BUTTON}
      >
        {t('plan_start_over', 'Start over')}
      </Button>
    </div>
  );
};

// The page of a confirmed plan. A member who cannot change the plan sees the same, without the buttons that change it.
export const PlanActive: FC<{ plan: PlanView }> = ({ plan }) => {
  const { data: week, error } = usePlanCurrentWeek();
  const t = useT();

  return (
    <div className="flex flex-col gap-[16px]">
      {error ? (
        <div className="text-red-400">
          {t('plan_week_unavailable', 'This week could not be loaded.')}
        </div>
      ) : (
        <PlanThisWeek plan={plan} week={week} />
      )}
      {plan.canEdit && week && <PlanUrgent week={week} />}
      <PlanUpcoming plan={plan} />
      <PlanDirection plan={plan} />
      <PlanVideos plan={plan} />
      <PlanFactsEditor plan={plan} />
      {plan.canEdit && <PlanStartOver plan={plan} />}
    </div>
  );
};
