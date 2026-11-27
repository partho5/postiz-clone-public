'use client';

// Content plan: the result step of the instant video plan. The videos as a list that scrolls, the note about the phone, and
// a footer that stays in place: "Not right?" (a revision with the owner's words) and "Add to plan".
import React, { FC, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Textarea } from '@gitroom/react/form/textarea';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  PLAN_OUTLINE_BUTTON,
  PLAN_PRIMARY_BUTTON,
  PlanFailed,
} from '@gitroom/frontend/components/content-plan/plan.parts';
import { PlanInstantVideo } from '@gitroom/frontend/components/content-plan/plan.instant.video';
import {
  LIMITS,
  PlanVideoSetVideo,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The lower-priority button of the footer: no border, only a hover.
const PLAN_GHOST_BUTTON =
  'min-h-[48px] w-full sm:w-auto rounded-[10px] px-[20px] font-[600] !bg-transparent !text-newTextColor/80 transition hover:!bg-newTextColor/10 hover:!text-newTextColor';

// The proposal: every video with its date, and the footer. `onRevise` sends the owner's feedback, `onConfirm` the dates
// the owner changed (only those). `failed` is shown above the list when the last revision could not be written.
export const PlanInstantResult: FC<{
  videos: PlanVideoSetVideo[];
  today: string;
  canEdit: boolean;
  busy: boolean;
  failed: boolean;
  onRetry?: () => void;
  onRevise: (feedback: string) => void;
  onConfirm: (dates: { ref: string; date: string }[]) => void;
}> = ({ videos, today, canEdit, busy, failed, onRetry, onRevise, onConfirm }) => {
  const t = useT();
  const [dates, setDates] = useState<Record<string, string>>(() =>
    Object.fromEntries(videos.map((video) => [video.ref, video.date]))
  );
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');
  const disabled = busy || !canEdit;
  const datesValid = videos.every((video) => (dates[video.ref] ?? '') >= today);
  const changedDates = videos
    .filter((video) => dates[video.ref] !== video.date)
    .map((video) => ({ ref: video.ref, date: dates[video.ref] }));

  return (
    <div className="flex flex-col gap-[16px]">
      {failed && (
        <PlanFailed
          text={t('plan_instant_failed', 'The video could not be written.')}
          onRetry={canEdit ? onRetry : undefined}
          loading={busy}
        />
      )}
      <div className="flex flex-col gap-[24px] max-h-[55vh] overflow-y-auto pe-[4px]">
        {videos.map((video, index) => (
          <div
            key={video.ref}
            className="flex flex-col gap-[12px] border-b border-newTextColor/15 pb-[24px] last:border-b-0 last:pb-0"
          >
            {videos.length > 1 && (
              <div className="text-newTextColor/60 text-[14px]">
                {t('plan_instant_video_n', {
                  defaultValue: 'Video {{number}}',
                  number: index + 1,
                })}
              </div>
            )}
            <PlanInstantVideo
              video={video}
              date={dates[video.ref] ?? video.date}
              today={today}
              disabled={disabled}
              onDate={(date) =>
                setDates((held) => ({ ...held, [video.ref]: date }))
              }
            />
          </div>
        ))}
      </div>
      <div
        role="note"
        className="flex items-start gap-[10px] rounded-[10px] border border-btnPrimary/40 bg-btnPrimary/10 px-[12px] py-[10px] text-[14px]"
      >
        <span aria-hidden="true" className="text-btnPrimary">
          ●
        </span>
        {videos.length === 1
          ? t(
              'plan_instant_note_one',
              'After you add it, this is the next video on your phone, as its own topic set. An AI video on the same day stays too.'
            )
          : t(
              'plan_instant_note_other',
              'After you add them, the first is the next video on your phone, each as its own topic set. An AI video on the same day stays too.'
            )}
      </div>
      {canEdit && (
        <div className="flex flex-col gap-[12px] border-t border-newTextColor/15 pt-[16px]">
          {revising && (
            <div className="flex flex-col gap-[8px]">
              <Textarea
                label={t('plan_instant_feedback', 'What should change?')}
                name="planInstantFeedback"
                disableForm={true}
                disabled={busy}
                dir="auto"
                autoFocus
                value={feedback}
                maxLength={LIMITS.feedback}
                className="min-h-[100px] w-full"
                onChange={(event) => setFeedback(event.target.value)}
              />
              <div className="flex">
                <Button
                  disabled={busy || !feedback.trim()}
                  onClick={() => onRevise(feedback.trim())}
                  className={PLAN_OUTLINE_BUTTON}
                >
                  {t('plan_instant_send_feedback', 'Write it again')}
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-[12px]">
            <Button
              disabled={busy}
              aria-expanded={revising}
              onClick={() => setRevising((held) => !held)}
              className={PLAN_GHOST_BUTTON}
            >
              {t('plan_instant_not_right', 'Not right?')}
            </Button>
            <Button
              disabled={busy || !datesValid}
              onClick={() => onConfirm(changedDates)}
              className={PLAN_PRIMARY_BUTTON}
            >
              {t('plan_instant_add', 'Add to plan')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
