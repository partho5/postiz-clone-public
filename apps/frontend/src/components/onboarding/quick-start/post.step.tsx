'use client';

// Quick start, step 3: opens the existing post editor on the connected channel, dated to the
// next free slot; the editor shows the cost and schedules through the existing create path.
import { FC, useCallback } from 'react';
import dayjs from 'dayjs';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { AddEditModal } from '@gitroom/frontend/components/new-launch/add.edit.modal';
import type { Integrations } from '@gitroom/frontend/components/launches/calendar.context';

// The step: a control that opens the editor for the channel; `onScheduled` runs when the editor saved a post.
export const PostStep: FC<{
  channels: Integrations[];
  onScheduled: () => void;
}> = ({ channels, onScheduled }) => {
  const fetch = useFetch();
  const modal = useModals();
  const t = useT();

  // Reads the next free slot and opens the editor with the first channel selected and that date.
  const openEditor = useCallback(async () => {
    const date = (await (await fetch('/posts/find-slot')).json()).date;
    modal.openModal({
      id: 'add-edit-modal',
      closeOnClickOutside: false,
      removeLayout: true,
      closeOnEscape: false,
      withCloseButton: false,
      askClose: true,
      fullScreen: true,
      classNames: {
        modal: 'w-[100%] max-w-[1400px] text-textColor',
      },
      children: (
        <AddEditModal
          allIntegrations={channels}
          integrations={channels}
          selectedChannels={[channels[0].id]}
          reopenModal={openEditor}
          mutate={onScheduled}
          date={dayjs.utc(date).local()}
        />
      ),
      size: '80%',
      title: ``,
    });
  }, [channels, fetch, modal, onScheduled]);

  return (
    <div className="flex flex-col gap-[8px]">
      <h2 className="text-[18px]">
        {t('quick_start_post_title', 'Schedule your first post')}
      </h2>
      <div className="text-textItemBlur text-[14px]">
        {t(
          'quick_start_post_text',
          'Write a post for your channel. It is dated to your next free slot, and its cost is shown before you confirm.'
        )}
      </div>
      <div className="flex gap-[8px] mt-[8px]">
        <Button onClick={openEditor}>
          {t('quick_start_write_post', 'Write a post')}
        </Button>
      </div>
    </div>
  );
};
