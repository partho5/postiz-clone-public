// Feature: Main Dashboard Shell Layout Component
'use client';

import React, { ReactNode, useCallback, useEffect, useState } from 'react';
import { Logo } from '@gitroom/frontend/components/new-layout/logo';
import { Plus_Jakarta_Sans } from 'next/font/google';
const ModeComponent = dynamic(
  () => import('@gitroom/frontend/components/layout/mode.component'),
  {
    ssr: false,
  }
);

import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import useSWR from 'swr';
import { ToolTip } from '@gitroom/frontend/components/layout/top.tip';
import { ShowMediaBoxModal } from '@gitroom/frontend/components/media/media.component';
import { ShowLinkedinCompany } from '@gitroom/frontend/components/launches/helpers/linkedin.component';
import { MediaSettingsLayout } from '@gitroom/frontend/components/launches/helpers/media.settings.component';
import { Toaster } from '@gitroom/react/toaster/toaster';
import { ShowPostSelector } from '@gitroom/frontend/components/post-url-selector/post.url.selector';
import { NewSubscription } from '@gitroom/frontend/components/layout/new.subscription';
import { Support } from '@gitroom/frontend/components/layout/support';
import { ContinueProvider } from '@gitroom/frontend/components/layout/continue.provider';
import { ContextWrapper } from '@gitroom/frontend/components/layout/user.context';
import { CopilotKit } from '@copilotkit/react-core';
import { MantineWrapper } from '@gitroom/react/helpers/mantine.wrapper';
import { ImpersonateStrip } from '@gitroom/frontend/components/layout/impersonate';
import { AnnouncementBanner } from '@gitroom/frontend/components/layout/announcement.banner';
import { Title } from '@gitroom/frontend/components/layout/title';
import { TopMenu, MobileNavigation } from '@gitroom/frontend/components/layout/top.menu';
import { LanguageComponent } from '@gitroom/frontend/components/layout/language.component';
import NotificationComponent from '@gitroom/frontend/components/notifications/notification.component';
import { BrandBadge } from '@gitroom/frontend/components/brand/switcher/brand.badge';
import { BrandSwitcher } from '@gitroom/frontend/components/brand/switcher/brand.switcher';
import { StreakComponent } from '@gitroom/frontend/components/layout/streak.component';
import { BalanceHeader } from '@gitroom/frontend/components/credits/balance/balance.header';
import { PreConditionComponent } from '@gitroom/frontend/components/layout/pre-condition.component';
import { AttachToFeedbackIcon } from '@gitroom/frontend/components/new-layout/sentry.feedback.component';
import { TrialTracker } from '@gitroom/frontend/components/layout/gtm.component';
import { setSentryUser } from '@gitroom/react/sentry/initialize.sentry.client';
import { useWorkspaceSession } from '@gitroom/frontend/components/layout/workspace.navigation';
import { DashboardLoader } from '@gitroom/frontend/components/layout/dashboard.loader';

const jakartaSans = Plus_Jakarta_Sans({
  weight: ['600', '500', '700'],
  style: ['normal', 'italic'],
  subsets: ['latin'],
});

// Renders the main dashboard shell including providers, navigation menus, header, and page content.
export const LayoutComponent = ({ children }: { children: ReactNode }) => {
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [brandSwitcherOpen, setBrandSwitcherOpen] = useState(false);
  const fetch = useFetch();

  const { backendUrl } = useVariables();

  // Feedback icon component attaches Sentry feedback to a top-bar icon when DSN is present
  const load = useCallback(async (path: string) => {
    return await (await fetch(path)).json();
  }, []);
  const { data: user } = useSWR('/user/self', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    refreshWhenOffline: false,
    refreshWhenHidden: false,
  });

  useWorkspaceSession(user);

  useEffect(() => {
    setSentryUser(
      user ? { id: user.id, email: user.email, orgId: user.orgId } : null
    );
  }, [user]);

  if (!user) return <DashboardLoader />;

  return (
    <ContextWrapper user={user}>
      <CopilotKit
        credentials="include"
        runtimeUrl={backendUrl + '/copilot/chat'}
        headers={{ 'x-workspace-id': user.orgId, 'x-session-user': user.id }}
        useSingleEndpoint={true}
        showDevConsole={false}
      >
        <MantineWrapper>
          <ToolTip />
          <Toaster />
          <TrialTracker />
          <ShowMediaBoxModal />
          <ShowLinkedinCompany />
          <MediaSettingsLayout />
          <ShowPostSelector />
          <PreConditionComponent />
          <NewSubscription />
          <ContinueProvider />
          <div
            className={clsx(
              'flex flex-col w-full min-h-screen overflow-x-hidden text-newTextColor p-[2px] sm:p-[12px]',
              jakartaSans.className
            )}
          >
            <div>{user?.isSuperAdmin && user?.impersonate ? <ImpersonateStrip /> : <div />}</div>
            <>
              <AnnouncementBanner />
              <div className="flex-1 flex gap-[8px]">
                <Support />
                <MobileNavigation
                  isOpen={mobileDrawerOpen}
                  onOpen={() => setMobileDrawerOpen(true)}
                  onClose={() => setMobileDrawerOpen(false)}
                  onBrandClick={() => setBrandSwitcherOpen(true)}
                />
                <div
                  className={clsx(
                    'hidden md:flex flex-col bg-newBgColorInner w-[80px] rounded-[12px]'
                  )}
                >
                  <div
                    id="left-menu"
                    className={clsx(
                      'fixed h-full w-[64px] start-[17px] flex flex-1 top-0',
                      user?.isSuperAdmin && user?.impersonate && 'pt-[60px] max-h-[1000px]:w-[500px]'
                    )}
                  >
                    <div className="flex flex-col h-full gap-[32px] flex-1 py-[12px]">
                      <Logo />
                      <TopMenu />
                    </div>
                  </div>
                </div>
                <div className="flex-1 bg-newBgLineColor rounded-[12px] overflow-hidden flex flex-col gap-[1px] blurMe">
                  <div className="flex bg-newBgColorInner h-[60px] px-[12px] md:h-[80px] md:px-[20px] items-center justify-between">
                    <div className="text-[18px] md:text-[24px] font-[600] flex flex-1 min-w-0 items-center gap-[8px]">
                      <div className="truncate min-w-0">
                        <Title />
                      </div>
                      <div className="hidden sm:flex md:hidden items-center max-w-[120px] truncate text-[14px] font-normal [&>div:last-child]:hidden">
                        <BrandBadge onClick={() => setBrandSwitcherOpen(true)} />
                      </div>
                    </div>
                    <div className="flex items-center gap-[8px] sm:gap-[12px] md:gap-[20px] text-textItemBlur">
                      <div className="text-[12px] sm:text-[14px] shrink-0">
                        <BalanceHeader />
                      </div>
                      <div className="hidden md:block">
                        <StreakComponent />
                      </div>
                      <div className="hidden md:block w-[1px] h-[20px] bg-blockSeparator" />
                      <div className="hidden md:block">
                        <BrandBadge onClick={() => setBrandSwitcherOpen(true)} />
                      </div>
                      <BrandSwitcher
                        isOpen={brandSwitcherOpen}
                        onOpen={() => setBrandSwitcherOpen(true)}
                        onClose={() => setBrandSwitcherOpen(false)}
                      />
                      <div className="hover:text-newTextColor shrink-0">
                        <ModeComponent />
                      </div>
                      <div className="hidden md:block w-[1px] h-[20px] bg-blockSeparator" />
                      <div className="hidden md:block">
                        <LanguageComponent />
                      </div>
                      <div className="hidden md:block w-[1px] h-[20px] bg-blockSeparator" />
                      <div className="hidden md:block">
                        <AttachToFeedbackIcon />
                      </div>
                      <div className="shrink-0">
                        <NotificationComponent />
                      </div>
                      <div className="sm:hidden flex items-center gap-[8px] [&>div:last-child]:hidden">
                        <BrandBadge
                          compact
                          onClick={() => setBrandSwitcherOpen(true)}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setMobileDrawerOpen(true)}
                        className="md:hidden p-[4px] text-textItemBlur hover:text-newTextColor flex items-center justify-center shrink-0"
                        aria-label="Open menu"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="3" y1="12" x2="21" y2="12" />
                          <line x1="3" y1="6" x2="21" y2="6" />
                          <line x1="3" y1="18" x2="21" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-1 gap-[1px] pb-[70px] md:pb-0">{children}</div>
                </div>
              </div>
            </>
          </div>
        </MantineWrapper>
      </CopilotKit>
    </ContextWrapper>
  );
};
