'use client';

// Content plan: the setup steps. The owner first tells about the business; then each round shows what the AI understood
// (one editable text), its questions, and the choice to go on or to see the plan. Every step can be gone back to: it
// shows what was entered, and changing it changes the steps after it.
import React, { FC, useCallback, useState } from 'react';
import { useSWRConfig } from 'swr';
import { Button } from '@gitroom/react/form/button';
import { Textarea } from '@gitroom/react/form/textarea';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  PLAN_PRIMARY_BUTTON,
  PlanChangeNote,
  PlanFailed,
  PlanThinking,
} from '@gitroom/frontend/components/content-plan/plan.parts';
import { PlanRoundForm } from '@gitroom/frontend/components/content-plan/plan.round.form';
import { PlanStepNav } from '@gitroom/frontend/components/content-plan/plan.steps';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import { CONTENT_PLAN_KEY } from '@gitroom/frontend/components/content-plan/use.content.plan';
import {
  DEFAULT_VIDEOS_PER_WEEK,
  LIMITS,
  PlanAnswer,
  PlanRoundView,
  PlanView,
  VIDEOS_PER_WEEK,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The first step: one big text about the business, and the button that starts the questions. Gone back to, it shows the
// text and goes on without asking again when nothing changed.
export const PlanStartStep: FC<{ plan: PlanView; nav: PlanStepNav }> = ({
  plan,
  nav,
}) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const { mutate } = useSWRConfig();
  const [sourceText, setSourceText] = useState(plan.sourceText ?? plan.prefill);
  const working = pending || !!plan.busy;
  const started = plan.rounds.length > 0;
  const changed = started && sourceText.trim() !== (plan.sourceText ?? '').trim();

  const start = useCallback(async () => {
    if (!(await send('POST', '/content-plan/setup/start', {
      sourceText: sourceText.trim(),
    }))) {
      await mutate(CONTENT_PLAN_KEY);
    }
  }, [mutate, send, sourceText]);

  if (!plan.canEdit) {
    return (
      <div className="text-newTextColor/70">
        {t(
          'plan_setup_read_only',
          'There is no content plan yet. Ask an admin to set it up.'
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[12px]">
      <Textarea
        label={t('plan_tell_business', 'Tell me about your business')}
        name="planSourceText"
        disableForm={true}
        disabled={working}
        dir="auto"
        value={sourceText}
        maxLength={LIMITS.sourceText}
        className="min-h-[220px] w-full"
        onChange={(event) => setSourceText(event.target.value)}
      />
      {changed && (
        <PlanChangeNote
          text={t(
            'plan_change_next_questions',
            'If you change this, the next questions will change.'
          )}
        />
      )}
      {working ? (
        <PlanThinking kind="start" />
      ) : (
        <div className="flex">
          <Button
            onClick={!started || changed ? start : nav.next}
            disabled={!sourceText.trim()}
            className={PLAN_PRIMARY_BUTTON}
          >
            {started && !changed
              ? t('plan_continue', 'Continue')
              : t('plan_start', 'Start')}
            <span aria-hidden="true" className="ms-[8px] inline-block rtl:rotate-180">
              →
            </span>
          </Button>
        </div>
      )}
    </div>
  );
};

// One round: what the AI understood, its questions, the videos per week (on the last round), and the ways on. The round
// itself is the shared `PlanRoundForm`; this adds what only the setup has: the videos per week and the calls it makes.
export const PlanRoundStep: FC<{
  plan: PlanView;
  round: PlanRoundView;
  nav: PlanStepNav;
}> = ({ plan, round, nav }) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const { mutate } = useSWRConfig();
  const isLatest = round.id === plan.round?.id;
  const [videosPerWeek, setVideosPerWeek] = useState<number>(
    plan.videosPerWeek || DEFAULT_VIDEOS_PER_WEEK
  );
  const [writingPlan, setWritingPlan] = useState(false);
  const working = pending || !!plan.busy;
  const disabled = working || !plan.canEdit;

  const next = useCallback(
    async (direction: string, answers: PlanAnswer[]) => {
      setWritingPlan(false);
      if (
        !(await send('POST', '/content-plan/setup/answer', {
          roundId: round.id,
          direction,
          answers,
        }))
      ) {
        await mutate(CONTENT_PLAN_KEY);
      }
    },
    [mutate, round.id, send]
  );

  const showPlan = useCallback(
    async (direction: string, answers: PlanAnswer[]) => {
      setWritingPlan(true);
      const answer = await send('POST', '/content-plan/proposal', {
        direction,
        videosPerWeek,
        answers,
      });
      if (answer) {
        nav.next?.();
      }
    },
    [nav, send, videosPerWeek]
  );

  return (
    <PlanRoundForm
      round={round}
      summary={round.direction}
      summaryName={`planDirection${round.index}`}
      summaryMax={LIMITS.direction}
      resultLabel={t('plan_show_plan', 'Show me the plan')}
      isLatest={isLatest}
      canEdit={plan.canEdit}
      busy={working}
      nav={nav}
      onContinue={next}
      onResult={showPlan}
      extrasChanged={videosPerWeek !== plan.videosPerWeek}
      failure={
        plan.notice === 'proposal_failed' && isLatest ? (
          <PlanFailed
            text={t(
              'plan_proposal_failed',
              'The plan could not be written. Please try again.'
            )}
          />
        ) : null
      }
      extras={
        isLatest && (
          <div className="flex flex-col gap-[6px]">
            <div className="text-[17px] font-[600]">
              {t('plan_videos_per_week', 'Videos per week')}
            </div>
            <select
              value={videosPerWeek}
              disabled={disabled}
              aria-label={t('plan_videos_per_week', 'Videos per week')}
              onChange={(event) => setVideosPerWeek(Number(event.target.value))}
              className="bg-newBgColorInner h-[56px] border-2 border-newTextColor/15 rounded-[14px] px-[14px] text-[17px] text-textColor w-full sm:w-[160px] focus:border-btnPrimary outline-none"
            >
              {VIDEOS_PER_WEEK.map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
            <div className="text-newTextColor/60 text-[15px]">
              {t(
                'plan_videos_per_week_help',
                'How many videos can you make a week? You can change this later; it applies from the next week.'
              )}
            </div>
          </div>
        )
      }
      thinking={
        <PlanThinking
          kind={writingPlan || plan.busy === 'proposal' ? 'proposal' : 'round'}
        />
      }
    />
  );
};
