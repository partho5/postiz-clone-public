'use client';

// AI captions (ai.video-captions): the small pieces the list and the detail of a caption share.
import React, { FC } from 'react';
import clsx from 'clsx';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import ImageWithFallback from '@gitroom/react/helpers/image.with.fallback';
import SafeImage from '@gitroom/react/helpers/safe.image';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { isUSCitizen } from '@gitroom/frontend/components/launches/helpers/isuscitizen.utils';
import { AiCaptionStatus } from '@gitroom/frontend/components/ai-captions/use.ai.captions';

dayjs.extend(utc);

// A date and time in the user's own timezone and date order. Reads the browser's settings, so only call it once
// the page has data (never on the server).
export const captionDate = (date: string) =>
  dayjs
    .utc(date)
    .local()
    .format(isUSCitizen() ? 'MM/DD/YYYY hh:mm A' : 'DD/MM/YYYY HH:mm');

// Where a caption stands, in words.
export const CaptionStatus: FC<{ status: AiCaptionStatus }> = ({ status }) => {
  const t = useT();
  const labels: Record<AiCaptionStatus, string> = {
    PENDING: t('caption_status_pending', 'Waiting to start'),
    TRANSCRIBING: t('caption_status_transcribing', 'Listening to the video'),
    GENERATING: t('caption_status_generating', 'Writing the captions'),
    READY: t('caption_status_ready', 'Ready'),
    NO_SPEECH: t('caption_status_no_speech', 'No speech found'),
    FAILED: t('caption_status_failed', 'Failed'),
  };
  return (
    <span
      className={clsx(
        'font-[600]',
        status === 'READY' && 'text-green-500',
        status === 'FAILED' && 'text-red-400',
        status !== 'READY' && status !== 'FAILED' && 'text-textItemBlur'
      )}
    >
      {labels[status]}
    </span>
  );
};

// A channel: its picture (the platform's icon when it has none) with the platform's icon on its corner.
export const ChannelAvatar: FC<{
  provider: string;
  picture?: string | null;
  name?: string;
}> = ({ provider, picture, name }) => (
  <div className="relative shrink-0" title={name || provider}>
    <ImageWithFallback
      fallbackSrc={`/icons/platforms/${provider}.png`}
      src={picture || `/icons/platforms/${provider}.png`}
      className="rounded-full w-[32px] h-[32px] object-cover"
      alt={name || provider}
      width={32}
      height={32}
    />
    <SafeImage
      src={`/icons/platforms/${provider}.png`}
      className="rounded-[4px] absolute z-10 bottom-0 -end-[4px] border border-newBgColorInner"
      alt={provider}
      width={14}
      height={14}
    />
  </div>
);

// Copies a text to the clipboard.
export const CopyTextButton: FC<{ text: string; label: string }> = ({
  text,
  label,
}) => {
  const toaster = useToaster();
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => {
        copy(text);
        toaster.show(t('copied_to_clipboard', 'Copied to clipboard'), 'success');
      }}
      className="cursor-pointer px-[16px] h-[36px] bg-btnSimple hover:bg-boxHover transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
      </svg>
      {label}
    </button>
  );
};
