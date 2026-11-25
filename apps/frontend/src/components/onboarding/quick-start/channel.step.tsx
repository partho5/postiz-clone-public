'use client';

// Quick start, step 2: opens the existing channel-connect flow, marked so its return lands on quick start.
import { FC, useCallback } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useAddProvider } from '@gitroom/frontend/components/launches/add.provider.component';
import { markQuickStartConnect } from '@gitroom/frontend/components/onboarding/quick-start/quick.start.connect';

// The step: what connecting a channel does for the person, and the control that starts the connect.
export const ChannelStep: FC = () => {
  const t = useT();
  const openConnect = useAddProvider();

  // Marks the connect as started here, then opens the channel picker.
  const connect = useCallback(async () => {
    markQuickStartConnect();
    await openConnect();
  }, [openConnect]);

  return (
    <div className="flex flex-col gap-[8px]">
      <h2 className="text-[18px]" data-testid="quick-start-channel-title">
        {t('quick_start_channel_title', 'Connect a channel')}
      </h2>
      <div className="text-textItemBlur text-[14px]">
        {t(
          'quick_start_channel_text',
          'Pick the social account you want to post to. Your free monthly credits are added when your first channel connects.'
        )}
      </div>
      <div className="flex gap-[8px] mt-[8px]">
        <Button onClick={connect}>
          {t('quick_start_connect', 'Connect a channel')}
        </Button>
      </div>
    </div>
  );
};
