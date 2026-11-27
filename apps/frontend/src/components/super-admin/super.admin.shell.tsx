'use client';

import { FC, ReactNode } from 'react';
import clsx from 'clsx';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  useWorkspacePathname,
  WorkspaceLink,
} from '@gitroom/frontend/components/layout/workspace.navigation';

// The pages of the super admin area, shown as tabs on every one of them
const useSuperAdminTabs = () => {
  const t = useT();
  return [
    { path: '/super-admin', name: t('overview', 'Overview') },
    { path: '/super-admin/stats', name: t('view_stats', 'View Stats') },
    { path: '/super-admin/errors', name: t('view_errors', 'View Errors') },
    { path: '/super-admin/activity', name: t('view_activity', 'Activity') },
    { path: '/super-admin/prompts', name: t('view_prompts', 'View Prompts') },
  ];
};

// Frames every super admin page with its tabs. The proxy already closed the URL to everyone else;
// this only keeps the shell empty for a session that is not a super admin.
export const SuperAdminShell: FC<{ children: ReactNode }> = ({ children }) => {
  const user = useUser();
  const path = useWorkspacePathname();
  const tabs = useSuperAdminTabs();
  const t = useT();

  if (!user?.isSuperAdmin) {
    return null;
  }

  // While impersonating, the admin APIs answer for the impersonated account, so every page waits
  if (user.impersonate) {
    return (
      <div className="bg-newBgColorInner flex-1 text-textColor p-[20px]">
        {t(
          'stop_impersonating_first',
          'Stop impersonating (the X in the strip above) to use the super admin tools.'
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-w-0 gap-[1px]">
      <div className="bg-newBgColorInner flex gap-[8px] px-[20px] pt-[12px] overflow-x-auto">
        {tabs.map((tab) => (
          <WorkspaceLink
            key={tab.path}
            href={tab.path}
            className={clsx(
              'px-[12px] py-[8px] rounded-[8px] text-[14px] font-[600] whitespace-nowrap transition-colors hover:text-textItemFocused hover:bg-boxFocused',
              path === tab.path
                ? 'text-textItemFocused bg-boxFocused'
                : 'text-textItemBlur'
            )}
          >
            {tab.name}
          </WorkspaceLink>
        ))}
      </div>
      {children}
    </div>
  );
};
