// Feature: Platform Analytics - Channel Performance & Metrics
'use client';

import useSWR from 'swr';
import { useCallback, useMemo, useState } from 'react';
import { capitalize, orderBy } from 'lodash';
import clsx from 'clsx';
import ImageWithFallback from '@gitroom/react/helpers/image.with.fallback';
import SafeImage from '@gitroom/react/helpers/safe.image';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { RenderAnalytics } from '@gitroom/frontend/components/platform-analytics/render.analytics';
import { Select } from '@gitroom/react/form/select';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import useCookie from 'react-use-cookie';
import { SVGLine } from '@gitroom/frontend/components/launches/launches.component';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useWorkspaceRouter } from '@gitroom/frontend/components/layout/workspace.navigation';

const allowedIntegrations = [
  'facebook',
  'instagram',
  'instagram-standalone',
  'linkedin-page',
  'tiktok',
  'tiktok-business',
  'youtube',
  'gmb',
  'pinterest',
  'threads',
  'x',
];

// Renders platform-level performance metrics, graphs, and channel analytics.
export const PlatformAnalytics = () => {
  const fetch = useFetch();
  const t = useT();
  const router = useWorkspaceRouter();
  const { disableXAnalytics } = useVariables();

  const [current, setCurrent] = useState(0);
  const [key, setKey] = useState(7);
  const [refresh, setRefresh] = useState(false);
  const [collapseMenu, setCollapseMenu] = useCookie('collapseMenu', '0');
  const toaster = useToaster();

  // Loads the list of connected social integrations allowed for analytics.
  const load = useCallback(async () => {
    const int = (
      await (await fetch('/integrations/list')).json()
    ).integrations.filter((f: any) => {
      if (f.identifier === 'x' && disableXAnalytics) {
        return false;
      }
      return true;
    });
    return int.filter((f: any) => allowedIntegrations.includes(f.identifier));
  }, []);

  const { data, isLoading } = useSWR('analytics-list', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    fallbackData: [],
  });

  const sortedIntegrations = useMemo(() => {
    return orderBy(
      data,
      ['type', 'disabled', 'identifier'],
      ['desc', 'asc', 'asc']
    );
  }, [data]);

  const currentIntegration = useMemo(() => {
    return sortedIntegrations[current];
  }, [current, sortedIntegrations]);

  const options = useMemo(() => {
    if (!currentIntegration) {
      return [];
    }
    const arr = [];
    if (
      [
        'facebook',
        'instagram',
        'instagram-standalone',
        'linkedin-page',
        'pinterest',
        'youtube',
        'threads',
        'gmb',
        'x',
        'tiktok',
        'tiktok-business',
      ].indexOf(currentIntegration.identifier) !== -1
    ) {
      arr.push({
        key: 7,
        value: t('7_days', '7 Days'),
      });
    }
    if (
      [
        'facebook',
        'instagram',
        'instagram-standalone',
        'linkedin-page',
        'pinterest',
        'youtube',
        'threads',
        'gmb',
        'x',
        'tiktok',
        'tiktok-business',
      ].indexOf(currentIntegration.identifier) !== -1
    ) {
      arr.push({
        key: 30,
        value: t('30_days', '30 Days'),
      });
    }
    if (
      ['facebook', 'linkedin-page', 'pinterest', 'youtube', 'x', 'gmb'].indexOf(
        currentIntegration.identifier
      ) !== -1
    ) {
      arr.push({
        key: 90,
        value: t('90_days', '90 Days'),
      });
    }
    return arr;
  }, [currentIntegration]);

  const keys = useMemo(() => {
    if (!currentIntegration) {
      return 7;
    }
    if (options.find((p) => p.key === key)) {
      return key;
    }
    return options[0]?.key;
  }, [key, currentIntegration]);

  // Handles channel selection and initiates reload of channel analytics.
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

  if (isLoading) {
    return (
      <div className="bg-newBgColorInner p-[20px] flex flex-1 flex-col gap-[15px] transition-all items-center justify-center">
        <LoadingComponent />
      </div>
    );
  }

  if (!sortedIntegrations.length && !isLoading) {
    return (
      <div className="bg-newBgColorInner p-[16px] sm:p-[20px] flex flex-col gap-[15px] transition-all flex-1 justify-center items-center text-center">
        <div>
          <img
            src="/peoplemarketplace.svg"
            alt="No channels"
            className="max-w-[200px] sm:max-w-[280px]"
          />
        </div>
        <div className="text-[26px] sm:text-[36px] lg:text-[48px] leading-tight font-[600]">
          {t('can_t_show_analytics_yet', "Can't show analytics yet")}
          <br />
          <span className="text-[16px] sm:text-[22px] font-normal text-textItemBlur">
            {t(
              'you_have_to_add_social_media_channels',
              'You have to add Social Media channels'
            )}
          </span>
        </div>
        <div className="text-[14px] sm:text-[16px] text-textItemBlur max-w-[500px]">
          {t('supported', 'Supported:')}{' '}
          {allowedIntegrations.map((p) => capitalize(p)).join(', ')}
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
                'flex gap-[12px] items-center group/profile justify-center hover:bg-boxHover rounded-e-[8px]',
                currentIntegration.id !== integration.id &&
                  'opacity-20 hover:opacity-100 cursor-pointer'
              )}
            >
              <div
                className={clsx(
                  'relative rounded-full flex justify-center items-center gap-[6px]',
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

      {/* Main Analytics Content Area */}
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
                    key={`mobile-pill-${integration.id}`}
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

        {!!options.length && (
          <div className="flex-1 flex flex-col gap-[14px] min-w-0">
            {/* Header Controls: Date range dropdown and action wrap */}
            <div className="flex items-center justify-between flex-wrap gap-[8px]">
              <div className="w-full sm:w-[200px]">
                <Select
                  label=""
                  name="date"
                  disableForm={true}
                  hideErrors={true}
                  onChange={(e) => setKey(+e.target.value)}
                >
                  {options.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.value}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex-1 min-w-0">
              {!!keys && !!currentIntegration && !refresh && (
                <RenderAnalytics integration={currentIntegration} date={keys} />
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
};
