'use client';

import { FC } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import Spinner from '@gitroom/frontend/components/layout/loading';

// Each message is shown from its start second until the next one starts; the last stays.
// Timing lives in CSS animations, so the sequence also runs before the page's scripts have loaded.
const MESSAGE_START_SECONDS = [0, 1, 2, 6, 12];

// Full-screen loader shown while the dashboard shell waits for the signed-in user, so the page never looks blank
export const DashboardLoader: FC = () => {
  const t = useT();
  const messages = [
    t('dashboard_loading', 'Loading...'),
    t('dashboard_fetching_your_data', 'Fetching your data...'),
    t('dashboard_almost_ready', 'Almost ready...'),
    t('dashboard_taking_longer', 'Taking a little longer than usual...'),
    t('dashboard_still_working', 'Still working, please keep this tab open...'),
  ];

  return (
    <div className="flex flex-1 min-h-screen flex-col items-center justify-center gap-[24px]">
      <Spinner width={56} height={56} />
      <div className="grid text-center text-[16px] text-textColor px-[16px]">
        {messages.map((message, index) => {
          const isLast = index === messages.length - 1;
          const start = MESSAGE_START_SECONDS[index];
          return (
            <div
              key={index}
              className="boot-message col-start-1 row-start-1"
              style={{
                animationName: isLast ? 'boot-in' : 'boot-in, boot-out',
                animationDelay: isLast
                  ? `${start}s`
                  : `${start}s, ${MESSAGE_START_SECONDS[index + 1]}s`,
              }}
            >
              {message}
            </div>
          );
        })}
      </div>
    </div>
  );
};
