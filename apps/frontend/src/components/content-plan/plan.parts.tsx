'use client';

// Content plan: the small pieces the setup, the preview and the running plan share.
import React, { FC } from 'react';
import { Button } from '@gitroom/react/form/button';
import Spinner from '@gitroom/frontend/components/layout/loading';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

// The date `days` after a YYYY-MM-DD date, as YYYY-MM-DD.
export const planAddDays = (date: string, days: number) => {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
};

// A YYYY-MM-DD date in the reader's own language and date order (a calendar date has no time zone, so it is read as UTC).
export const planDate = (date: string) =>
  new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));

// The first and last day of the 7 days that start on `weekStart`.
export const planWeekRange = (weekStart: string) =>
  `${planDate(weekStart)} - ${planDate(planAddDays(weekStart, 6))}`;

// A titled block of the page: the preview and the running plan draw their parts with it.
export const PlanSection: FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <div className="flex flex-col gap-[12px] bg-newBgColorInner rounded-[16px] p-[20px] sm:p-[24px] border border-newTextColor/15 min-w-0">
    <div className="font-[600]">{title}</div>
    {children}
  </div>
);

// The primary and the lower-priority button of the page: one purple family (a soft gradient, and an outline).
export const PLAN_PRIMARY_BUTTON =
  'min-h-[48px] w-full sm:w-auto rounded-[10px] px-[28px] font-[600] bg-gradient-to-br from-[#6d35e8] to-[#4f46e5] ring-1 ring-inset ring-white/15 shadow-[0_6px_20px_rgba(97,43,211,0.35)] transition hover:brightness-110 hover:-translate-y-px';
export const PLAN_OUTLINE_BUTTON =
  'min-h-[48px] w-full sm:w-auto rounded-[10px] px-[28px] font-[600] border border-btnPrimary !bg-transparent !text-newTextColor transition hover:!bg-btnPrimary/15';
// A select of the page: the shared field look (a recessed well), at the height of the page's buttons.
export const PLAN_SELECT =
  'h-[48px] w-full sm:w-[160px] bg-newFieldBg border border-newTextColor/25 hover:border-newTextColor/40 rounded-[10px] px-[14px] text-[15px] text-newTextColor outline-none transition-colors focus:border-btnPrimary focus:ring-[3px] focus:ring-btnPrimary/25 disabled:opacity-50';

// The "Previous" button every step but the first has.
export const PlanBackButton: FC<{ onClick: () => void; disabled?: boolean }> = ({
  onClick,
  disabled,
}) => {
  const t = useT();
  return (
    <Button onClick={onClick} disabled={disabled} className={PLAN_OUTLINE_BUTTON}>
      <span aria-hidden="true" className="me-[8px] inline-block rtl:rotate-180">
        ←
      </span>
      {t('plan_previous', 'Previous')}
    </Button>
  );
};

// A short note under a step: what happens to the next steps if the owner changes this one.
export const PlanChangeNote: FC<{ text: string }> = ({ text }) => (
  <div
    role="status"
    className="rounded-[10px] border border-btnPrimary/40 bg-btnPrimary/10 px-[12px] py-[10px] text-[14px]"
  >
    {text}
  </div>
);

// Seconds each waiting line shows before the next; the last one stays.
const THINKING_STEP_SECONDS = 3;

// The line shown while the AI works on a part of the page. With a `kind` it walks through what is happening; the
// timing lives in CSS animations (the dashboard loader's), so there is no timer to clean up.
export const PlanThinking: FC<{ kind?: 'start' | 'round' | 'proposal' | 'video' }> = ({
  kind,
}) => {
  const t = useT();
  const lines = {
    start: [
      t('plan_wait_start_1', 'Reading your business description…'),
      t('plan_wait_start_2', 'Understanding your business and your customers…'),
      t('plan_wait_start_3', 'Working out what to ask you…'),
      t('plan_wait_start_4', 'Preparing your questions…'),
      t('plan_wait_start_5', 'Choosing recommended answers…'),
      t('plan_wait_almost', 'Almost ready…'),
    ],
    round: [
      t('plan_wait_round_1', 'Saving your answers…'),
      t('plan_wait_round_2', 'Updating what I understood…'),
      t('plan_wait_round_3', 'Checking what is still unclear…'),
      t('plan_wait_round_4', 'Preparing the next questions…'),
      t('plan_wait_almost', 'Almost ready…'),
    ],
    proposal: [
      t('plan_wait_proposal_1', 'Putting your answers together…'),
      t('plan_wait_proposal_2', 'Choosing themes for your videos…'),
      t('plan_wait_proposal_3', 'Planning the first weeks…'),
      t('plan_wait_proposal_4', 'Writing your content plan…'),
      t('plan_wait_almost', 'Almost ready…'),
    ],
    video: [
      t('plan_wait_video_1', 'Reading your idea…'),
      t('plan_wait_video_2', "Checking what's unclear…"),
      t('plan_wait_video_3', 'Writing your video…'),
      t('plan_wait_almost', 'Almost ready…'),
    ],
  };
  const messages = kind ? lines[kind] : [t('plan_thinking', 'Thinking…')];
  return (
    <div
      role="status"
      className="flex items-center gap-[12px] min-h-[48px] text-newTextColor/80"
    >
      <Spinner width={18} height={18} />
      <div className="grid">
        {messages.map((message, index) => {
          const isLast = index === messages.length - 1;
          const start = index * THINKING_STEP_SECONDS;
          return (
            <div
              key={index}
              className="boot-message col-start-1 row-start-1"
              style={{
                animationName: isLast ? 'boot-in' : 'boot-in, boot-out',
                animationDelay: isLast
                  ? `${start}s`
                  : `${start}s, ${start + THINKING_STEP_SECONDS}s`,
              }}
            >
              {message}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// The one quiet line shown when the AI could not finish, with the button that asks again.
export const PlanFailed: FC<{
  text: string;
  onRetry?: () => void;
  loading?: boolean;
}> = ({ text, onRetry, loading }) => {
  const t = useT();
  return (
    <div className="flex items-center gap-[12px] flex-wrap">
      <div className="text-red-400">{text}</div>
      {onRetry && (
        <Button loading={loading} onClick={onRetry} className={PLAN_OUTLINE_BUTTON}>
          {t('plan_try_again', 'Try again')}
        </Button>
      )}
    </div>
  );
};
