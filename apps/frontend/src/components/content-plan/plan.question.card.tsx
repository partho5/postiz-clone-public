'use client';

// Content plan: one question of a setup round with its options, the recommended one pre-selected, and an "Other" box.
import React, { FC } from 'react';
import clsx from 'clsx';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  LIMITS,
  PlanQuestion,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// What the owner chose for a question: an option, or their own words (never both).
export interface PlanQuestionValue {
  optionId: string | null;
  other: string;
}

// The value a question starts with: its recommended option.
export const initialQuestionValue = (
  question: PlanQuestion
): PlanQuestionValue => ({
  optionId: question.recommendedOptionId,
  other: '',
});

// A question card. Typing in "Other" un-selects the options; choosing an option clears "Other".
export const PlanQuestionCard: FC<{
  question: PlanQuestion;
  value: PlanQuestionValue;
  disabled: boolean;
  onChange: (value: PlanQuestionValue) => void;
}> = ({ question, value, disabled, onChange }) => {
  const t = useT();
  return (
    <fieldset
      disabled={disabled}
      className="flex flex-col gap-[10px] bg-newBgColorInner rounded-[12px] p-[16px] border border-newTableBorder min-w-0"
    >
      <legend dir="auto" className="font-[600] break-words px-[4px]">{question.text}</legend>
      {question.options.map((option) => (
        <label
          key={option.id}
          className={clsx(
            'flex items-center gap-[10px] cursor-pointer rounded-[8px] border p-[10px] min-h-[44px]',
            value.optionId === option.id
              ? 'border-forth'
              : 'border-newTableBorder'
          )}
        >
          <input
            type="radio"
            name={question.id}
            checked={value.optionId === option.id}
            onChange={() => onChange({ optionId: option.id, other: '' })}
            className="shrink-0"
          />
          <span dir="auto" className="flex-1 break-words">
            {option.label}
          </span>
          {option.id === question.recommendedOptionId && (
            <span className="text-[12px] text-textItemBlur whitespace-nowrap">
              {t('plan_recommended', 'Recommended')}
            </span>
          )}
        </label>
      ))}
      <input
        dir="auto"
        value={value.other}
        maxLength={LIMITS.other}
        placeholder={t('plan_other', 'Other')}
        aria-label={t('plan_other', 'Other')}
        onChange={(event) =>
          onChange({
            optionId: event.target.value ? null : value.optionId,
            other: event.target.value,
          })
        }
        className="bg-input min-h-[44px] border border-fifth rounded-[8px] px-[12px] text-inputText placeholder-inputText outline-none w-full"
      />
    </fieldset>
  );
};
