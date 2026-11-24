'use client';

// Content plan: the small pieces the setup, the preview and the running plan share.
import React, { FC } from 'react';
import { Button } from '@gitroom/react/form/button';
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
  <div className="flex flex-col gap-[8px] bg-newBgColorInner rounded-[12px] p-[16px] border border-newTableBorder min-w-0">
    <div className="font-[600]">{title}</div>
    {children}
  </div>
);

// The line shown while the AI works on a part of the page.
export const PlanThinking: FC = () => {
  const t = useT();
  return (
    <div className="text-textItemBlur animate-pulse" role="status">
      {t('plan_thinking', 'Thinking…')}
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
        <Button secondary loading={loading} onClick={onRetry}>
          {t('plan_try_again', 'Try again')}
        </Button>
      )}
    </div>
  );
};
