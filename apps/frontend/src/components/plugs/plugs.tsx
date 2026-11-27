// Feature: Plugs - Channel Automations & Plug Management
'use client';

import useSWR from 'swr';
import { useCallback, useMemo, useState } from 'react';
import { orderBy } from 'lodash';
import clsx from 'clsx';
import ImageWithFallback from '@gitroom/react/helpers/image.with.fallback';
import SafeImage from '@gitroom/react/helpers/safe.image';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { PlugsContext } from '@gitroom/frontend/components/plugs/plugs.context';
import { Plug } from '@gitroom/frontend/components/plugs/plug';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import useCookie from 'react-use-cookie';
import { SVGLine } from '@gitroom/frontend/components/launches/launches.component';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useWorkspaceRouter } from '@gitroom/frontend/components/layout/workspace.navigation';

// Renders connected channel selectors and plug automations for the selected channel.
export const Plugs = () => {
  const fetch = useFetch();
  const router = useWorkspaceRouter();
  const [current, setCurrent] = useState(0);
  const [refresh, setRefresh] = useState(false);
  const toaster = useToaster();

  // Fetches list of all connected social channel integrations.
  const load = useCallback(async () => {
    return (await (await fetch('/integrations/list')).json()).integrations;
  }, []);

  // Fetches definitions of all available plugs.
  const load2 = useCallback(async (path: string) => {
    return await (await fetch(path)).json();
  }, []);

  const { data: plugList, isLoading: plugLoading } = useSWR(
    '/integrations/plug/list',
    load2,
    {
      fallbackData: [],
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      revalidateOnMount: true,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    }
  );

  const { data, isLoading } = useSWR('analytics-list', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    fallbackData: [],
  });

  const [collapseMenu, setCollapseMenu] = useCookie('collapseMenu', '0');
  const t = useT();

  const sortedIntegrations = useMemo(() => {
    return orderBy(
      data.filter((integration: any) =>
        plugList?.plugs?.some(
          (f: any) => f.identifier === integration.identifier
        )
      ),
      ['type', 'disabled', 'identifier'],
      ['desc', 'asc', 'asc']
    );
  }, [data, plugList]);

  const currentIntegration = useMemo(() => {
    return sortedIntegrations[current];
  }, [current, sortedIntegrations]);

  const currentIntegrationPlug = useMemo(() => {
    const plug = plugList?.plugs?.find(
      (f: any) => f?.identifier === currentIntegration?.identifier
    );
    if (!plug) {
      return null;
    }
    return {
      providerId: currentIntegration.id,
      ...plug,
    };
  }, [currentIntegration, plugList]);

  // Handles channel selection and updates active plug context.
  const selectChannel = useCallback(
    (index: number, integration: any) => {
      if (integration.refreshNeeded) {
        toaster.show(
          'Please refresh the integration from the calendar',
          'warning'
        );
        return;
      }
      setRefresh(true);
      setTimeout(() => {
        setRefresh(false);
      }, 10);
      setCurrent(index);
    },
    [toaster]
  );

  if (isLoading || plugLoading) {
    return (
      <div className="bg-newBgColorInner p-[20px] flex flex-1 flex-col gap-[15px] transition-all items-center justify-center">
        <LoadingComponent />
      </div>
    );
  }

  if (!sortedIntegrations.length && !isLoading) {
    return (
      <div className="bg-newBgColorInner p-[16px] sm:p-[20px] flex flex-1 flex-col gap-[15px] transition-all items-center justify-center text-center">
        <div>
          <img
            src="/peoplemarketplace.svg"
            alt="No plugs"
            className="max-w-[200px] sm:max-w-[280px]"
          />
        </div>
        <div className="text-[22px] sm:text-[32px] lg:text-[48px] font-[600] leading-tight">
          {t(
            'there_are_not_plugs_matching_your_channels',
            'There are not plugs matching your channels'
          )}
          <br />
          <span className="text-[15px] sm:text-[20px] font-normal text-textItemBlur">
            {t(
              'you_have_to_add_x_linkedin_page_threads_or_bluesky',
              'You have to add: X, LinkedIn Page, Threads or Bluesky'
            )}
          </span>
        </div>
        <Button onClick={() => router.push('/launches')}>
          {t(
            'go_to_the_calendar_to_add_channels',
            'Go to the calendar to add channels'
          )}
        </Button>
      </div>
    );
  }

  return (
    <>
      {/* Desktop Fixed Channel Sidebar (>= lg) */}
      <div
        className={clsx(
          'hidden lg:flex bg-newBgColorInner p-[20px] flex-col gap-[15px] transition-all shrink-0',
          collapseMenu === '1' ? 'group sidebar w-[100px]' : 'w-[260px]'
        )}
      >
        <div className="flex gap-[12px] flex-col">
          <div className="flex items-center">
            <h2 className="group-[.sidebar]:hidden flex-1 text-[20px] font-[500]">
              {t('channels')}
            </h2>
            <div
              onClick={() => setCollapseMenu(collapseMenu === '1' ? '0' : '1')}
              className="group-[.sidebar]:rotate-[180deg] group-[.sidebar]:mx-auto text-btnText bg-btnSimple rounded-[6px] w-[24px] h-[24px] flex items-center justify-center cursor-pointer select-none"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="7"
                height="13"
                viewBox="0 0 7 13"
                fill="none"
              >
                <path
                  d="M6 11.5L1 6.5L6 1.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>
          {sortedIntegrations.map((integration, index) => (
            <div
              key={integration.id}
              onClick={() => selectChannel(index, integration)}
              className={clsx(
                'flex gap-[8px] items-center justify-center group/profile hover:bg-boxHover rounded-e-[8px]',
                currentIntegration?.id !== integration.id &&
                  'opacity-20 hover:opacity-100 cursor-pointer'
              )}
            >
              <div
                className={clsx(
                  'relative rounded-full flex justify-center items-center gap-[8px]',
                  integration.disabled && 'opacity-50'
                )}
              >
                {(integration.inBetweenSteps || integration.refreshNeeded) && (
                  <div className="absolute start-0 top-0 w-[39px] h-[46px] cursor-pointer">
                    <div className="bg-red-500 w-[15px] h-[15px] rounded-full start-0 -top-[5px] absolute z-[200] text-[10px] flex justify-center items-center">
                      !
                    </div>
                    <div className="bg-primary/60 w-[39px] h-[46px] start-0 top-0 absolute rounded-full z-[199]" />
                  </div>
                )}
                <div className="h-full w-[4px] -ms-[12px] rounded-s-[3px] opacity-0 group-hover/profile:opacity-100 transition-opacity">
                  <SVGLine />
                </div>
                <ImageWithFallback
                  fallbackSrc={`/icons/platforms/${integration.identifier}.png`}
                  src={integration.picture}
                  className="rounded-[8px]"
                  alt={integration.identifier}
                  width={36}
                  height={36}
                />
                <SafeImage
                  src={`/icons/platforms/${integration.identifier}.png`}
                  className="rounded-[8px] absolute z-10 bottom-[5px] -end-[5px] border border-fifth"
                  alt={integration.identifier}
                  width={18.41}
                  height={18.41}
                />
              </div>
              <div
                className={clsx(
                  'flex-1 whitespace-nowrap text-ellipsis overflow-hidden group-[.sidebar]:hidden',
                  integration.disabled && 'opacity-50'
                )}
              >
                {integration.name}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main Plugs Content Area */}
      <div className="bg-newBgColorInner flex-1 flex-col flex p-[12px] sm:p-[20px] gap-[12px] min-w-0 overflow-hidden">
        {/* Mobile Horizontal Channel Selector (< lg) */}
        {sortedIntegrations.length > 0 && (
          <div className="flex lg:hidden flex-col gap-[8px] shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-[500] text-textItemBlur">
                {t('channels', 'Channels')} ({sortedIntegrations.length})
              </span>
              <button
                type="button"
                onClick={() => router.push('/launches')}
                className="flex items-center gap-[4px] text-[12px] text-btnPrimary hover:underline"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
                <span>{t('connect_channel', 'Connect channel')}</span>
              </button>
            </div>
            <div className="overflow-x-auto scrollbar-none flex gap-[8px] py-[4px] -mx-[4px] px-[4px]">
              {sortedIntegrations.map((integration, index) => {
                const isSelected = currentIntegration?.id === integration.id;
                return (
                  <button
                    key={`mobile-plug-pill-${integration.id}`}
                    type="button"
                    onClick={() => selectChannel(index, integration)}
                    className={clsx(
                      'shrink-0 flex items-center gap-[8px] px-[10px] py-[6px] rounded-[8px] border text-[13px] transition-all select-none',
                      isSelected
                        ? 'bg-btnPrimary/15 border-btnPrimary text-newTextColor font-[500]'
                        : 'bg-newTableHeader border-newTableBorder text-textItemBlur hover:text-newTextColor hover:bg-boxHover'
                    )}
                  >
                    <div className="relative w-[24px] h-[24px] shrink-0">
                      <ImageWithFallback
                        fallbackSrc={`/icons/platforms/${integration.identifier}.png`}
                        src={integration.picture}
                        className="rounded-full w-[24px] h-[24px] object-cover"
                        alt={integration.identifier}
                        width={24}
                        height={24}
                      />
                      <SafeImage
                        src={`/icons/platforms/${integration.identifier}.png`}
                        className="rounded-full absolute -bottom-[2px] -end-[2px] border border-fifth"
                        alt={integration.identifier}
                        width={12}
                        height={12}
                      />
                    </div>
                    <span className="max-w-[120px] truncate">
                      {integration.name}
                    </span>
                    {integration.refreshNeeded && (
                      <span className="w-[6px] h-[6px] rounded-full bg-red-500 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex-1 min-w-0">
          {!refresh && currentIntegrationPlug && (
            <PlugsContext.Provider value={currentIntegrationPlug}>
              <Plug />
            </PlugsContext.Provider>
          )}
        </div>
      </div>
    </>
  );
};
