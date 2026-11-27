'use client';

// Content plan: the steps before the plan runs (the business text, each round of questions, the proposal) as one flow. The
// flow is the workspace's `plan` session of the planning engine. A bar shows where the owner is, every step can be gone back
// to, and moving between steps slides. All steps stay mounted (the others hidden), so what was typed in a step is still
// there when the owner comes back to it.
import React, { FC, useMemo, useState } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { PlanThinking } from '@gitroom/frontend/components/content-plan/plan.parts';
import { PlanPreview } from '@gitroom/frontend/components/content-plan/plan.preview';
import {
  PlanRoundStep,
  PlanStartStep,
} from '@gitroom/frontend/components/content-plan/plan.setup';
import {
  PlanStep,
  PlanSteps,
} from '@gitroom/frontend/components/content-plan/plan.steps';
import { useOpenPlanSession } from '@gitroom/frontend/components/content-plan/use.plan.open.session';
import { usePlanSession } from '@gitroom/frontend/components/content-plan/use.plan.session';
import {
  PLAN_SESSION_KIND,
  PlanView,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The flow before the plan runs, drawn with the shared steps: the business text, each round of questions, the proposal.
// The step the AI has reached is the "front"; the owner moves with Previous, Continue or the bar.
export const PlanWizard: FC<{ plan: PlanView }> = ({ plan }) => {
  const t = useT();
  const open = useOpenPlanSession(PLAN_SESSION_KIND);
  // The session the owner works on: the open one found on opening, until the owner starts one (its id is kept, so the
  // confirmed session stays in view until the page shows the running plan).
  const [picked, setPicked] = useState<string | null>(null);
  const sessionId = picked ?? open.data?.id ?? null;
  const loaded = usePlanSession(sessionId);
  const found = open.data?.id === sessionId ? open.data : undefined;
  const session = loaded.data ?? found ?? null;
  const live =
    session &&
    (session.status === 'ASKING' ||
      session.status === 'PROPOSING' ||
      session.status === 'PROPOSED')
      ? session
      : null;
  const rounds = useMemo(() => live?.rounds ?? [], [live?.rounds]);
  const hasPlanStep = live?.status === 'PROPOSED' || live?.status === 'PROPOSING';
  const busy = !!live && (!!live.busy || live.status === 'PROPOSING');
  const steps = useMemo<PlanStep[]>(
    () => [
      { key: 'business', label: t('plan_step_business', 'Your business') },
      ...rounds.map((round, index) => ({
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
    [hasPlanStep, rounds, t]
  );

  if (!live && !open.error && open.data === undefined && !picked) {
    return <PlanThinking />;
  }
  if (session?.status === 'DONE') {
    // confirmed: the page is about to show the running plan
    return <PlanThinking />;
  }

  return (
    <PlanSteps
      steps={steps}
      upcoming={hasPlanStep ? null : t('plan_step_plan', 'Your plan')}
      disabled={busy}
      renderStep={(step, nav) => {
        const round = rounds.find((item) => item.id === step.key);
        return step.key === 'business' ? (
          <PlanStartStep plan={plan} session={live} nav={nav} onStarted={setPicked} />
        ) : step.key === 'plan' && live ? (
          <PlanPreview session={live} onBack={nav.back} />
        ) : round && live ? (
          <PlanRoundStep plan={plan} session={live} round={round} nav={nav} />
        ) : null;
      }}
    />
  );
};
