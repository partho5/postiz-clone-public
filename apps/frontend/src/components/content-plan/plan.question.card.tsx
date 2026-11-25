'use client';

// Content plan: one question of a setup round with its options, the recommended ones pre-ticked, and an "Other" box.
// A question takes one option (a circle) or several (a square); the tick is an icon, the real input stays for keyboards
// and screen readers.
import React, { FC } from 'react';
import clsx from 'clsx';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  LIMITS,
  PlanQuestion,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// What the owner chose for a question: options, and/or their own words.
export interface PlanQuestionValue {
  optionIds: string[];
  other: string;
}

// The options the AI recommends; a round stored before several answers were allowed recommends one.
const recommendedOf = (question: PlanQuestion) =>
  question.recommendedOptionIds ?? [question.recommendedOptionId];

// The value a question starts with: its recommended options ticked.
export const initialQuestionValue = (
  question: PlanQuestion
): PlanQuestionValue => ({
  optionIds: recommendedOf(question),
  other: '',
});

// A question card. For a question that takes one, typing in "Other" un-selects the options and choosing an option
// clears "Other"; for one that takes several, "Other" adds to the ticks.
export const PlanQuestionCard: FC<{
  question: PlanQuestion;
  value: PlanQuestionValue;
  disabled: boolean;
  onChange: (value: PlanQuestionValue) => void;
}> = ({ question, value, disabled, onChange }) => {
  const t = useT();
  const multiple = !!question.multiple;
  const recommended = recommendedOf(question);
  const choose = (optionId: string) => {
    if (!multiple) {
      onChange({ optionIds: [optionId], other: '' });
      return;
    }
    onChange({
      ...value,
      optionIds: value.optionIds.includes(optionId)
        ? value.optionIds.filter((id) => id !== optionId)
        : [...value.optionIds, optionId],
    });
  };
  return (
    <fieldset
      disabled={disabled}
      className="flex flex-col gap-[10px] bg-newBgColorInner rounded-[12px] p-[16px] border border-newTextColor/20 min-w-0"
    >
      <legend className="sr-only">{question.text}</legend>
      <div aria-hidden="true" dir="auto" className="font-[600] text-[16px] break-words">
        {question.text}
      </div>
      {multiple && (
        <div className="text-newTextColor/70 text-[13px] -mt-[6px]">
          {t('plan_choose_all', 'Choose all that apply')}
        </div>
      )}
      {question.options.map((option) => {
        const selected = value.optionIds.includes(option.id);
        return (
          <label
            key={option.id}
            className={clsx(
              'flex items-center gap-[12px] cursor-pointer rounded-[10px] border p-[10px] min-h-[48px] transition-colors',
              selected
                ? 'border-btnPrimary bg-btnPrimary/10'
                : 'border-newTextColor/20 hover:border-btnPrimary/60'
            )}
          >
            <input
              type={multiple ? 'checkbox' : 'radio'}
              name={question.id}
              checked={selected}
              onChange={() => choose(option.id)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className={clsx(
                'shrink-0 flex items-center justify-center h-[22px] w-[22px] border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-btnPrimary peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-newBgColorInner',
                multiple ? 'rounded-[6px]' : 'rounded-full',
                selected
                  ? 'bg-btnPrimary border-btnPrimary text-white'
                  : 'border-newTextColor/40 text-transparent'
              )}
            >
              <svg viewBox="0 0 16 16" className="h-[14px] w-[14px]" fill="none">
                <path
                  d="M3.5 8.5l3 3 6-7"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span dir="auto" className="flex-1 break-words">
              {option.label}
            </span>
            {recommended.includes(option.id) && (
              <span className="text-[12px] whitespace-nowrap rounded-full border border-btnPrimary/40 bg-btnPrimary/15 px-[8px] py-[2px]">
                {t('plan_recommended', 'Recommended')}
              </span>
            )}
          </label>
        );
      })}
      <input
        dir="auto"
        value={value.other}
        maxLength={LIMITS.other}
        placeholder={t('plan_other', 'Other')}
        aria-label={t('plan_other', 'Other')}
        onChange={(event) =>
          onChange({
            optionIds:
              multiple || !event.target.value ? value.optionIds : [],
            other: event.target.value,
          })
        }
        className="bg-newBgColorInner min-h-[48px] border border-newTextColor/30 rounded-[10px] px-[12px] text-newTextColor placeholder:text-newTextColor/50 outline-none w-full focus:border-btnPrimary focus:shadow-[0_0_0_3px_rgba(97,43,211,0.25)]"
      />
    </fieldset>
  );
};
