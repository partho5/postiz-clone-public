'use client';

// Content plan: one round of questions as any planning session draws it. It shows what the AI understood (one editable
// text), its questions with the recommended answers ticked, and the ways on: Continue (ask again, or go on to the next
// step when nothing changed) and the button that asks for the result. It holds what the owner chose and builds the
// answers the server takes; the page around it sends them.
import React, { FC, useState } from 'react';
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
} from '@gitroom/frontend/components/content-plan/plan.parts';
import { PlanStepNav } from '@gitroom/frontend/components/content-plan/plan.steps';
import {
  PlanAnswer,
  PlanQuestion,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// What the form needs of a round; the setup's `PlanRoundView` and a session's `PlanSessionRoundView` both fit (the text
// of what the AI understood is passed as `summary`, because the two name it differently).
export interface PlanQuestionRound {
  id: string;
  index: number;
  questions: PlanQuestion[];
  answers: PlanAnswer[] | null;
  readyForPlan: boolean;
}

// The answers of a round as the server takes them: a question the owner left empty is left out. A question that takes
// one option sends it as `optionId`, one that takes several sends `optionIds`.
export const answersOf = (
  round: PlanQuestionRound,
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
const valuesOf = (round: PlanQuestionRound) =>
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
  round: PlanQuestionRound,
  values: Record<string, PlanQuestionValue>
) =>
  JSON.stringify(
    round.questions.map((question) => {
      const value = values[question.id] ?? { optionIds: [], other: '' };
      return [question.id, [...value.optionIds].sort(), value.other.trim()];
    })
  );

// One round. A round gone back to shows its saved answers; "Continue" goes on to the next step as it is, unless the
// owner changed something, which calls `onContinue` to ask the AI again from this round. The other button
// (`resultLabel`, only on the latest round) calls `onResult`, or goes on as it is when nothing changed. `extras` are
// fields of the page drawn after the questions (`extrasChanged`: one of them changed, which changes only the result),
// `failure` a line above the round and `thinking` the waiting line shown while `busy`.
export const PlanRoundForm: FC<{
  round: PlanQuestionRound;
  summary: string;
  summaryLabel?: string;
  summaryName: string;
  summaryMax: number;
  resultLabel: string;
  isLatest: boolean;
  canEdit: boolean;
  busy: boolean;
  nav: PlanStepNav;
  onContinue: (summary: string, answers: PlanAnswer[]) => void | Promise<void>;
  onResult: (summary: string, answers: PlanAnswer[]) => void | Promise<void>;
  extras?: React.ReactNode;
  extrasChanged?: boolean;
  failure?: React.ReactNode;
  thinking?: React.ReactNode;
}> = ({
  round,
  summary: saved,
  summaryLabel,
  summaryName,
  summaryMax,
  resultLabel,
  isLatest,
  canEdit,
  busy,
  nav,
  onContinue,
  onResult,
  extras,
  extrasChanged,
  failure,
  thinking,
}) => {
  const t = useT();
  const [summary, setSummary] = useState(saved);
  const [values, setValues] = useState<Record<string, PlanQuestionValue>>(() =>
    valuesOf(round)
  );
  const disabled = busy || !canEdit;
  const resultFirst = isLatest && (round.readyForPlan || !round.questions.length);
  // the answers or the text changed (the next questions change), or only an extra field (only the result changes)
  const changed =
    summary.trim() !== saved.trim() ||
    choicesKey(round, values) !== choicesKey(round, valuesOf(round));
  const resultChanged = changed || (isLatest && !!extrasChanged);

  // Nothing changed and the next step exists: go on to it as it is.
  const goOn =
    !changed && nav.next
      ? nav.next
      : () => onContinue(summary.trim(), answersOf(round, values));
  const resultReady =
    !resultChanged && !!nav.next && isLatest
      ? nav.next
      : () => onResult(summary.trim(), answersOf(round, values));
  const note =
    resultChanged && nav.next
      ? isLatest
        ? t('plan_change_plan', 'If you change this, your plan will change.')
        : t(
            'plan_change_next_questions',
            'If you change this, the next questions will change.'
          )
      : null;

  return (
    <div className="flex flex-col gap-[24px]">
      {failure}
      <div className="flex flex-col gap-[4px]">
        <Textarea
          label={summaryLabel ?? t('plan_understood', "Here's what I understood")}
          name={summaryName}
          disableForm={true}
          disabled={disabled}
          dir="auto"
          value={summary}
          maxLength={summaryMax}
          className="min-h-[220px] w-full"
          onChange={(event) => setSummary(event.target.value)}
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

      {extras}

      {note && <PlanChangeNote text={note} />}
      {busy && thinking}
      {canEdit && !busy && (
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-[12px]">
          {nav.back ? <PlanBackButton onClick={nav.back} /> : <span />}
          <div className="flex flex-col sm:flex-row gap-[12px]">
            <Button
              disabled={!summary.trim()}
              onClick={goOn}
              className={resultFirst ? PLAN_OUTLINE_BUTTON : PLAN_PRIMARY_BUTTON}
            >
              {t('plan_continue', 'Continue')}
            </Button>
            {isLatest && (
              <Button
                disabled={!summary.trim()}
                onClick={resultReady}
                className={resultFirst ? PLAN_PRIMARY_BUTTON : PLAN_OUTLINE_BUTTON}
              >
                {resultLabel}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
