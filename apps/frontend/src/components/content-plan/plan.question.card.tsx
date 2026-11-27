'use client';

// Content plan: one question of a setup round with its options, the recommended ones pre-ticked, and an "Other" box.
// A question takes one option (a circle) or several (a square); the tick is an icon, the real input stays for keyboards
// and screen readers.
import React, { FC, useLayoutEffect, useRef } from 'react';
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
  const otherSelected = !!value.other.trim();
  // "Other" is a box that grows with what is typed, so a long answer stays readable.
  const otherBox = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const box = otherBox.current;
    if (box) {
      box.style.height = 'auto';
      if (box.scrollHeight) {
        box.style.height = `${box.scrollHeight}px`;
      }
    }
  }, [value.other]);
  return (
    <fieldset
      disabled={disabled}
      className="flex flex-col gap-[20px] bg-newBgColorInner rounded-[16px] p-[20px] sm:p-[28px] border border-newTextColor/15 min-w-0 max-sm:p-0 max-sm:border-0 max-sm:bg-transparent"
    >
      <legend className="sr-only">{question.text}</legend>
      <div className="flex flex-col gap-[6px]">
        <div
          aria-hidden="true"
          dir="auto"
          className="font-[700] text-[20px] sm:text-[22px] leading-[1.35] break-words"
        >
          {question.text}
        </div>
        {multiple && (
          <div className="text-newTextColor/60 text-[15px]">
            {t('plan_choose_all', 'Choose all that apply')}
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-[10px] sm:gap-[16px]">
        {question.options.map((option) => {
          const selected = value.optionIds.includes(option.id);
          return (
            <label
              key={option.id}
              className={clsx(
                'flex items-center gap-[16px] cursor-pointer rounded-[14px] border-2 px-[14px] sm:px-[20px] py-[16px] min-h-[72px] text-[17px] leading-[1.4] transition duration-150 motion-reduce:transition-none active:scale-[0.99]',
                selected
                  ? 'border-btnPrimary bg-btnPrimary/15 font-[600] shadow-[0_8px_24px_rgba(97,43,211,0.28)]'
                  : 'border-newTextColor/10 bg-newTextColor/[0.04] hover:bg-newTextColor/[0.07] hover:border-btnPrimary/50 hover:-translate-y-px'
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
                  'shrink-0 flex items-center justify-center h-[28px] w-[28px] border-2 transition duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-btnPrimary peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-newBgColorInner',
                  multiple ? 'rounded-[8px]' : 'rounded-full',
                  selected
                    ? 'bg-btnPrimary border-btnPrimary text-white'
                    : 'border-newTextColor/30 text-transparent'
                )}
              >
                <svg
                  viewBox="0 0 16 16"
                  className={clsx(
                    'h-[16px] w-[16px] transition duration-150 motion-reduce:transition-none',
                    selected ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
                  )}
                  fill="none"
                >
                  <path
                    d="M3.5 8.5l3 3 6-7"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span dir="auto" className="flex-1 break-words">
                {option.label}
              </span>
              {recommended.includes(option.id) && (
                <span className="text-[12px] font-[600] whitespace-nowrap rounded-full bg-btnPrimary/25 px-[10px] py-[4px]">
                  {t('plan_recommended', 'Recommended')}
                </span>
              )}
            </label>
          );
        })}
        <label
          className={clsx(
            'flex items-center gap-[16px] rounded-[14px] border-2 px-[14px] sm:px-[20px] min-h-[72px] text-[17px] transition duration-150 motion-reduce:transition-none focus-within:border-btnPrimary focus-within:shadow-[0_0_0_4px_rgba(97,43,211,0.25)]',
            otherSelected
              ? 'border-btnPrimary bg-btnPrimary/15'
              : 'border-newTextColor/10 bg-newTextColor/[0.04] hover:bg-newTextColor/[0.07] hover:border-btnPrimary/50'
          )}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className={clsx(
              'shrink-0 h-[24px] w-[24px]',
              otherSelected ? 'text-btnPrimary' : 'text-newTextColor/50'
            )}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          <textarea
            ref={otherBox}
            rows={1}
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
            className="flex-1 min-w-0 resize-none overflow-hidden bg-transparent py-[16px] text-[17px] leading-[1.4] text-newTextColor placeholder:text-newTextColor/50 outline-none"
          />
        </label>
      </div>
    </fieldset>
  );
};
