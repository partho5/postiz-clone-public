'use client';

// AI captions (ai.video-captions): one caption. The transcript, the text written for each channel, where the post
// made from it stands, and Delete. "Edit post" opens the scheduled post in the editor, and only while it is still
// waiting for a date to come.
import React, { FC, useCallback } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useIntegrationList } from '@gitroom/frontend/components/launches/helpers/use.integration.list';
import { useOpenReservedPost } from '@gitroom/frontend/components/credits/balance/use.open.reserved.post';
import {
  AiCaptionOutput,
  useAiCaption,
} from '@gitroom/frontend/components/ai-captions/use.ai.captions';
import {
  CaptionStatus,
  captionDate,
  ChannelAvatar,
  CopyTextButton,
} from '@gitroom/frontend/components/ai-captions/ai.caption.parts';

// Whether the post made from this text still waits in the queue for a date that has not come.
const isScheduled = (output: AiCaptionOutput) =>
  output.postState === 'QUEUE' &&
  !!output.publishDate &&
  new Date(output.publishDate).getTime() > Date.now();

// The text written for one channel, with the post made from it.
const OutputCard: FC<{
  output: AiCaptionOutput;
  name?: string;
  picture?: string | null;
  onEdit: (group: string) => void;
}> = ({ output, name, picture, onEdit }) => {
  const t = useT();
  const scheduled = isScheduled(output);
  // only a scheduled post can be opened in the editor
  const editable = scheduled && !!output.postGroup;
  const date = output.publishDate ? captionDate(output.publishDate) : '';

  return (
    <div className="flex flex-col gap-[12px] bg-newBgColorInner rounded-[12px] p-[16px] border border-newTableBorder">
      <div className="flex items-center gap-[12px]">
        <ChannelAvatar
          provider={output.provider}
          picture={picture}
          name={name}
        />
        <div className="flex-1 min-w-0 flex items-center gap-[8px]">
          <span className="font-[600] truncate">{name || output.provider}</span>
          <span className="text-[12px] text-textItemBlur border border-newBorder rounded-[4px] px-[6px] shrink-0">
            {output.kind === 'video'
              ? t('caption_kind_video', 'Video caption')
              : t('caption_kind_text', 'Text post')}
          </span>
        </div>
        <CopyTextButton text={output.text} label={t('copy', 'Copy')} />
      </div>
      {output.title && (
        <div className="flex items-start gap-[12px]">
          <div className="flex-1 min-w-0">
            <div className="text-[12px] text-textItemBlur">
              {t('caption_title', 'Title')}
            </div>
            <div className="font-[600] break-words">{output.title}</div>
          </div>
          <CopyTextButton
            text={output.title}
            label={t('copy_title', 'Copy title')}
          />
        </div>
      )}
      <div className="whitespace-pre-wrap break-words text-[14px]">
        {output.text}
      </div>
      <div className="flex items-center gap-[12px] border-t border-newTableBorder pt-[12px]">
        <div className="flex-1 text-[13px] text-textItemBlur">
          {!output.postId && t('caption_no_post', 'Not used in a post yet')}
          {!!output.postId &&
            !output.postState &&
            t('caption_post_deleted', 'The post was deleted')}
          {scheduled &&
            `${t('caption_post_scheduled', 'Scheduled for')} ${date}`}
          {output.postState === 'QUEUE' &&
            !scheduled &&
            t('caption_post_going_out', 'The post is going out now')}
          {output.postState === 'PUBLISHED' &&
            `${t('caption_post_published', 'Published')} ${date}`}
          {output.postState === 'ERROR' &&
            t('caption_post_error', 'The post could not be published')}
          {output.postState === 'DRAFT' &&
            t('caption_post_draft', 'The post is a draft')}
        </div>
        {editable && (
          <Button secondary onClick={() => onEdit(output.postGroup!)}>
            {t('caption_edit_post', 'Edit post')}
          </Button>
        )}
      </div>
    </div>
  );
};

// One caption of the workspace; `onClose` goes back to the list (also after a delete).
export const AiCaptionDetailView: FC<{ id: string; onClose: () => void }> = ({
  id,
  onClose,
}) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const { data, error, isLoading, mutate } = useAiCaption(id);
  const { data: integrations } = useIntegrationList();
  // Reads the caption again after its post was saved in the editor, or found missing.
  const reload = useCallback(() => {
    mutate();
  }, [mutate]);
  const openPost = useOpenReservedPost(reload);

  const remove = useCallback(async () => {
    if (
      !(await deleteDialog(
        t(
          'are_you_sure_delete_caption',
          'Delete this caption? Its transcript and texts are removed. Posts that were already made are not changed.'
        )
      ))
    ) {
      return;
    }
    try {
      const response = await fetch(`/ai-captions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(`DELETE /ai-captions answered ${response.status}`);
      }
    } catch {
      toaster.show(
        t('failed_to_delete_caption', 'Failed to delete the caption'),
        'warning'
      );
      return;
    }
    toaster.show(t('caption_deleted', 'Caption deleted'), 'success');
    onClose();
  }, [fetch, id, onClose, t, toaster]);

  if (isLoading) {
    return <LoadingComponent />;
  }
  if (error || !data) {
    return (
      <div className="flex flex-col gap-[16px] items-start">
        <div className="text-red-400">
          {t(
            'caption_unavailable',
            'This caption could not be loaded. It may have been deleted.'
          )}
        </div>
        <Button secondary onClick={onClose}>
          {t('back', 'Back')}
        </Button>
      </div>
    );
  }

  // The channel with this id, while the workspace still has it.
  const channel = (integrationId: string) =>
    integrations.find((i: any) => i.id === integrationId);

  return (
    <div className="flex flex-col gap-[16px]">
      <div className="flex items-center gap-[12px] flex-wrap">
        <Button secondary onClick={onClose}>
          {t('back', 'Back')}
        </Button>
        <div className="flex-1 min-w-0">
          <div className="text-[24px] font-[600] truncate">
            {data.title || t('untitled_recording', 'Untitled recording')}
          </div>
          <div className="flex items-center gap-[8px] text-[13px] text-textItemBlur">
            <span>{captionDate(data.createdAt)}</span>
            <span>·</span>
            <CaptionStatus status={data.status} />
          </div>
        </div>
        <Button secondary onClick={remove}>
          {t('delete', 'Delete')}
        </Button>
      </div>

      {!!data.error && <div className="text-red-400">{data.error}</div>}
      {data.status !== 'READY' &&
        data.status !== 'FAILED' &&
        data.status !== 'NO_SPEECH' && (
          <div className="text-textItemBlur">
            {t(
              'caption_in_progress',
              'The captions are being written. This page updates by itself.'
            )}
          </div>
        )}

      {!!data.transcript && (
        <div className="flex flex-col gap-[12px] bg-newBgColorInner rounded-[12px] p-[16px] border border-newTableBorder">
          <div className="flex items-center gap-[12px]">
            <div className="flex-1 text-[16px] font-[600]">
              {t('caption_transcript', 'Transcript')}
            </div>
            <CopyTextButton
              text={data.transcript}
              label={t('copy', 'Copy')}
            />
          </div>
          <div className="whitespace-pre-wrap break-words text-[14px] max-h-[40vh] overflow-auto">
            {data.transcript}
          </div>
        </div>
      )}

      {data.status === 'READY' && !data.outputs.length && (
        <div className="text-textItemBlur">
          {t(
            'caption_no_texts',
            'No text was written for the channels of this recording.'
          )}
        </div>
      )}
      {data.outputs.map((output) => (
        <OutputCard
          key={output.integrationId}
          output={output}
          name={channel(output.integrationId)?.name}
          picture={channel(output.integrationId)?.picture}
          onEdit={openPost}
        />
      ))}
    </div>
  );
};
