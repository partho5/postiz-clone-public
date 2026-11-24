'use client';

// Content plan: the page "Content plan". It shows the step the workspace's plan is in: the setup, the proposal to
// confirm, or the running plan.
import React, { FC } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { PlanActive } from '@gitroom/frontend/components/content-plan/plan.active';
import { PlanPreview } from '@gitroom/frontend/components/content-plan/plan.preview';
import { PlanSetup } from '@gitroom/frontend/components/content-plan/plan.setup';
import { useContentPlan } from '@gitroom/frontend/components/content-plan/use.content.plan';

// The page: the plan of the workspace, drawn by its status.
export const ContentPlanComponent: FC = () => {
  const t = useT();
  const { data: plan, error, isLoading } = useContentPlan();

  if (isLoading) {
    return <LoadingComponent />;
  }
  if (error || !plan) {
    return (
      <div className="text-red-400">
        {t('plan_unavailable', 'The content plan could not be loaded.')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[16px] max-w-[860px]">
      <div className="text-[24px] font-[600]">
        {t('plan_page_title', 'Content plan')}
      </div>
      {plan.status === 'PROPOSED' || plan.busy === 'proposal' ? (
        <PlanPreview plan={plan} />
      ) : plan.status === 'ACTIVE' ? (
        <PlanActive plan={plan} />
      ) : (
        <PlanSetup plan={plan} />
      )}
    </div>
  );
};
