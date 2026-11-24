'use client';

// Content plan: the setup. The owner first tells about the business; then each round shows what the AI understood
// (one editable text), its questions, and the choice to go on or to see the plan.
import React, { FC, useCallback, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Textarea } from '@gitroom/react/form/textarea';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  PlanQuestionCard,
  PlanQuestionValue,
  initialQuestionValue,
} from '@gitroom/frontend/components/content-plan/plan.question.card';
import {
  PlanFailed,
  PlanThinking,
} from '@gitroom/frontend/components/content-plan/plan.parts';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import {
  DEFAULT_VIDEOS_PER_WEEK,
  LIMITS,
  PlanAnswer,
  PlanView,
  VIDEOS_PER_WEEK,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

type PlanRound = NonNullable<PlanView['round']>;

// The answers of a round as the server takes them: a question the owner left empty is left out.
const answersOf = (
  round: PlanRound,
  values: Record<string, PlanQuestionValue>
): PlanAnswer[] =>
  round.questions.flatMap((question) => {
    const value = values[question.id] ?? initialQuestionValue(question);
    const other = value.other.trim();
    return value.optionId || other
      ? [{ questionId: question.id, optionId: value.optionId, other: other || null }]
      : [];
  });

// The first step: one big text about the business, and the button that starts the questions.
const PlanStart: FC<{ plan: PlanView }> = ({ plan }) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const [sourceText, setSourceText] = useState(plan.sourceText ?? plan.prefill);
  const working = pending || !!plan.busy;

  const start = useCallback(() => {
    return send('POST', '/content-plan/setup/start', {
      sourceText: sourceText.trim(),
    });
  }, [send, sourceText]);

  if (!plan.canEdit) {
    return (
      <div className="text-textItemBlur">
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
      {working ? (
        <PlanThinking />
      ) : (
        <div className="flex">
          <Button
            onClick={start}
            disabled={!sourceText.trim()}
            className="min-h-[44px] w-full sm:w-auto"
          >
            {t('plan_start', 'Start')}
          </Button>
        </div>
      )}
    </div>
  );
};

// One round: what the AI understood, its questions, the videos per week, and the two ways on.
const PlanRoundForm: FC<{ plan: PlanView; round: PlanRound }> = ({
  plan,
  round,
}) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  // after a plan that could not be written, the direction the owner sent is the newest text
  const [direction, setDirection] = useState(
    plan.notice === 'proposal_failed' && plan.direction
      ? plan.direction
      : round.direction
  );
  const [videosPerWeek, setVideosPerWeek] = useState<number>(
    plan.videosPerWeek || DEFAULT_VIDEOS_PER_WEEK
  );
  const [values, setValues] = useState<Record<string, PlanQuestionValue>>(() =>
    Object.fromEntries(
      round.questions.map((question) => [question.id, initialQuestionValue(question)])
    )
  );
  const working = pending || !!plan.busy;
  const disabled = working || !plan.canEdit;
  const planFirst = round.readyForPlan || !round.questions.length;

  const next = useCallback(() => {
    return send('POST', '/content-plan/setup/answer', {
      roundId: round.id,
      direction: direction.trim(),
      answers: answersOf(round, values),
    });
  }, [direction, round, send, values]);

  const showPlan = useCallback(() => {
    return send('POST', '/content-plan/proposal', {
      direction: direction.trim(),
      videosPerWeek,
      answers: answersOf(round, values),
    });
  }, [direction, round, send, values, videosPerWeek]);

  return (
    <div className="flex flex-col gap-[16px]">
      {plan.notice === 'proposal_failed' && (
        <PlanFailed
          text={t(
            'plan_proposal_failed',
            'The plan could not be written. Please try again.'
          )}
        />
      )}
      <div className="flex flex-col gap-[4px]">
        <Textarea
          label={t('plan_understood', "Here's what I understood")}
          name="planDirection"
          disableForm={true}
          disabled={disabled}
          dir="auto"
          value={direction}
          maxLength={LIMITS.direction}
          className="min-h-[220px] w-full"
          onChange={(event) => setDirection(event.target.value)}
        />
        <div className="text-textItemBlur text-[13px]">
          {t('plan_understood_note', "Edit anything that's not right")}
        </div>
      </div>

      {round.questions.map((question) => (
        <PlanQuestionCard
          key={question.id}
          question={question}
          value={values[question.id] ?? initialQuestionValue(question)}
          disabled={disabled}
          onChange={(value) =>
            setValues((held) => ({ ...held, [question.id]: value }))
          }
        />
      ))}

      <div className="flex flex-col gap-[6px]">
        <div className="text-[14px]">
          {t('plan_videos_per_week', 'Videos per week')}
        </div>
        <select
          value={videosPerWeek}
          disabled={disabled}
          aria-label={t('plan_videos_per_week', 'Videos per week')}
          onChange={(event) => setVideosPerWeek(Number(event.target.value))}
          className="bg-newBgColorInner h-[44px] border border-newTableBorder rounded-[8px] px-[10px] text-[14px] text-textColor w-full sm:w-[120px]"
        >
          {VIDEOS_PER_WEEK.map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
        <div className="text-textItemBlur text-[13px]">
          {t(
            'plan_videos_per_week_help',
            'How many videos can you make a week? You can change this later; it applies from the next week.'
          )}
        </div>
      </div>

      {working && <PlanThinking />}
      {plan.canEdit && (
        <div className="flex flex-col sm:flex-row gap-[12px]">
          <Button
            secondary={planFirst}
            disabled={working || !direction.trim()}
            onClick={next}
            className="min-h-[44px] w-full sm:w-auto"
          >
            {t('plan_continue', 'Continue')}
          </Button>
          <Button
            secondary={!planFirst}
            disabled={working || !direction.trim()}
            onClick={showPlan}
            className="min-h-[44px] w-full sm:w-auto"
          >
            {t('plan_show_plan', 'Show me the plan')}
          </Button>
        </div>
      )}
    </div>
  );
};

// The setup page: the first text, or the newest round (a new round starts a new form).
export const PlanSetup: FC<{ plan: PlanView }> = ({ plan }) => {
  return plan.round ? (
    <PlanRoundForm key={plan.round.id} plan={plan} round={plan.round} />
  ) : (
    <PlanStart plan={plan} />
  );
};
