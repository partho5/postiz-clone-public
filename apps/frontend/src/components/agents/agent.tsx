// Feature: AI Agents Copilot Chat - Channels and Threads Layout
'use client';

import React, {
  createContext,
  FC,
  useCallback,
  useMemo,
  useState,
  ReactNode,
} from 'react';
import clsx from 'clsx';
import useCookie from 'react-use-cookie';
import useSWR from 'swr';
import { orderBy } from 'lodash';
import { SVGLine } from '@gitroom/frontend/components/launches/launches.component';
import ImageWithFallback from '@gitroom/react/helpers/image.with.fallback';
import SafeImage from '@gitroom/react/helpers/safe.image';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useWaitForClass } from '@gitroom/helpers/utils/use.wait.for.class';
import { MultiMediaComponent } from '@gitroom/frontend/components/media/media.component';
import { Integration } from '@prisma/client';
import { useParams } from 'next/navigation';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useWorkspaceRouter, useWorkspacePathname, WorkspaceLink } from '@gitroom/frontend/components/layout/workspace.navigation';

// Renders the media attachments portal inside the agent chat container.
export const MediaPortal: FC<{
  media: { path: string; id: string }[];
  value: string;
  setMedia: (event: {
    target: {
      name: string;
      value?: {
        id: string;
        path: string;
        alt?: string;
        thumbnail?: string;
        thumbnailTimestamp?: number;
      }[];
    };
  }) => void;
}> = ({ media, setMedia, value }) => {
  const waitForClass = useWaitForClass('copilotKitMessages');
  const t = useT();
  if (!waitForClass) return null;
  return (
    <div className="px-[10px] sm:pl-[14px] sm:pr-[24px] whitespace-nowrap editor rm-bg w-full min-w-0 max-w-full overflow-x-auto">
      <MultiMediaComponent
        allData={[{ content: value }]}
        text={value}
        label={t('attachments', 'Attachments')}
        description=""
        value={media}
        dummy={false}
        name="image"
        onChange={setMedia}
        onOpen={() => {}}
        onClose={() => {}}
      />
    </div>
  );
};

// Renders the channels selection list for connected social integrations.
export const AgentList: FC<{
  onChange: (arr: any[]) => void;
  selected?: any[];
  onItemClick?: () => void;
  isMobileDrawer?: boolean;
}> = ({
  onChange,
  selected: controlledSelected,
  onItemClick,
  isMobileDrawer = false,
}) => {
  const fetch = useFetch();
  const t = useT();
  const [internalSelected, setInternalSelected] = useState<any[]>([]);
  const selected = controlledSelected !== undefined ? controlledSelected : internalSelected;

  const load = useCallback(async () => {
    return (await (await fetch('/integrations/list')).json()).integrations;
  }, []);

  const [collapseMenu, setCollapseMenu] = useCookie('collapseMenu', '0');

  const { data } = useSWR('integrations', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    fallbackData: [],
  });

  const setIntegration = useCallback(
    (integration: Integration) => () => {
      const isSelected = selected.some((p: any) => p.id === integration.id);
      const next = isSelected
        ? selected.filter((p: any) => p.id !== integration.id)
        : [...selected, integration];
      onChange(next);
      if (controlledSelected === undefined) {
        setInternalSelected(next);
      }
      onItemClick?.();
    },
    [selected, onChange, controlledSelected, onItemClick]
  );

  const sortedIntegrations = useMemo(() => {
    return orderBy(
      data || [],
      ['type', 'disabled', 'identifier'],
      ['desc', 'asc', 'asc']
    );
  }, [data]);

  return (
    <div
      className={clsx(
        'trz bg-newBgColorInner flex flex-col gap-[15px] transition-all relative',
        isMobileDrawer
          ? 'w-full h-full'
          : collapseMenu === '1'
          ? 'group sidebar w-[100px]'
          : 'w-[260px]'
      )}
    >
      <div
        className={clsx(
          'w-full h-full p-[20px] overflow-auto scrollbar scrollbar-thumb-fifth scrollbar-track-newBgColor',
          !isMobileDrawer && 'absolute top-0 start-0'
        )}
      >
        <div className="flex items-center">
          <h2
            className={clsx(
              'flex-1 text-[20px] font-[500] mb-[15px]',
              !isMobileDrawer && 'group-[.sidebar]:hidden'
            )}
          >
            {t('select_channels', 'Select Channels')}
          </h2>
          {!isMobileDrawer && (
            <div
              onClick={() => setCollapseMenu(collapseMenu === '1' ? '0' : '1')}
              className="-mt-3 group-[.sidebar]:rotate-[180deg] group-[.sidebar]:mx-auto text-btnText bg-btnSimple rounded-[6px] w-[24px] h-[24px] flex items-center justify-center cursor-pointer select-none"
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
          )}
        </div>
        <div className={clsx('flex flex-col gap-[15px]')}>
          {sortedIntegrations.map((integration, index) => (
            <div
              onClick={setIntegration(integration)}
              key={integration.id}
              className={clsx(
                'flex gap-[12px] items-center group/profile justify-center hover:bg-boxHover rounded-e-[8px] hover:opacity-100 cursor-pointer min-h-[44px]',
                !selected.some((p: any) => p.id === integration.id) &&
                  'opacity-20'
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
                  'flex-1 whitespace-nowrap text-ellipsis overflow-hidden',
                  !isMobileDrawer && 'group-[.sidebar]:hidden',
                  integration.disabled && 'opacity-50'
                )}
              >
                {integration.name}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export const PropertiesContext = createContext({ properties: [] });

// Renders the 3-column AI agent layout with responsive mobile channel and thread drawers.
export const Agent: FC<{ children: ReactNode }> = ({ children }) => {
  const [properties, setProperties] = useState<any[]>([]);
  const [mobileChannelsOpen, setMobileChannelsOpen] = useState(false);
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false);
  const { id } = useParams<{ id: string }>();
  const t = useT();

  return (
    <PropertiesContext.Provider value={{ properties }}>
      {/* Desktop Left Channel Sidebar (hidden on < lg) */}
      <div className="hidden lg:flex shrink-0">
        <AgentList onChange={setProperties} selected={properties} />
      </div>

      {/* Center Chat Area */}
      <div className="bg-newBgColorInner flex flex-1 flex-col min-w-0 h-full relative">
        {/* Mobile Header Action Pills (< lg) */}
        <div className="flex lg:hidden items-center justify-between gap-[8px] px-[12px] py-[10px] bg-newBgColorInner border-b border-newTableBorder shrink-0 z-20">
          {/* Channels Button */}
          <button
            type="button"
            onClick={() => setMobileChannelsOpen(true)}
            className="flex items-center gap-[8px] px-[12px] py-[7px] bg-newBgLineColor hover:bg-boxHover rounded-[8px] text-[13px] font-[500] text-newTextColor transition-colors border border-newTableBorder min-h-[40px]"
            aria-label={t('channels', 'Channels')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
              <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
            </svg>
            <span>{t('channels', 'Channels')}</span>
            {properties.length > 0 ? (
              <span className="bg-btnPrimary text-white text-[11px] font-[600] px-[6px] py-[1px] rounded-full">
                {properties.length}
              </span>
            ) : (
              <span className="text-[11px] text-fifth">
                {t('all', 'All')}
              </span>
            )}
          </button>

          {/* History / Threads Button */}
          <button
            type="button"
            onClick={() => setMobileThreadsOpen(true)}
            className="flex items-center gap-[8px] px-[12px] py-[7px] bg-newBgLineColor hover:bg-boxHover rounded-[8px] text-[13px] font-[500] text-newTextColor transition-colors border border-newTableBorder min-h-[40px]"
            aria-label={t('history_threads', 'History / Threads')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>{t('history_threads', 'History / Threads')}</span>
            {id && id !== 'new' && (
              <span
                className="w-[8px] h-[8px] rounded-full bg-btnPrimary inline-block shrink-0"
                aria-label="Active thread"
              />
            )}
          </button>
        </div>

        {/* Chat Content */}
        <div className="flex-1 flex min-w-0 relative h-full">
          {children}
        </div>
      </div>

      {/* Desktop Right Threads Sidebar (hidden on < lg) */}
      <div className="hidden lg:flex shrink-0">
        <Threads />
      </div>

      {/* Mobile Channels Slide-Over Drawer (< lg) */}
      {mobileChannelsOpen && (
        <div className="fixed inset-0 z-50 flex justify-start lg:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
            onClick={() => setMobileChannelsOpen(false)}
          />

          {/* Drawer panel */}
          <div className="relative z-10 w-[300px] max-w-[85vw] h-full bg-newBgColorInner border-e border-newTableBorder shadow-2xl flex flex-col">
            {/* Drawer Header */}
            <div className="flex items-center justify-between p-[16px] border-b border-newTableBorder">
              <h3 className="text-[16px] font-[600] text-newTextColor">
                {t('select_channels', 'Select Channels')}
              </h3>
              <button
                type="button"
                onClick={() => setMobileChannelsOpen(false)}
                className="w-[32px] h-[32px] rounded-[6px] bg-newBgLineColor hover:bg-boxHover flex items-center justify-center text-newTextColor"
                aria-label={t('close', 'Close')}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Drawer Body */}
            <div className="flex-1 overflow-y-auto">
              <AgentList
                isMobileDrawer={true}
                selected={properties}
                onChange={setProperties}
                onItemClick={() => setMobileChannelsOpen(false)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Mobile Threads Slide-Over Drawer (< lg) */}
      {mobileThreadsOpen && (
        <div className="fixed inset-0 z-50 flex justify-end lg:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
            onClick={() => setMobileThreadsOpen(false)}
          />

          {/* Drawer panel */}
          <div className="relative z-10 w-[300px] max-w-[85vw] h-full bg-newBgColorInner border-s border-newTableBorder shadow-2xl flex flex-col">
            {/* Drawer Header */}
            <div className="flex items-center justify-between p-[16px] border-b border-newTableBorder">
              <h3 className="text-[16px] font-[600] text-newTextColor">
                {t('history_threads', 'History / Threads')}
              </h3>
              <button
                type="button"
                onClick={() => setMobileThreadsOpen(false)}
                className="w-[32px] h-[32px] rounded-[6px] bg-newBgLineColor hover:bg-boxHover flex items-center justify-center text-newTextColor"
                aria-label={t('close', 'Close')}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Drawer Body */}
            <div className="flex-1 overflow-y-auto">
              <Threads
                isMobileDrawer={true}
                onItemClick={() => setMobileThreadsOpen(false)}
              />
            </div>
          </div>
        </div>
      )}
    </PropertiesContext.Provider>
  );
};

// Renders the thread history list and new chat creation action.
export const Threads: FC<{
  onItemClick?: () => void;
  isMobileDrawer?: boolean;
}> = ({ onItemClick, isMobileDrawer = false }) => {
  const fetch = useFetch();
  const router = useWorkspaceRouter();
  const pathname = useWorkspacePathname();
  const t = useT();
  const threads = useCallback(async () => {
    return (await fetch('/copilot/list')).json();
  }, []);
  const { id } = useParams<{ id: string }>();

  const { data } = useSWR('threads', threads);

  return (
    <div
      className={clsx(
        'trz bg-newBgColorInner flex flex-col gap-[15px] transition-all relative',
        isMobileDrawer ? 'w-full h-full' : 'w-[260px]'
      )}
    >
      <div
        className={clsx(
          'w-full h-full p-[20px] overflow-auto scrollbar scrollbar-thumb-fifth scrollbar-track-newBgColor',
          !isMobileDrawer && 'absolute top-0 start-0'
        )}
      >
        <div className="mb-[15px] justify-center flex group-[.sidebar]:pb-[15px]">
          <WorkspaceLink
            href={`/agents`}
            onClick={() => onItemClick?.()}
            className="text-white whitespace-nowrap flex-1 pt-[12px] pb-[14px] ps-[16px] pe-[20px] group-[.sidebar]:p-0 min-h-[44px] max-h-[44px] rounded-md bg-btnPrimary flex justify-center items-center gap-[5px] outline-none"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="21"
              height="20"
              viewBox="0 0 21 20"
              fill="none"
              className="min-w-[21px] min-h-[20px]"
            >
              <path
                d="M10.5001 4.16699V15.8337M4.66675 10.0003H16.3334"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="flex-1 text-start text-[16px] group-[.sidebar]:hidden">
              {t('start_a_new_chat', 'Start a new chat')}
            </div>
          </WorkspaceLink>
        </div>
        <div className="flex flex-col gap-[1px]">
          {data?.threads?.map((p: any) => (
            <WorkspaceLink
              className={clsx(
                'overflow-ellipsis overflow-hidden whitespace-nowrap hover:bg-newBgColor px-[10px] py-[6px] rounded-[10px] cursor-pointer min-h-[40px] flex items-center',
                p.id === id && 'bg-newBgColor font-[500]'
              )}
              href={`/agents/${p.id}`}
              onClick={() => onItemClick?.()}
              key={p.id}
            >
              {p.title}
            </WorkspaceLink>
          ))}
        </div>
      </div>
    </div>
  );
};
