'use client';

// Content plan: one video of an instant video plan as the phone shows it while recording. A 9:16 frame with the topic
// (the "hook") large over a dimmed camera, buttons and dots to step through the topics, and beside it the title, the date
// (the owner may change it) and what to say for the topic on screen.
import React, { FC, useState } from 'react';
import clsx from 'clsx';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { PlanVideoSetVideo } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The dimmed camera of the frame: a head and shoulders in the dark. It is a picture of a camera, so its colours are not
// the page's.
const CAMERA_STYLE: React.CSSProperties = {
  background:
    'radial-gradient(circle at 50% 62%, #5b5560 0 18%, transparent 19%), radial-gradient(ellipse at 50% 100%, #4a4550 0 38%, transparent 39%), linear-gradient(#1f1d24, #121116)',
};

const NAV_BUTTON =
  'h-[44px] w-[44px] shrink-0 rounded-full bg-white/20 text-white text-[18px] outline-none transition-colors hover:bg-white/30 focus-visible:ring-[3px] focus-visible:ring-white/70';

// The frame of one video. Arrow keys move between the topics while the frame has the focus (the arrow that goes on is the
// one that points the way the text reads).
const PlanPhone: FC<{
  video: PlanVideoSetVideo;
  index: number;
  onIndex: (index: number) => void;
}> = ({ video, index, onIndex }) => {
  const t = useT();
  const last = video.beats.length - 1;
  const go = (to: number) => onIndex(Math.min(last, Math.max(0, to)));
  const beat = video.beats[index];

  return (
    <div
      tabIndex={0}
      role="group"
      aria-label={t('plan_instant_phone', 'Phone preview of the topics')}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
          return;
        }
        event.preventDefault();
        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
        const forward = (event.key === 'ArrowRight') !== rtl;
        go(index + (forward ? 1 : -1));
      }}
      style={CAMERA_STYLE}
      className="relative flex flex-col w-[220px] max-w-full aspect-[9/16] shrink-0 rounded-[28px] border-[6px] border-newTextColor/30 overflow-hidden outline-none focus-visible:ring-[3px] focus-visible:ring-btnPrimary/60"
    >
      <span
        aria-hidden="true"
        className="absolute top-[10px] start-[12px] flex items-center gap-[5px] text-[10px] font-[700] tracking-wider text-white"
      >
        <i className="h-[7px] w-[7px] rounded-full bg-red-500" />
        REC
      </span>
      <div
        dir="auto"
        className="mx-[14px] mt-[34px] rounded-[12px] bg-black/55 px-[14px] py-[12px] text-center text-[19px] font-[800] leading-[1.25] text-white break-words [text-wrap:balance]"
      >
        {beat?.hook}
      </div>
      <div className="absolute inset-x-0 bottom-[10px] flex items-center justify-center gap-[8px]">
        <button
          type="button"
          disabled={index === 0}
          aria-label={t('plan_instant_prev', 'Previous topic')}
          onClick={() => go(index - 1)}
          className={clsx(NAV_BUTTON, 'disabled:opacity-40')}
        >
          <span aria-hidden="true" className="inline-block rtl:rotate-180">
            ‹
          </span>
        </button>
        <div aria-hidden="true" className="flex items-center gap-[6px]">
          {video.beats.map((_, dot) => (
            <i
              key={dot}
              className={clsx(
                'h-[7px] rounded-full transition-all motion-reduce:transition-none',
                dot === index ? 'w-[16px] bg-white' : 'w-[7px] bg-white/40'
              )}
            />
          ))}
        </div>
        <button
          type="button"
          disabled={index === last}
          aria-label={t('plan_instant_next', 'Next topic')}
          onClick={() => go(index + 1)}
          className={clsx(NAV_BUTTON, 'disabled:opacity-40')}
        >
          <span aria-hidden="true" className="inline-block rtl:rotate-180">
            ›
          </span>
        </button>
      </div>
    </div>
  );
};

// The date of a video as a chip with the date field inside; a date before today is refused by the field's `min`.
const PlanDateChip: FC<{
  date: string;
  today: string;
  disabled: boolean;
  onChange: (date: string) => void;
}> = ({ date, today, disabled, onChange }) => {
  const t = useT();
  return (
    <label className="self-start inline-flex items-center gap-[8px] min-h-[44px] rounded-full border border-newTextColor/25 bg-newFieldBg ps-[14px] pe-[8px] focus-within:border-btnPrimary focus-within:ring-[3px] focus-within:ring-btnPrimary/25">
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-[16px] w-[16px] shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </svg>
      <input
        type="date"
        value={date}
        min={today}
        disabled={disabled}
        aria-label={t('plan_instant_video_date', 'Video date')}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-[40px] bg-transparent text-[15px] text-newTextColor outline-none disabled:opacity-50"
      />
    </label>
  );
};

// One video: the frame, and beside it (under it on a narrow screen) the title, the date, the script of the topic on screen
// and, after the last topic, the closing line.
export const PlanInstantVideo: FC<{
  video: PlanVideoSetVideo;
  date: string;
  today: string;
  disabled: boolean;
  onDate: (date: string) => void;
}> = ({ video, date, today, disabled, onDate }) => {
  const t = useT();
  const [index, setIndex] = useState(0);
  const beat = video.beats[index];
  const isLast = index === video.beats.length - 1;

  return (
    <div className="flex flex-col sm:flex-row gap-[20px] min-w-0">
      <div className="flex justify-center sm:justify-start">
        <PlanPhone video={video} index={index} onIndex={setIndex} />
      </div>
      <div className="flex flex-1 flex-col gap-[12px] min-w-0">
        <div dir="auto" className="text-[17px] font-[600] break-words">
          {video.title}
        </div>
        <PlanDateChip
          date={date}
          today={today}
          disabled={disabled}
          onChange={onDate}
        />
        <div className="flex flex-col gap-[6px] rounded-[12px] bg-newTextColor/[0.05] p-[14px]" aria-live="polite">
          <div className="text-newTextColor/60 text-[14px]">
            {t('plan_instant_say', {
              defaultValue: 'What to say · {{number}} of {{total}}',
              number: index + 1,
              total: video.beats.length,
            })}
          </div>
          <div dir="auto" className="whitespace-pre-line break-words">
            {beat?.say}
          </div>
          {isLast && (
            <>
              <div className="text-newTextColor/60 text-[14px] mt-[8px]">
                {t('plan_closing_line', 'Closing line')}
              </div>
              <div dir="auto" className="whitespace-pre-line break-words">
                {video.closingLine}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
