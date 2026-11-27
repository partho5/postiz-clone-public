'use client';

// AI captions (ai.video-captions): the page "AI captions". The captions written from the speech of the
// workspace's recordings; opening one shows its transcript and the text written for each channel. `?open=<id>`
// opens a caption straight away (the link the app gives).
import React, { FC, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useWorkspaceRouter } from '@gitroom/frontend/components/layout/workspace.navigation';
import { useAiCaptions } from '@gitroom/frontend/components/ai-captions/use.ai.captions';
import { AiCaptionDetailView } from '@gitroom/frontend/components/ai-captions/ai.caption.detail';
import {
  CaptionStatus,
  captionDate,
  ChannelAvatar,
} from '@gitroom/frontend/components/ai-captions/ai.caption.parts';

// How many channels a row of the list shows before "+N".
const MAX_CHANNELS = 5;

// The captions of this workspace, newest first, a page at a time.
const AiCaptionList: FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
  const t = useT();
  const { data, error, isLoading, isValidating, setSize, size } =
    useAiCaptions();

  if (isLoading) {
    return <LoadingComponent />;
  }
  if (error || !data) {
    return (
      <div className="text-red-400">
        {t('captions_unavailable', 'The captions could not be loaded.')}
      </div>
    );
  }

  const items = data.flatMap((page) => page.items);
  const last = data[data.length - 1];

  return (
    <div className="flex flex-col gap-[16px]">
      <div className="text-[24px] font-[600]">
        {t('ai_captions', 'AI captions')}
      </div>
      <div className="text-textItemBlur">
        {t(
          'ai_captions_description',
          'The captions the AI wrote from the speech in your recordings, for each channel they were published to.'
        )}
      </div>
      {!items.length && (
        <div className="text-textItemBlur">
          {t(
            'no_ai_captions',
            'No captions yet. They appear here when you publish a recording from the app with AI captions on.'
          )}
        </div>
      )}
      <div className="flex flex-col gap-[12px]">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-[16px] flex-wrap bg-newBgColorInner rounded-[12px] p-[16px] border border-newTableBorder"
          >
            <div className="flex flex-col flex-1 min-w-[160px]">
              <div className="font-[600] break-words">
                {item.title || t('untitled_recording', 'Untitled recording')}
              </div>
              <div className="text-textItemBlur text-[13px]">
                {captionDate(item.createdAt)}
              </div>
            </div>
            <div className="flex items-center gap-[10px]">
              {item.channels.slice(0, MAX_CHANNELS).map((channel) => (
                <ChannelAvatar
                  key={channel.integrationId}
                  provider={channel.provider}
                  picture={channel.picture}
                />
              ))}
              {item.channels.length > MAX_CHANNELS && (
                <span className="text-textItemBlur text-[13px]">
                  +{item.channels.length - MAX_CHANNELS}
                </span>
              )}
            </div>
            <div className="min-w-[150px] text-end">
              <CaptionStatus status={item.status} />
            </div>
            <Button secondary onClick={() => onOpen(item.id)}>
              {t('open', 'Open')}
            </Button>
          </div>
        ))}
      </div>
      {data.length < last.pages && (
        <Button
          secondary
          loading={isValidating}
          onClick={() => setSize(size + 1)}
        >
          {t('load_more', 'Load more')}
        </Button>
      )}
    </div>
  );
};

// The page: the list, or the caption `?open=` names.
export const AiCaptionsComponent: FC = () => {
  const search = useSearchParams();
  const router = useWorkspaceRouter();
  const openId = search.get('open');
  const open = useCallback(
    (id: string) => router.push(`/ai-captions?open=${encodeURIComponent(id)}`),
    [router]
  );
  const close = useCallback(() => router.push('/ai-captions'), [router]);

  return openId ? (
    <AiCaptionDetailView id={openId} onClose={close} />
  ) : (
    <AiCaptionList onOpen={open} />
  );
};
