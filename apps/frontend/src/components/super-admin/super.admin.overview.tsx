'use client';

import { FC } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  AddAnnouncement,
  ImpersonateUsers,
  ImportDebugPost,
} from '@gitroom/frontend/components/layout/impersonate';

// Super admin landing page: starts an impersonation and holds the actions that need no page of their own.
export const SuperAdminOverview: FC = () => {
  const t = useT();

  return (
    <div className="flex flex-col gap-[20px] text-textColor w-full min-w-0">
      <div className="text-[20px] font-[600]">
        {t('super_admin', 'Super Admin')}
      </div>
      <ImpersonateUsers />
      <div className="flex flex-wrap gap-[10px] items-center [&>div]:py-[8px]">
        <ImportDebugPost />
        <AddAnnouncement />
      </div>
    </div>
  );
};
