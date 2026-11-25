'use client';

// Content plan: one video of the week: its date, title, angle, why, the beats (what is on screen and what to say),
// the closing line, and the actions on it.
import React, { FC, useCallback, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { PlanAngleChip } from '@gitroom/frontend/components/content-plan/plan.angle.chip';
import {
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
        className="min-h-[44px] min-w-[44px] rounded-[8px] border border-newTextColor/20 text-[18px] disabled:opacity-50"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute end-0 mt-[4px] z-10 min-w-[180px] bg-newBgColorInner border border-newTextColor/20 rounded-[8px] p-[4px]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onRecorded();
            }}
            className="w-full min-h-[44px] px-[12px] text-start rounded-[6px]"
          >
            {t('plan_mark_recorded', 'Mark recorded')}
          </button>
        </div>
      )}
    </div>
  );
};

// A video of the week. A video that is being written again shows "Thinking…" and cannot be touched. The says are in
// the script, which opens on request.
export const PlanDayCard: FC<{
  day: PlanDayView;
  today: string;
  canEdit: boolean;
}> = ({ day, today, canEdit }) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const [showScript, setShowScript] = useState(false);
  const working = pending || day.busy;
  const recorded = day.status === 'RECORDED';
  // the server keeps a past video PLANNED in the current week; the page tells it from the date
  const missed = day.status === 'MISSED' || (day.status === 'PLANNED' && day.date < today);
  const changeable = day.status === 'PLANNED' && day.date >= today;

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

  return (
    <div className="flex flex-col gap-[10px] bg-newBgColorInner rounded-[12px] p-[16px] border border-newTextColor/20 min-w-0">
      {day.busy && <PlanThinking />}
      <div className={day.busy ? 'flex flex-col gap-[10px] opacity-50' : 'flex flex-col gap-[10px]'}>
        <div className="flex items-center gap-[8px] flex-wrap">
          <span className="text-newTextColor/70 text-[13px]">{planDate(day.date)}</span>
          <PlanAngleChip angle={day.angle} />
          {recorded && (
            <span className="text-green-400 text-[13px]">
              {'✓ '}
              {t('plan_recorded', 'Recorded')}
            </span>
          )}
          {missed && !recorded && (
            <span className="text-newTextColor/70 text-[13px]">
              {t('plan_missed', 'Missed')}
            </span>
          )}
        </div>
        <div dir="auto" className="font-[600] break-words">
          {day.title}
        </div>
        <div dir="auto" className="text-newTextColor/70 break-words">
          {day.why}
        </div>
        <ol className="flex flex-col gap-[10px] list-decimal ps-[20px]">
          {day.beats.map((beat, index) => (
            <li key={index} className="min-w-0">
              <div className="text-newTextColor/70 text-[12px]">
                {t('plan_on_screen', 'On screen')}
              </div>
              <div dir="auto" className="font-[600] break-words">
                {beat.hook}
              </div>
              {showScript && (
                <>
                  <div className="text-newTextColor/70 text-[12px] mt-[4px]">
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
          <div className="text-newTextColor/70 text-[12px]">
            {t('plan_closing_line', 'Closing line')}
          </div>
          <div dir="auto" className="whitespace-pre-line break-words">
            {day.closingLine}
          </div>
        </div>
      </div>
      {canEdit && (
        <div className="flex items-center gap-[12px] flex-wrap">
          <Button
            secondary
            disabled={working || !changeable}
            onClick={change}
            className="min-h-[44px]"
          >
            {t('plan_change_topic', 'Change this topic')}
          </Button>
          {!recorded && (
            <PlanDayMenu disabled={working} onRecorded={markRecorded} />
          )}
        </div>
      )}
    </div>
  );
};
