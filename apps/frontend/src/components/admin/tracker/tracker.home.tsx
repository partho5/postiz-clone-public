// Activity tracker (api.activity-tracker): /super-admin/activity, the period overview (stats, top features, drop-off, entry sources, top errors) and the device table.
'use client';

import React, { FC, ReactNode, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useDebounce } from 'use-debounce';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import {
  useWorkspaceRouter,
  WorkspaceLink,
} from '@gitroom/frontend/components/layout/workspace.navigation';
import {
  TrackerDeviceRow,
  TrackerOverview,
  useTrackerActivity,
  useTrackerDevices,
  useTrackerOverview,
} from '@gitroom/frontend/components/admin/tracker/tracker.hooks';

dayjs.extend(relativeTime);

// Shows the time since `iso` in words, such as "3 hours ago".
const timeAgo = (iso: string) => dayjs(iso).fromNow();

// A bordered panel with a title, used for each overview card. Shows "No activity yet" when `empty` is true.
const Panel: FC<{ title: string; empty: boolean; children: ReactNode }> = ({
  title,
  empty,
  children,
}) => {
  const t = useT();
  return (
    <div className="border border-newTableBorder rounded-[8px] bg-newBgColorInner flex flex-col min-w-0">
      <div className="px-[12px] py-[10px] text-[14px] font-[600] border-b border-newTableBorder">
        {title}
      </div>
      <div className="p-[12px] flex flex-col gap-[6px] min-w-0">
        {empty ? (
          <div className="text-[13px] opacity-70">
            {t('activity_no_activity_yet', 'No activity yet')}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
};

// One summary number of the stat row, in the same look as the stats page tiles.
const StatTile: FC<{ label: string; value: number; alert?: boolean }> = ({
  label,
  value,
  alert,
}) => (
  <div className="border border-newTableBorder rounded-[8px] p-[16px] bg-newBgColorInner flex flex-col justify-between min-w-0">
    <div className="text-[12px] opacity-70 break-words">{label}</div>
    <div
      className={`text-[28px] font-[600] mt-[4px] ${alert ? 'text-red-400' : ''}`}
    >
      {value.toLocaleString()}
    </div>
  </div>
);

// The top features: each with its name and description, a bar of the share of active devices that used it, and its count.
const TopFeatures: FC<{
  rows: TrackerOverview['topFeatures'];
  activeDevices: number;
}> = ({ rows, activeDevices }) => {
  const t = useT();
  return (
    <Panel
      title={t('activity_top_features', 'Top features')}
      empty={rows.length === 0}
    >
      <div className="grid grid-cols-[1fr_140px_60px] gap-[12px] text-[12px] uppercase opacity-70 pb-[4px]">
        <div>{t('activity_col_feature', 'Feature')}</div>
        <div>{t('activity_col_devices', 'Devices')}</div>
        <div className="text-right">{t('activity_col_count', 'Count')}</div>
      </div>
      {rows.map((row) => {
        // The share of active devices that used this feature, kept between 0 and 100 for the bar.
        const share = activeDevices
          ? Math.min(100, (row.devices / activeDevices) * 100)
          : 0;
        return (
          <div
            key={`${row.name}|${row.description ?? ''}`}
            className="grid grid-cols-[1fr_140px_60px] gap-[12px] text-[13px] items-center"
          >
            <div className="min-w-0 break-words">
              <span className="font-[600]">{row.name}</span>
              {row.description ? (
                <span className="opacity-60"> — {row.description}</span>
              ) : null}
            </div>
            <div className="flex items-center gap-[8px] min-w-0">
              <div className="h-[6px] flex-1 rounded bg-newTableBorder overflow-hidden">
                <div
                  className="h-full rounded bg-forth"
                  style={{ width: `${share}%` }}
                />
              </div>
              <span className="font-mono text-[12px] shrink-0">
                {row.devices}
              </span>
            </div>
            <div className="text-right font-mono">{row.count}</div>
          </div>
        );
      })}
    </Panel>
  );
};

// The screens where sessions ended, most sessions first: the screen and the count of sessions that ended there.
const DropOff: FC<{ rows: TrackerOverview['dropOff'] }> = ({ rows }) => {
  const t = useT();
  return (
    <Panel
      title={t('activity_where_sessions_end', 'Where sessions end')}
      empty={rows.length === 0}
    >
      {rows.map((row) => (
        <div
          key={row.screen}
          className="flex justify-between gap-[12px] text-[13px] py-[2px]"
        >
          <div className="break-all">{row.screen}</div>
          <div className="font-mono shrink-0">{row.sessions}</div>
        </div>
      ))}
    </Panel>
  );
};

// How sessions started: the entry source of each session and the count of sessions per source, most first.
const EntrySources: FC<{ rows: TrackerOverview['entrySources'] }> = ({
  rows,
}) => {
  const t = useT();
  return (
    <Panel
      title={t('activity_how_sessions_start', 'How sessions start')}
      empty={rows.length === 0}
    >
      {rows.map((row) => (
        <div
          key={row.source ?? 'unknown'}
          className="flex justify-between gap-[12px] text-[13px] py-[2px]"
        >
          <div className="break-all">
            {row.source ?? t('activity_unknown_source', 'Unknown')}
          </div>
          <div className="font-mono shrink-0">{row.sessions}</div>
        </div>
      ))}
    </Panel>
  );
};

// The top errors. A click resolves the error's device through its activity, then opens that device's replay at the error.
const TopErrors: FC<{ rows: TrackerOverview['topErrors'] }> = ({ rows }) => {
  const t = useT();
  const router = useWorkspaceRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, error } = useTrackerActivity(openId);

  // Once the error's device is known, the replay opens at that error.
  useEffect(() => {
    if (data) {
      router.push(`/super-admin/activity/${data.deviceId}?at=${data.id}`);
    }
  }, [data, router]);

  return (
    <Panel
      title={t('activity_top_errors', 'Top errors')}
      empty={rows.length === 0}
    >
      {error ? (
        <div className="text-[13px] text-red-400">
          {t('activity_open_error_failed', 'Could not open this error.')}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <div className="min-w-[460px]">
          <div className="grid grid-cols-[1fr_60px_70px_110px] gap-[12px] text-[12px] uppercase opacity-70 pb-[4px]">
            <div>{t('activity_col_error', 'Error')}</div>
            <div className="text-right">{t('activity_col_count', 'Count')}</div>
            <div className="text-right">{t('activity_col_devices', 'Devices')}</div>
            <div>{t('activity_col_last_seen', 'Last seen')}</div>
          </div>
          {rows.map((row) => {
            const body = (
              <>
                <div className="min-w-0 break-words">
                  <div className="font-[600]">{row.errorType ?? '—'}</div>
                  <div className="opacity-60 text-[12px]">{row.screen ?? '—'}</div>
                </div>
                <div className="text-right font-mono text-red-400">{row.count}</div>
                <div className="text-right font-mono">{row.devices}</div>
                <div className="text-[12px] opacity-80">{timeAgo(row.lastAt)}</div>
              </>
            );
            const rowClass =
              'grid grid-cols-[1fr_60px_70px_110px] gap-[12px] text-[13px] py-[6px] border-t border-newTableBorder items-center w-full text-left';
            // A row with no sample error has nothing to open, so it is only shown.
            return row.sampleId ? (
              <button
                key={`${row.errorType}|${row.screen}`}
                type="button"
                onClick={() => setOpenId(row.sampleId)}
                className={`${rowClass} hover:bg-boxHover cursor-pointer`}
              >
                {body}
              </button>
            ) : (
              <div
                key={`${row.errorType}|${row.screen}`}
                className={rowClass}
              >
                {body}
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
};

// The devices table: one row per device with its email (or anonymous), model and OS, app version, last seen, and its activity and error counts.
const DevicesTable: FC = () => {
  const t = useT();
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebounce(search, 300);
  const [hasErrors, setHasErrors] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<TrackerDeviceRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const { data, isLoading, error } = useTrackerDevices({
    q: debouncedSearch.trim(),
    hasErrors,
    cursor,
  });

  // A new search starts again from the first page.
  useEffect(() => {
    setCursor(undefined);
  }, [debouncedSearch]);

  // The first page replaces the rows and a "Load more" page joins them. With no data yet, a first page clears the rows.
  // A page re-run by SWR (focus revalidation) replaces its own devices, so none are listed twice.
  useEffect(() => {
    if (!data) {
      if (!cursor) {
        setRows([]);
      }
      return;
    }
    setRows((prev) => {
      if (!cursor) {
        return data.items;
      }
      const loaded = new Set(data.items.map((row) => row.deviceId));
      return [...prev.filter((row) => !loaded.has(row.deviceId)), ...data.items];
    });
    setNextCursor(data.nextCursor);
  }, [data, cursor]);

  const filtering = debouncedSearch.trim() !== '' || hasErrors;

  return (
    <div className="flex flex-col gap-[12px] min-w-0">
      <div className="text-[16px] font-[600]">
        {t('activity_devices', 'Devices')}
      </div>
      <div className="flex flex-wrap gap-[8px] sm:gap-[12px] items-stretch sm:items-end bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[12px]">
        <div className="flex flex-col gap-[6px] flex-1 sm:flex-none w-full sm:w-auto">
          <div className="text-[12px] opacity-70">
            {t('activity_search_devices', 'Email or device id')}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="user@example.com"
            className="bg-newBgColorInner h-[38px] border border-newTableBorder rounded-[8px] px-[10px] text-[14px] text-textColor w-full sm:min-w-[260px]"
          />
        </div>
        <label className="flex items-center gap-[6px] text-[13px] cursor-pointer h-[38px] select-none">
          <input
            type="checkbox"
            checked={hasErrors}
            onChange={(e) => {
              setCursor(undefined);
              setHasErrors(e.target.checked);
            }}
          />
          {t('activity_has_errors', 'Has errors')}
        </label>
      </div>

      {error ? (
        <div className="text-red-400">
          {t('activity_devices_failed', 'Failed to load the devices.')}
        </div>
      ) : !data && rows.length === 0 ? (
        <LoadingComponent />
      ) : rows.length === 0 ? (
        <div className="opacity-70">
          {filtering
            ? t('activity_no_devices_match', 'No devices match these filters.')
            : t('activity_no_activity_yet', 'No activity yet')}
        </div>
      ) : (
        <div className="border border-newTableBorder rounded-[8px] overflow-x-auto w-full scrollbar-thin">
          <div className="min-w-[860px]">
            <div className="grid grid-cols-[1.4fr_1.2fr_110px_150px_100px_90px] gap-[12px] px-[12px] py-[10px] bg-newBgColorInner text-[12px] uppercase opacity-70 border-b border-newTableBorder">
              <div>{t('activity_col_email', 'Email')}</div>
              <div>{t('activity_col_device', 'Device')}</div>
              <div>{t('activity_col_app', 'App')}</div>
              <div>{t('activity_col_last_seen', 'Last seen')}</div>
              <div className="text-right">{t('activity_col_activities', 'Activities')}</div>
              <div className="text-right">{t('activity_col_errors', 'Errors')}</div>
            </div>
            {rows.map((row) => (
              <WorkspaceLink
                key={row.deviceId}
                href={`/super-admin/activity/${row.deviceId}`}
                className="grid grid-cols-[1.4fr_1.2fr_110px_150px_100px_90px] gap-[12px] px-[12px] py-[10px] text-[13px] border-b border-newTableBorder last:border-b-0 items-center hover:bg-boxHover"
              >
                <div className="min-w-0 break-all">
                  {row.email ? (
                    <div>{row.email}</div>
                  ) : (
                    <div className="opacity-60">
                      {t('activity_anonymous', 'anonymous')}
                    </div>
                  )}
                  <div className="opacity-50 text-[11px] font-mono">
                    {row.deviceId.slice(0, 8)}
                  </div>
                </div>
                <div className="min-w-0 break-words opacity-90">
                  {[row.model, row.os].filter(Boolean).join(' · ') || '—'}
                </div>
                <div className="font-mono text-[12px] opacity-90">
                  {row.appVersion ?? '—'}
                </div>
                <div className="text-[12px] opacity-90">{timeAgo(row.lastSeenAt)}</div>
                <div className="text-right font-mono">{row.activityCount}</div>
                <div
                  className={`text-right font-mono ${row.errorCount > 0 ? 'text-red-400 font-[600]' : 'opacity-70'}`}
                >
                  {row.errorCount}
                </div>
              </WorkspaceLink>
            ))}
          </div>
        </div>
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <Button
            secondary
            loading={isLoading && !!cursor}
            onClick={() => setCursor(nextCursor)}
          >
            {t('activity_load_more', 'Load more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

// The Activity tab: a period picker, the overview of that period and the device table under it.
export const TrackerHome: FC = () => {
  const t = useT();
  const [days, setDays] = useState(7);
  const { data, isLoading, error } = useTrackerOverview(days);

  const periods = [
    { days: 1, label: t('activity_period_1_day', 'Last day') },
    { days: 7, label: t('activity_period_7_days', 'Last 7 days') },
    { days: 30, label: t('activity_period_30_days', 'Last 30 days') },
    { days: 90, label: t('activity_period_90_days', 'Last 90 days') },
  ];

  return (
    <div className="flex flex-col gap-[16px] text-textColor w-full min-w-0">
      <div className="flex flex-wrap gap-[8px] items-center justify-between">
        <div className="text-[20px] font-[600]">
          {t('view_activity', 'Activity')}
        </div>
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value, 10))}
          className="bg-newBgColorInner h-[38px] border border-newTableBorder rounded-[8px] px-[10px] text-[14px] text-textColor"
        >
          {periods.map((p) => (
            <option key={p.days} value={p.days}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <LoadingComponent />
      ) : error || !data ? (
        <div className="text-red-400">
          {t('activity_overview_failed', 'Failed to load the activity overview.')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-[12px]">
            <StatTile label={t('activity_stat_devices', 'Devices')} value={data.devices} />
            <StatTile
              label={t('activity_stat_active_devices', 'Active devices')}
              value={data.activeDevices}
            />
            <StatTile label={t('activity_stat_sessions', 'Sessions')} value={data.sessions} />
            <StatTile label={t('activity_stat_activities', 'Activities')} value={data.activities} />
            <StatTile
              label={t('activity_stat_errors', 'Errors')}
              value={data.errors}
              alert={data.errors > 0}
            />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-[12px]">
            <TopFeatures rows={data.topFeatures} activeDevices={data.activeDevices} />
            <TopErrors rows={data.topErrors} />
            <DropOff rows={data.dropOff} />
            <EntrySources rows={data.entrySources} />
          </div>
        </>
      )}

      <DevicesTable />
    </div>
  );
};
