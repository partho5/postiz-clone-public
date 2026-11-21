// Activity tracker (api.activity-tracker): /super-admin/activity/[deviceId], one device's header, its sessions and the step-by-step replay of the selected session.
'use client';

import React, { FC, ReactNode, Ref, useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import copy from 'copy-to-clipboard';
import { useSearchParams } from 'next/navigation';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { WorkspaceLink } from '@gitroom/frontend/components/layout/workspace.navigation';
import {
  TrackerDevice,
  TrackerSessionRow,
  TrackerTimelineItem,
  useTrackerActivity,
  useTrackerSessions,
  useTrackerTimeline,
} from '@gitroom/frontend/components/admin/tracker/tracker.hooks';

// The timeline API returns at most this many steps; a session that reaches it gets a note.
const TIMELINE_CAP = 2000;

// The app-state steps that "hide app foreground/background" removes.
const APP_STATE_NAMES = ['app_foreground', 'app_background'];

// The filters above the steps. Each one hides steps; the gaps still come from the API.
interface ReplayFilters {
  hideScreens: boolean;
  hideAppState: boolean;
  errorsOnly: boolean;
}

// Formats a span in ms as "0.3 s" under a minute, and as "1 m 12 s" from a minute up.
const formatSpan = (ms: number) => {
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
};

// Formats the gap to the step before as "+0.3 s" or "+1 m 12 s"; a first step has no gap and shows a dash.
const formatGap = (gapMs: number | null) =>
  gapMs === null ? '—' : `+${formatSpan(gapMs)}`;

// The colour of a gap: dimmed under one second, amber over thirty seconds, normal in between.
const gapTone = (gapMs: number | null) => {
  if (gapMs === null) {
    return 'opacity-40';
  }
  if (gapMs < 1000) {
    return 'opacity-50';
  }
  if (gapMs > 30000) {
    return 'text-amber-400';
  }
  return '';
};

// Shows a step's start in the device's local time: UTC shifted by the device's offset in minutes, as HH:mm:ss.SSS.
const deviceTime = (iso: string, tzMinutes: number) =>
  new Date(Date.parse(iso) + tzMinutes * 60000).toISOString().slice(11, 23);

// Shows a date and time in the viewer's zone, such as "2026-11-21 13:05".
const dateTime = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm');

// Whether a step passes the filters. A hidden step keeps the gap the API gave it, which is to the previous real step.
const passesFilters = (item: TrackerTimelineItem, filters: ReplayFilters) => {
  if (filters.hideScreens && item.name === 'screen') {
    return false;
  }
  if (filters.hideAppState && APP_STATE_NAMES.includes(item.name)) {
    return false;
  }
  if (filters.errorsOnly && item.kind !== 'error') {
    return false;
  }
  return true;
};

// A small chip for the screen or the source of a step.
const Chip: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="inline-block px-[6px] py-[1px] mx-[4px] rounded border border-newTableBorder text-[11px] opacity-80 break-all">
    {children}
  </span>
);

// One labelled value in the device header; `alert` shows it in red.
const Field: FC<{ label: string; alert?: boolean; children: ReactNode }> = ({
  label,
  alert,
  children,
}) => (
  <div className="min-w-0">
    <div className="text-[12px] opacity-60">{label}</div>
    <div className={`break-words ${alert ? 'text-red-400 font-[600]' : ''}`}>
      {children}
    </div>
  </div>
);

// A small label above a value in the step details.
const Labelled: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex flex-col gap-[2px] min-w-0">
    <div className="text-[12px] opacity-60">{label}</div>
    <div className="break-words min-w-0">{children}</div>
  </div>
);

// The device header: who it is (email or anonymous), the device id with a copy button, model and OS, app version,
// first and last seen, totals and a back link to the Activity tab.
const ReplayHeader: FC<{ device: TrackerDevice }> = ({ device }) => {
  const t = useT();
  const toaster = useToaster();

  // Copies the device id to the clipboard and confirms it.
  const copyId = () => {
    copy(device.deviceId);
    toaster.show(
      t('activity_device_copied', 'Device id copied to clipboard'),
      'success'
    );
  };

  return (
    <div className="flex flex-col gap-[12px] bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[16px] min-w-0">
      <div className="flex flex-wrap justify-between gap-[8px] items-start">
        <div className="min-w-0 flex flex-col gap-[4px]">
          <div className="text-[20px] font-[600] break-all">
            {device.email ?? t('activity_anonymous', 'anonymous')}
          </div>
          <div className="flex flex-wrap items-center gap-[8px] text-[12px] font-mono opacity-80">
            <span className="break-all">{device.deviceId}</span>
            <Button secondary onClick={copyId}>
              {t('activity_copy', 'Copy')}
            </Button>
          </div>
        </div>
        <WorkspaceLink
          href="/super-admin/activity"
          className="text-[13px] opacity-80 underline"
        >
          {t('activity_back', 'Back to activity')}
        </WorkspaceLink>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-[12px] text-[13px]">
        <Field label={t('activity_model_os', 'Model · OS')}>
          {[device.model, device.os].filter(Boolean).join(' · ') || '—'}
        </Field>
        <Field label={t('activity_app_version', 'App version')}>
          {device.appVersion ?? '—'}
          {device.appBuild !== null ? ` (${device.appBuild})` : ''}
        </Field>
        <Field label={t('activity_first_seen', 'First seen')}>
          {dateTime(device.firstSeenAt)}
        </Field>
        <Field label={t('activity_col_last_seen', 'Last seen')}>
          {dateTime(device.lastSeenAt)}
        </Field>
        <Field label={t('activity_stat_activities', 'Activities')}>
          {device.activityCount.toLocaleString()}
        </Field>
        <Field
          label={t('activity_stat_errors', 'Errors')}
          alert={device.errorCount > 0}
        >
          {device.errorCount.toLocaleString()}
        </Field>
      </div>
    </div>
  );
};

// The sessions of the device, newest first: start, duration, entry source, first and last screen and activity count.
// A red dot marks a session with errors. Selecting a session shows its steps; "Load more" adds the next page.
const SessionList: FC<{
  rows: TrackerSessionRow[];
  selectedKey: string | null;
  nextCursor: string | null;
  loadingMore: boolean;
  error: boolean;
  onSelect: (key: string) => void;
  onLoadMore: () => void;
}> = ({ rows, selectedKey, nextCursor, loadingMore, error, onSelect, onLoadMore }) => {
  const t = useT();
  return (
    <div className="flex flex-col gap-[8px] min-w-0">
      <div className="border border-newTableBorder rounded-[8px] bg-newBgColorInner overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-[12px] text-[13px] opacity-70">
            {t('activity_no_sessions_yet', 'No sessions yet')}
          </div>
        ) : (
          rows.map((row) => (
            <button
              key={row.key}
              type="button"
              onClick={() => onSelect(row.key)}
              aria-pressed={row.key === selectedKey}
              className={`w-full text-left flex flex-col gap-[4px] px-[12px] py-[10px] text-[13px] border-b border-newTableBorder last:border-b-0 hover:bg-boxHover ${row.key === selectedKey ? 'bg-boxHover' : ''}`}
            >
              <div className="flex justify-between gap-[8px] items-center">
                <span className="font-[600]">{dateTime(row.startedAt)}</span>
                <span className="flex items-center gap-[6px] font-mono text-[12px] opacity-80 shrink-0">
                  {row.errorCount > 0 ? (
                    <span
                      title={t('activity_has_errors', 'Has errors')}
                      className="w-[6px] h-[6px] rounded-full bg-red-500 shrink-0"
                    />
                  ) : null}
                  {formatSpan(row.durationMs)}
                </span>
              </div>
              <div className="text-[12px] opacity-80 break-all">
                {row.entrySource ?? t('activity_unknown_source', 'Unknown')} ·{' '}
                {t('activity_count_label', '{{n}} activities', { n: row.activityCount })}
              </div>
              <div className="text-[12px] opacity-70 break-all">
                {row.firstScreen ?? '—'} → {row.lastScreen ?? '—'}
              </div>
            </button>
          ))
        )}
      </div>
      {error ? (
        <div className="text-[13px] text-red-400">
          {t('activity_sessions_failed', 'Failed to load the sessions.')}
        </div>
      ) : null}
      {nextCursor ? (
        <div className="flex justify-center">
          <Button secondary loading={loadingMore} onClick={onLoadMore}>
            {t('activity_load_more', 'Load more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

// The filter checkboxes above the steps: hide screens, hide app foreground and background, or show errors only.
const ReplayFilterBar: FC<{
  value: ReplayFilters;
  onChange: (value: ReplayFilters) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  const options: { key: keyof ReplayFilters; label: string }[] = [
    { key: 'hideScreens', label: t('activity_filter_hide_screens', 'Hide screens') },
    {
      key: 'hideAppState',
      label: t('activity_filter_hide_app_state', 'Hide app foreground/background'),
    },
    { key: 'errorsOnly', label: t('activity_filter_errors_only', 'Errors only') },
  ];
  return (
    <div className="flex flex-wrap gap-[12px] text-[13px] items-center bg-newBgColorInner border border-newTableBorder rounded-[8px] px-[12px] py-[8px]">
      {options.map((option) => (
        <label
          key={option.key}
          className="flex items-center gap-[6px] cursor-pointer select-none"
        >
          <input
            type="checkbox"
            checked={value[option.key]}
            onChange={(e) =>
              onChange({ ...value, [option.key]: e.target.checked })
            }
          />
          {option.label}
        </label>
      ))}
    </div>
  );
};

// The error's detail, opened from its row: the type, message, thread and last activity from the row, and the stack and causes loaded in full.
const ErrorDetail: FC<{ item: TrackerTimelineItem }> = ({ item }) => {
  const t = useT();
  const { data, isLoading, error } = useTrackerActivity(item.id);
  return (
    <div className="flex flex-col gap-[10px] min-w-0">
      {item.errorType ? (
        <Labelled label={t('activity_error_type', 'Type')}>{item.errorType}</Labelled>
      ) : null}
      {item.errorMessage ? (
        <Labelled label={t('activity_error_message', 'Message')}>
          <pre className="whitespace-pre-wrap text-[12px] overflow-auto max-h-[40vh]">
            {item.errorMessage}
          </pre>
        </Labelled>
      ) : null}
      {isLoading ? <LoadingComponent /> : null}
      {error ? (
        <div className="text-red-400">
          {t('activity_error_detail_failed', "Could not load this error's stack.")}
        </div>
      ) : null}
      {data?.errorStack ? (
        <Labelled label={t('activity_error_stack', 'Stack')}>
          <pre className="whitespace-pre-wrap text-[12px] overflow-auto max-h-[40vh]">
            {data.errorStack}
          </pre>
        </Labelled>
      ) : null}
      {data?.errorCauses?.length ? (
        <Labelled label={t('activity_error_causes', 'Causes')}>
          {data.errorCauses.map((cause, i) => (
            <div key={i} className="break-words">
              {cause.type}
              {cause.message ? `: ${cause.message}` : ''}
            </div>
          ))}
        </Labelled>
      ) : null}
      {item.errorThread ? (
        <Labelled label={t('activity_error_thread', 'Thread')}>{item.errorThread}</Labelled>
      ) : null}
      {item.lastActivity ? (
        <Labelled label={t('activity_error_last_activity', 'Last activity before this error')}>
          {item.lastActivity}
        </Labelled>
      ) : null}
      {item.fatal !== null ? (
        <Labelled label={t('activity_error_fatal', 'Fatal')}>
          {item.fatal ? t('activity_yes', 'Yes') : t('activity_no', 'No')}
        </Labelled>
      ) : null}
    </div>
  );
};

// One step of the timeline: time, gap, kind, name with description and chips, and duration as a bar with text.
// Error steps have a red background. A click shows the step's details (and the error's detail for errors).
const TimelineRow: FC<{
  item: TrackerTimelineItem;
  maxDuration: number;
  expanded: boolean;
  onToggle: () => void;
  rowRef?: Ref<HTMLDivElement>;
}> = ({ item, maxDuration, expanded, onToggle, rowRef }) => {
  const t = useT();
  const isError = item.kind === 'error';
  const metaEntries = Object.entries(item.meta ?? {});
  return (
    <div ref={rowRef} className="border-t border-newTableBorder">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`w-full grid grid-cols-[110px_70px_80px_1fr_120px] gap-[12px] px-[12px] py-[8px] text-left text-[13px] items-center hover:bg-boxHover ${isError ? 'bg-red-500/10' : ''}`}
      >
        <span className="font-mono text-[12px]">
          {deviceTime(item.startedAt, item.tz)}
        </span>
        <span className={`font-mono text-[12px] ${gapTone(item.gapMs)}`}>
          {formatGap(item.gapMs)}
        </span>
        <span
          className={`w-fit px-[6px] py-[1px] rounded text-[11px] uppercase ${isError ? 'bg-red-500/20 text-red-400' : 'bg-newTableBorder'}`}
        >
          {isError
            ? t('activity_kind_error', 'Error')
            : t('activity_kind_activity', 'Activity')}
        </span>
        <span className="min-w-0 break-words">
          <span className="font-[600]">{item.name}</span>
          {item.description ? (
            <span className="opacity-60"> — {item.description}</span>
          ) : null}
          {item.screen ? <Chip>{item.screen}</Chip> : null}
          {item.source ? <Chip>{item.source}</Chip> : null}
        </span>
        <span className="flex flex-col gap-[4px] min-w-0 font-mono text-[12px]">
          {item.durationMs !== null ? (
            <>
              <span>{formatSpan(item.durationMs)}</span>
              <span className="block h-[4px] rounded bg-newTableBorder overflow-hidden">
                <span
                  className="block h-full rounded bg-forth"
                  style={{ width: `${(item.durationMs / maxDuration) * 100}%` }}
                />
              </span>
            </>
          ) : null}
        </span>
      </button>
      {expanded ? (
        <div className="px-[12px] pb-[12px] pt-[4px] flex flex-col gap-[10px] text-[13px] min-w-0">
          {isError ? <ErrorDetail item={item} /> : null}
          {metaEntries.length > 0 ? (
            <div className="flex flex-col gap-[6px] min-w-0">
              <div className="text-[12px] uppercase opacity-70">
                {t('activity_meta_title', 'Details')}
              </div>
              <div className="grid grid-cols-[140px_1fr] gap-x-[12px] gap-y-[4px] font-mono text-[12px] min-w-0">
                {metaEntries.map(([key, value]) => (
                  <React.Fragment key={key}>
                    <div className="opacity-60 break-all">{key}</div>
                    <div className="break-all">{String(value)}</div>
                  </React.Fragment>
                ))}
              </div>
            </div>
          ) : isError ? null : (
            <div className="opacity-60">
              {t('activity_no_details', 'No details for this step.')}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
};

// The replay of one device: its header, the session list on the left and the steps of the selected session on the right.
// The first session is selected by default; `?at=<activityId>` selects that activity's session instead and opens and scrolls to it.
export const TrackerReplay: FC<{ deviceId: string }> = ({ deviceId }) => {
  const t = useT();
  const searchParams = useSearchParams();
  // The activity an overview link opened the replay at, or null.
  const at = searchParams.get('at');

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [device, setDevice] = useState<TrackerDevice | null>(null);
  const [sessions, setSessions] = useState<TrackerSessionRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // The session the viewer picked; null until a click, then the default applies.
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [filters, setFilters] = useState<ReplayFilters>({
    hideScreens: false,
    hideAppState: false,
    errorsOnly: false,
  });
  // Which steps are expanded, by activity id.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const atRowRef = useRef<HTMLDivElement>(null);
  const scrolledTo = useRef<string | null>(null);

  const {
    data: sessionsPage,
    error: sessionsError,
    isLoading: sessionsLoading,
  } = useTrackerSessions(deviceId, cursor);
  const atActivity = useTrackerActivity(at);

  // The first page replaces the sessions and a "Load more" page joins them, without listing a session twice.
  useEffect(() => {
    if (!sessionsPage) {
      return;
    }
    setDevice(sessionsPage.device);
    setSessions((prev) => {
      if (!cursor) {
        return sessionsPage.items;
      }
      const loaded = new Set(sessionsPage.items.map((row) => row.key));
      return [
        ...prev.filter((row) => !loaded.has(row.key)),
        ...sessionsPage.items,
      ];
    });
    setNextCursor(sessionsPage.nextCursor);
  }, [sessionsPage, cursor]);

  // The session to show: the viewer's pick, else the session of the `?at` activity, else the newest one.
  // While that activity is still loading, nothing is picked yet so the newest session is not fetched first.
  const selectedKey =
    pickedKey ??
    atActivity.data?.sessionKey ??
    (at && atActivity.isLoading ? null : (sessions[0]?.key ?? null));

  const { data: timeline, error: timelineError } =
    useTrackerTimeline(selectedKey);
  const steps = timeline?.items ?? [];
  const visible = steps.filter((item) => passesFilters(item, filters));
  // The longest duration of the session, the full width of every duration bar. At least 1 so the bars never divide by zero.
  const maxDuration =
    steps.reduce((max, item) => Math.max(max, item.durationMs ?? 0), 0) || 1;

  // Once the `?at` step is in the loaded timeline, it is scrolled into view (once); an error step is opened too.
  useEffect(() => {
    const items = timeline?.items;
    if (!at || !items || scrolledTo.current === at) {
      return;
    }
    const target = items.find((item) => item.id === at);
    if (!target) {
      return;
    }
    scrolledTo.current = at;
    if (target.kind === 'error') {
      setExpanded((prev) => ({ ...prev, [at]: true }));
    }
    atRowRef.current?.scrollIntoView({ block: 'center' });
  }, [at, timeline]);

  // Flips one step between expanded and collapsed.
  const toggleRow = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  // The steps of the selected session, or what stands in for them while loading, failing or with no session.
  const renderSteps = () => {
    if (!selectedKey) {
      return sessionsLoading || atActivity.isLoading ? (
        <LoadingComponent />
      ) : (
        <div className="text-[13px] opacity-70">
          {t('activity_no_sessions_yet', 'No sessions yet')}
        </div>
      );
    }
    if (timelineError) {
      return (
        <div className="text-red-400">
          {t('activity_timeline_failed', 'Failed to load this session.')}
        </div>
      );
    }
    if (!timeline) {
      return <LoadingComponent />;
    }
    return (
      <>
        <div className="border border-newTableBorder rounded-[8px] bg-newBgColorInner overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="grid grid-cols-[110px_70px_80px_1fr_120px] gap-[12px] px-[12px] py-[8px] text-[12px] uppercase opacity-70 border-b border-newTableBorder">
              <div>{t('activity_col_time', 'Time')}</div>
              <div>{t('activity_col_gap', 'Gap')}</div>
              <div>{t('activity_col_kind', 'Kind')}</div>
              <div>{t('activity_col_step', 'Step')}</div>
              <div>{t('activity_col_duration', 'Duration')}</div>
            </div>
            {steps.length === 0 ? (
              <div className="p-[12px] text-[13px] opacity-70">
                {t('activity_no_steps', 'No steps in this session.')}
              </div>
            ) : visible.length === 0 ? (
              <div className="p-[12px] text-[13px] opacity-70">
                {t('activity_no_steps_match', 'No steps match these filters.')}
              </div>
            ) : (
              visible.map((item) => (
                <TimelineRow
                  key={item.id}
                  item={item}
                  maxDuration={maxDuration}
                  expanded={!!expanded[item.id]}
                  onToggle={() => toggleRow(item.id)}
                  rowRef={item.id === at ? atRowRef : undefined}
                />
              ))
            )}
          </div>
        </div>
        {steps.length >= TIMELINE_CAP ? (
          <div className="text-[12px] opacity-70">
            {t('activity_timeline_capped', 'Showing the first 2000 steps of this session.')}
          </div>
        ) : null}
      </>
    );
  };

  return (
    <div className="flex flex-col gap-[16px] text-textColor w-full min-w-0">
      {!device ? (
        sessionsError ? (
          <div className="text-red-400">
            {t('activity_device_failed', 'Failed to load the device.')}
          </div>
        ) : (
          <LoadingComponent />
        )
      ) : (
        <>
          <ReplayHeader device={device} />
          <div className="flex flex-col lg:flex-row gap-[16px] min-w-0">
            <div className="w-full lg:w-[320px] shrink-0 flex flex-col gap-[8px] min-w-0">
              <div className="text-[16px] font-[600]">
                {t('activity_stat_sessions', 'Sessions')}
              </div>
              <SessionList
                rows={sessions}
                selectedKey={selectedKey}
                nextCursor={nextCursor}
                loadingMore={sessionsLoading && !!cursor}
                error={!!sessionsError}
                onSelect={setPickedKey}
                onLoadMore={() => setCursor(nextCursor ?? undefined)}
              />
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-[8px]">
              <div className="text-[16px] font-[600]">
                {t('activity_steps_title', 'Steps')}
              </div>
              <ReplayFilterBar value={filters} onChange={setFilters} />
              {renderSteps()}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
