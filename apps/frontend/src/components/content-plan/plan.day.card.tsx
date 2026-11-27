'use client';

// Content plan: one video of the week: its date, title, angle, why, the beats (what is on screen and what to say),
// the closing line, and the actions on it.
import React, { FC, useCallback, useState } from 'react';
import clsx from 'clsx';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { PlanAngleChip } from '@gitroom/frontend/components/content-plan/plan.angle.chip';
import {
  PLAN_OUTLINE_BUTTON,
  PlanThinking,
  planDate,
} from '@gitroom/frontend/components/content-plan/plan.parts';
import { CURRENT_WEEK_KEY } from '@gitroom/frontend/components/content-plan/use.plan.current.week';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import { PlanDayView } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The small menu of a video; today it holds "Mark recorded". It closes when the focus leaves it.
const PlanDayMenu: FC<{ disabled: boolean; onRecorded: () => void }> = ({
  disabled,
  onRecorded,
}) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('plan_day_more', 'More')}
        onClick={() => setOpen((held) => !held)}
        className="min-h-[48px] min-w-[48px] rounded-[10px] border border-newTextColor/20 text-[18px] transition-colors hover:bg-newTextColor/5 hover:border-newTextColor/40 disabled:opacity-50"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute end-0 mt-[4px] z-10 min-w-[180px] bg-newBgColorInner border border-newTextColor/20 rounded-[10px] p-[4px] shadow-menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onRecorded();
            }}
            className="w-full min-h-[44px] px-[12px] text-start rounded-[8px] hover:bg-newTextColor/5"
          >
            {t('plan_mark_recorded', 'Mark recorded')}
          </button>
        </div>
      )}
    </div>
  );
};

// A video of the week. A video that is being written again shows "Thinking…" and cannot be touched. The says are in
// the script, which opens on request. A done video (recorded, or its day is past) is one line that opens on a click:
// its date, angle, status and title, and the menu while it is not recorded.
export const PlanDayCard: FC<{
  day: PlanDayView;
  today: string;
  canEdit: boolean;
}> = ({ day, today, canEdit }) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const [showScript, setShowScript] = useState(false);
  const [opened, setOpened] = useState(false);
  const working = pending || day.busy;
  const recorded = day.status === 'RECORDED';
  // the server keeps a past video PLANNED in the current week; the page tells it from the date
  const missed = day.status === 'MISSED' || (day.status === 'PLANNED' && day.date < today);
  // a done video starts closed; a video marked recorded on or before its day closes at once
  const done = recorded || missed;
  const open = !done || opened;
  // an instant video has no angle to change (the owner wrote the idea), so only a planned AI video is written again
  const changeable =
    day.kind === 'PLANNED' && day.status === 'PLANNED' && day.date >= today;

  const change = useCallback(() => {
    return send(
      'POST',
      `/content-plan/days/${day.id}/regenerate`,
      undefined,
      { write: null, refresh: [CURRENT_WEEK_KEY] }
    );
  }, [day.id, send]);

  const markRecorded = useCallback(() => {
    return send('POST', `/content-plan/days/${day.id}/recorded`, undefined, {
      write: null,
      refresh: [CURRENT_WEEK_KEY],
    });
  }, [day.id, send]);

  const menu =
    canEdit && !recorded ? (
      <PlanDayMenu disabled={working} onRecorded={markRecorded} />
    ) : null;

  const meta = (
    <>
      <span className="text-newTextColor/60 text-[15px]">{planDate(day.date)}</span>
      <PlanAngleChip angle={day.angle} />
      {recorded && (
        <span className="text-green-400 text-[13px]">
          {'✓ '}
          {t('plan_recorded', 'Recorded')}
        </span>
      )}
      {missed && !recorded && (
        <span className="text-newTextColor/60 text-[15px]">
          {t('plan_missed', 'Missed')}
        </span>
      )}
    </>
  );

  return (
    <div
      className={clsx(
        'flex flex-col bg-newBgColorInner rounded-[16px] border border-newTextColor/15 min-w-0',
        open ? 'gap-[14px] p-[20px] sm:p-[24px]' : 'px-[16px] py-[6px] sm:px-[20px]'
      )}
    >
      {day.busy && <PlanThinking />}
      {done && (
        <div className="flex items-center gap-[8px] min-w-0">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`plan-day-${day.id}`}
            onClick={() => setOpened((held) => !held)}
            className="group flex-1 min-w-0 grid grid-cols-[1fr_auto] items-center gap-[8px] min-h-[48px] text-start rounded-[10px] outline-none focus-visible:ring-[3px] focus-visible:ring-btnPrimary/40"
          >
            <span className="min-w-0 flex items-center gap-x-[8px] gap-y-[4px] flex-wrap">
              {meta}
              <span
                dir="auto"
                className={clsx(
                  'flex-1 min-w-[min(100%,160px)] font-[600]',
                  open ? 'break-words' : 'truncate'
                )}
              >
                {day.title}
              </span>
            </span>
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className={clsx(
                'h-[18px] w-[18px] text-newTextColor/60 group-hover:text-newTextColor transition motion-reduce:transition-none',
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
          {menu}
        </div>
      )}
      {open && (
        <div
          id={`plan-day-${day.id}`}
          className={day.busy ? 'flex flex-col gap-[10px] opacity-50' : 'flex flex-col gap-[10px]'}
        >
          {!done && (
            <>
              <div className="flex items-center gap-[8px] flex-wrap">{meta}</div>
              <div dir="auto" className="font-[600] break-words">
                {day.title}
              </div>
            </>
          )}
          <div dir="auto" className="text-newTextColor/70 break-words">
            {day.why}
          </div>
          <ol className="flex flex-col gap-[10px] list-decimal ps-[20px]">
            {day.beats.map((beat, index) => (
              <li key={index} className="min-w-0">
                <div className="text-newTextColor/60 text-[14px]">
                  {t('plan_on_screen', 'On screen')}
                </div>
                <div dir="auto" className="font-[600] break-words">
                  {beat.hook}
                </div>
                {showScript && (
                  <>
                    <div className="text-newTextColor/60 text-[14px] mt-[4px]">
                      {t('plan_you_say', 'You say')}
                    </div>
                    <div dir="auto" className="whitespace-pre-line break-words">
                      {beat.say}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ol>
          <button
            type="button"
            aria-expanded={showScript}
            onClick={() => setShowScript((held) => !held)}
            className="self-start min-h-[44px] underline text-[14px]"
          >
            {showScript
              ? t('plan_hide_script', 'Hide script')
              : t('plan_show_script', 'Show script')}
          </button>
          <div className="flex flex-col">
            <div className="text-newTextColor/60 text-[14px]">
              {t('plan_closing_line', 'Closing line')}
            </div>
            <div dir="auto" className="whitespace-pre-line break-words">
              {day.closingLine}
            </div>
          </div>
        </div>
      )}
      {canEdit && !done && (
        <div className="flex items-center gap-[12px] flex-wrap">
          {day.kind === 'PLANNED' && (
            <Button
              disabled={working || !changeable}
              onClick={change}
              className={PLAN_OUTLINE_BUTTON}
            >
              {t('plan_change_topic', 'Change this topic')}
            </Button>
          )}
          {menu}
        </div>
      )}
    </div>
  );
};
