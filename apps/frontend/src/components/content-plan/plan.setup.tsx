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
  PlanQuestionCard,
  PlanQuestionValue,
  initialQuestionValue,
} from '@gitroom/frontend/components/content-plan/plan.question.card';
import {
  PLAN_OUTLINE_BUTTON,
  PLAN_PRIMARY_BUTTON,
  PlanBackButton,
  PlanChangeNote,
  PlanFailed,
  PlanThinking,
} from '@gitroom/frontend/components/content-plan/plan.parts';
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

// Where a step can go: back to the step before it, and on to the step after it when there is one already.
export interface PlanStepNav {
  back?: () => void;
  next?: () => void;
}

// The answers of a round as the server takes them: a question the owner left empty is left out. A question that takes
// one option sends it as `optionId`, one that takes several sends `optionIds`.
const answersOf = (
  round: PlanRoundView,
  values: Record<string, PlanQuestionValue>
): PlanAnswer[] =>
  round.questions.flatMap((question) => {
    const value = values[question.id] ?? initialQuestionValue(question);
    const other = value.other.trim();
    return value.optionIds.length || other
      ? [
          {
            questionId: question.id,
            optionId: question.multiple ? null : value.optionIds[0] ?? null,
            optionIds: question.multiple ? value.optionIds : [],
            other: other || null,
          },
        ]
      : [];
  });

// What the owner chose on a round, as the form holds it: the saved answers, or for a round not answered yet the
// recommended options.
const valuesOf = (round: PlanRoundView) =>
  Object.fromEntries(
    round.questions.map((question): [string, PlanQuestionValue] => {
      if (!round.answers) {
        return [question.id, initialQuestionValue(question)];
      }
      const saved = round.answers.find((answer) => answer.questionId === question.id);
      return [
        question.id,
        {
          optionIds: saved?.optionIds?.length
            ? saved.optionIds
            : saved?.optionId
            ? [saved.optionId]
            : [],
          other: saved?.other ?? '',
        },
      ];
    })
  );

// The choices of a round in one comparable text, so "did the owner change anything" is a string comparison.
const choicesKey = (
  round: PlanRoundView,
  values: Record<string, PlanQuestionValue>
) =>
  JSON.stringify(
    round.questions.map((question) => {
      const value = values[question.id] ?? { optionIds: [], other: '' };
      return [question.id, [...value.optionIds].sort(), value.other.trim()];
    })
  );

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

// One round: what the AI understood, its questions, the videos per week (on the last round), and the ways on. A round
// gone back to shows its saved answers; "Continue" goes on to the next step as it is, unless the owner changed
// something, which asks the AI again from this round.
export const PlanRoundStep: FC<{
  plan: PlanView;
  round: PlanRoundView;
  nav: PlanStepNav;
}> = ({ plan, round, nav }) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const { mutate } = useSWRConfig();
  const isLatest = round.id === plan.round?.id;
  const [direction, setDirection] = useState(round.direction);
  const [videosPerWeek, setVideosPerWeek] = useState<number>(
    plan.videosPerWeek || DEFAULT_VIDEOS_PER_WEEK
  );
  const [values, setValues] = useState<Record<string, PlanQuestionValue>>(() =>
    valuesOf(round)
  );
  const [writingPlan, setWritingPlan] = useState(false);
  const working = pending || !!plan.busy;
  const disabled = working || !plan.canEdit;
  const planFirst = isLatest && (round.readyForPlan || !round.questions.length);
  // the answers or the text changed (the next questions change), or only the videos per week (only the plan changes)
  const changed =
    direction.trim() !== round.direction.trim() ||
    choicesKey(round, values) !== choicesKey(round, valuesOf(round));
  const planChanged =
    changed || (isLatest && videosPerWeek !== plan.videosPerWeek);

  const next = useCallback(async () => {
    setWritingPlan(false);
    if (
      !(await send('POST', '/content-plan/setup/answer', {
        roundId: round.id,
        direction: direction.trim(),
        answers: answersOf(round, values),
      }))
    ) {
      await mutate(CONTENT_PLAN_KEY);
    }
  }, [direction, mutate, round, send, values]);

  const showPlan = useCallback(async () => {
    setWritingPlan(true);
    const answer = await send('POST', '/content-plan/proposal', {
      direction: direction.trim(),
      videosPerWeek,
      answers: answersOf(round, values),
    });
    if (answer) {
      nav.next?.();
    }
  }, [direction, nav, round, send, values, videosPerWeek]);

  // Nothing changed and the next step exists: go on to it as it is.
  const goOn = !changed && nav.next ? nav.next : next;
  const planReady = !planChanged && !!nav.next && isLatest ? nav.next : showPlan;
  const note =
    planChanged && nav.next
      ? isLatest
        ? t('plan_change_plan', 'If you change this, your plan will change.')
        : t(
            'plan_change_next_questions',
            'If you change this, the next questions will change.'
          )
      : null;

  return (
    <div className="flex flex-col gap-[24px]">
      {plan.notice === 'proposal_failed' && isLatest && (
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
          name={`planDirection${round.index}`}
          disableForm={true}
          disabled={disabled}
          dir="auto"
          value={direction}
          maxLength={LIMITS.direction}
          className="min-h-[220px] w-full"
          onChange={(event) => setDirection(event.target.value)}
        />
        <div className="text-newTextColor/60 text-[15px]">
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

      {isLatest && (
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
      )}

      {note && <PlanChangeNote text={note} />}
      {working && (
        <PlanThinking
          kind={writingPlan || plan.busy === 'proposal' ? 'proposal' : 'round'}
        />
      )}
      {plan.canEdit && !working && (
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-[12px]">
          {nav.back ? <PlanBackButton onClick={nav.back} /> : <span />}
          <div className="flex flex-col sm:flex-row gap-[12px]">
            <Button
              disabled={!direction.trim()}
              onClick={goOn}
              className={planFirst ? PLAN_OUTLINE_BUTTON : PLAN_PRIMARY_BUTTON}
            >
              {t('plan_continue', 'Continue')}
            </Button>
            {isLatest && (
              <Button
                disabled={!direction.trim()}
                onClick={planReady}
                className={planFirst ? PLAN_PRIMARY_BUTTON : PLAN_OUTLINE_BUTTON}
              >
                {t('plan_show_plan', 'Show me the plan')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
