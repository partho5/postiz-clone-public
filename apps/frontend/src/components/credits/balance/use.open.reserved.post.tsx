'use client';

// Balance header: opens the post a reservation is held for, by its group, in the post editor.
import React, { useCallback } from 'react';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { AddEditModal } from '@gitroom/frontend/components/new-launch/add.edit.modal';
import { ExistingDataContextProvider } from '@gitroom/frontend/components/launches/helpers/use.existing.data';
import { useIntegrationList } from '@gitroom/frontend/components/launches/helpers/use.integration.list';
import { mutateCreditBalance } from '@gitroom/frontend/components/credits/balance/use.credit.balance';

dayjs.extend(utc);

// Returns a function that opens the post of a group in the editor; `onChange` runs after the post
// is saved or when it no longer exists, so the list can load again.
export const useOpenReservedPost = (onChange: () => void) => {
  const t = useT();
  const fetch = useFetch();
  const modals = useModals();
  const toaster = useToaster();
  const { data: integrations } = useIntegrationList();

  const open: (group: string) => Promise<void> = useCallback(
    async (group: string) => {
      const data = await (await fetch(`/posts/group/${group}`)).json();
      if (!data?.posts?.length) {
        toaster.show(t('post_not_found', 'Post not found'), 'warning');
        onChange();
        return;
      }
      modals.openModal({
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
          <ExistingDataContextProvider value={data}>
            <AddEditModal
              allIntegrations={integrations.map((p: any) => ({ ...p }))}
              reopenModal={() => open(group)}
              mutate={() => {
                mutateCreditBalance();
                onChange();
              }}
              integrations={integrations
                .filter((f: any) => f.id === data.integration)
                .map((p: any) => ({ ...p, picture: data.integrationPicture }))}
              date={dayjs.utc(data.posts[0].publishDate).local()}
            />
          </ExistingDataContextProvider>
        ),
        size: '80%',
        title: ``,
      });
    },
    [integrations, fetch, modals, toaster, t, onChange]
  );

  return open;
};
