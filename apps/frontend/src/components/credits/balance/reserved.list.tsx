// Feature: Reserved Credits Ledger and Post Links
'use client';

// Balance header: the page the header's Reserved number links to, listing the posts the
// workspace's reserved credits are held for, each opening its post.
import React, { FC } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { newDayjs } from '@gitroom/frontend/components/layout/set.timezone';
import { isUSCitizen } from '@gitroom/frontend/components/launches/helpers/isuscitizen.utils';
import { useIntegrationList } from '@gitroom/frontend/components/launches/helpers/use.integration.list';
import { useReservations } from '@gitroom/frontend/components/credits/balance/use.reservations';
import { useOpenReservedPost } from '@gitroom/frontend/components/credits/balance/use.open.reserved.post';

// The reserved credits of this workspace, newest first, with a note for what other workspaces hold.
export const ReservedList: FC = () => {
  const t = useT();
  const { data, error, isLoading, size, setSize, mutate } = useReservations();
  const { data: integrations } = useIntegrationList();
  const openPost = useOpenReservedPost(mutate);

  if (isLoading) {
    return <LoadingComponent />;
  }
  if (error || !data) {
    return (
      <div className="text-red-400">
        {t('reservations_unavailable', 'Reserved credits could not be loaded.')}
      </div>
    );
  }

  const items = data.flatMap((page) => page.items);
  const last = data[data.length - 1];
  // The name of the channel with this id, when the workspace has it.
  const channelName = (id?: string) =>
    integrations.find((i: any) => i.id === id)?.name;

  return (
    <div className="flex flex-col gap-[16px]">
      <div className="text-[24px] font-[600]">
        {t('reserved_credits', 'Reserved credits')}
      </div>
      {data[0].otherWorkspacesReserved > 0 && (
        <div className="text-textItemBlur">
          {data[0].otherWorkspacesReserved}{' '}
          {t(
            'reserved_in_other_workspaces',
            'more credits are reserved by your other workspaces.'
          )}
        </div>
      )}
      {!items.length && (
        <div className="text-textItemBlur">
          {t('nothing_reserved', 'Nothing is reserved in this workspace.')}
        </div>
      )}
      <div className="flex flex-col gap-[12px]">
        {items.map((item) => (
          <div
            key={item.ledgerId}
            className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-[12px] sm:gap-[16px] bg-newBgColorInner rounded-[12px] p-[12px] sm:p-[16px] border border-newTableBorder"
          >
            <div className="flex flex-col min-w-0">
              <div className="font-[600] break-words">
                {(item.postId && channelName(item.integrationId)) ||
                  item.actionKey}
                {item.occurrence && item.occurrence > 1
                  ? ` · ${t('repeat', 'Repeat')} ${item.occurrence}`
                  : ''}
              </div>
              {item.publishDate && (
                <div className="text-textItemBlur text-[14px]">
                  {newDayjs(item.publishDate)
                    .local()
                    .format(isUSCitizen() ? 'MM/DD hh:mm A' : 'DD/MM HH:mm')}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between sm:justify-end w-full sm:w-auto gap-[16px] shrink-0">
              <div className="font-[600]">
                {item.amount} {t('credits', 'credits')}
              </div>
              {item.group && (
                <Button
                  secondary={true}
                  className="min-h-[44px] sm:min-h-0"
                  onClick={() => openPost(item.group!)}
                >
                  {t('open_post', 'Open')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {last.nextCursor && (
        <Button
          secondary={true}
          className="min-h-[44px]"
          onClick={() => setSize(size + 1)}
        >
          {t('load_more', 'Load more')}
        </Button>
      )}
    </div>
  );
};
