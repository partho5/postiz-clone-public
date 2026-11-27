'use client';

// Content plan: the steps before the plan runs (the business text, each round of questions, the proposal) as one flow.
// A bar shows where the owner is, every step can be gone back to, and moving between steps slides. All steps stay
// mounted (the others hidden), so what was typed in a step is still there when the owner comes back to it.
import React, { FC, useMemo } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { PlanPreview } from '@gitroom/frontend/components/content-plan/plan.preview';
import {
  PlanRoundStep,
  PlanStartStep,
} from '@gitroom/frontend/components/content-plan/plan.setup';
import {
  PlanStep,
  PlanSteps,
} from '@gitroom/frontend/components/content-plan/plan.steps';
import { PlanView } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The flow before the plan runs, drawn with the shared steps: the business text, each round of questions, the proposal.
// The step the AI has reached is the "front"; the owner moves with Previous, Continue or the bar.
export const PlanWizard: FC<{ plan: PlanView }> = ({ plan }) => {
  const t = useT();
  const hasPlanStep = plan.status === 'PROPOSED' || plan.busy === 'proposal';
  const steps = useMemo<PlanStep[]>(
    () => [
      { key: 'business', label: t('plan_step_business', 'Your business') },
      ...plan.rounds.map((round, index) => ({
        key: round.id,
        label: t('plan_step_questions', {
          defaultValue: 'Question Set {{number}}',
          number: index + 1,
        }),
      })),
      ...(hasPlanStep
        ? [{ key: 'plan', label: t('plan_step_plan', 'Your plan') }]
        : []),
    ],
    [hasPlanStep, plan.rounds, t]
  );
  return (
    <PlanSteps
      steps={steps}
      upcoming={hasPlanStep ? null : t('plan_step_plan', 'Your plan')}
      disabled={!!plan.busy}
      renderStep={(step, nav) => {
        const round = plan.rounds.find((item) => item.id === step.key);
        return step.key === 'business' ? (
          <PlanStartStep plan={plan} nav={nav} />
        ) : step.key === 'plan' ? (
          <PlanPreview plan={plan} onBack={nav.back} />
        ) : round ? (
          <PlanRoundStep plan={plan} round={round} nav={nav} />
        ) : null;
      }}
    />
  );
};
