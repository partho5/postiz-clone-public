'use client';

// Content plan: the first step of the instant video plan. One text, one button. The date (today) and the number of videos
// (one) stay folded in a row under the text; the row says what is chosen, and its arrow opens the two fields.
import React, { FC, useState } from 'react';
import clsx from 'clsx';
import { Button } from '@gitroom/react/form/button';
import { Textarea } from '@gitroom/react/form/textarea';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  PLAN_PRIMARY_BUTTON,
  PLAN_SELECT,
  PlanThinking,
  planDate,
} from '@gitroom/frontend/components/content-plan/plan.parts';
import {
  LIMITS,
  MAX_VIDEO_SET,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The options the page sends when it starts a session. A field the owner left as it was is left out, so the AI may ask
// about it (a broad idea only becomes a set when the owner did not fix the number).
export interface PlanInstantOptions {
  date?: string;
  count?: number;
}

// The words for a number of videos ("1 video", "3 videos"); each form is its own text, so a language can write it its way.
export const useVideoCount = () => {
  const t = useT();
  return (number: number) =>
    number === 1
      ? t('plan_instant_count_one', '1 video')
      : t('plan_instant_count_other', {
          defaultValue: '{{number}} videos',
          number,
        });
};

// The first step: the idea, the folded options and the button that starts the session. While it starts, the waiting line
// replaces the button.
export const PlanInstantIdea: FC<{
  today: string;
  starting: boolean;
  onStart: (sourceText: string, options: PlanInstantOptions) => void;
}> = ({ today, starting, onStart }) => {
  const t = useT();
  const videoCount = useVideoCount();
  const [idea, setIdea] = useState('');
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [count, setCount] = useState(1);
  const [countSet, setCountSet] = useState(false);
  const dateValid = !date || date >= today;
  const chosenDate = date || today;

  // Only what the owner changed is sent.
  const start = () =>
    onStart(idea.trim(), {
      ...(chosenDate !== today ? { date: chosenDate } : {}),
      ...(countSet ? { count } : {}),
    });

  return (
    <div className="flex flex-col gap-[4px]">
      <Textarea
        label={t(
          'plan_instant_idea_label',
          "What's the video about? Any rough idea works."
        )}
        name="planInstantIdea"
        disableForm={true}
        disabled={starting}
        dir="auto"
        autoFocus
        value={idea}
        maxLength={LIMITS.sourceText}
        className="min-h-[120px] w-full"
        onChange={(event) => setIdea(event.target.value)}
      />
      <div className="flex flex-col gap-[12px]">
        <button
          type="button"
          disabled={starting}
          aria-expanded={open}
          aria-controls="plan-instant-options"
          onClick={() => setOpen((held) => !held)}
          className="self-start flex items-center gap-[8px] min-h-[44px] rounded-[10px] px-[4px] text-[15px] text-newTextColor/80 hover:text-newTextColor outline-none focus-visible:ring-[3px] focus-visible:ring-btnPrimary/40 disabled:opacity-50"
        >
          <span dir="auto">
            {chosenDate === today ? t('plan_today', 'Today') : planDate(chosenDate)}
            {' · '}
            {videoCount(count)}
          </span>
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className={clsx(
              'h-[18px] w-[18px] transition-transform motion-reduce:transition-none',
              open && 'rotate-180'
            )}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {open && (
          <div
            id="plan-instant-options"
            className="flex flex-col sm:flex-row gap-[16px]"
          >
            <label className="flex flex-col gap-[6px] text-[14px]">
              {t('plan_instant_date', 'Date')}
              <input
                type="date"
                value={date}
                min={today}
                disabled={starting}
                onChange={(event) => setDate(event.target.value)}
                className={PLAN_SELECT}
              />
            </label>
            <label className="flex flex-col gap-[6px] text-[14px]">
              {t('plan_instant_videos', 'Videos')}
              <select
                value={count}
                disabled={starting}
                onChange={(event) => {
                  setCount(Number(event.target.value));
                  setCountSet(true);
                }}
                className={PLAN_SELECT}
              >
                {Array.from({ length: MAX_VIDEO_SET }, (_, index) => index + 1).map(
                  (number) => (
                    <option key={number} value={number}>
                      {number}
                    </option>
                  )
                )}
              </select>
            </label>
          </div>
        )}
      </div>
      <div className="flex mt-[16px]">
        {starting ? (
          <PlanThinking kind="video" />
        ) : (
          <Button
            disabled={!idea.trim() || !dateValid}
            onClick={start}
            className={PLAN_PRIMARY_BUTTON}
          >
            {t('plan_instant_start', 'Plan this video')}
          </Button>
        )}
      </div>
    </div>
  );
};
