// Feature: Admin Analytics and Platform Statistics
'use client';

// Admin: /super-admin/stats system analytics, usage totals, and per-social breakdown.
import React, { FC, useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';

interface PerSocial {
  provider: string;
  count: number;
}

interface StatsBlock {
  total: number;
  perSocial: PerSocial[];
}

interface StatsResponse {
  from: string;
  to: string;
  errors: StatsBlock;
  posts: StatsBlock;
  connected: StatsBlock;
  publishingAccounts?: StatsBlock;
  scheduledAccounts?: StatsBlock;
  publishingChannels?: StatsBlock;
  scheduledChannels?: StatsBlock;
  activeOrgsBySource?: StatsBlock;
  connectedClients?: StatsBlock;
}

// Returns an ISO YYYY-MM-DD date string offset by the given number of days in the past.
const isoDaysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

// Returns today's date formatted as an ISO YYYY-MM-DD string.
const today = () => new Date().toISOString().slice(0, 10);

// Returns the Monday date of the current ISO week as YYYY-MM-DD.
const startOfWeek = () => {
  const d = new Date();
  // ISO week: Monday = 0
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
};

// Returns the first day of the current month as YYYY-MM-DD.
const startOfMonth = () => {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
};

const PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  { label: 'Today', range: () => ({ from: today(), to: today() }) },
  { label: 'This week', range: () => ({ from: startOfWeek(), to: today() }) },
  { label: 'This month', range: () => ({ from: startOfMonth(), to: today() }) },
  { label: 'Last 7 days', range: () => ({ from: isoDaysAgo(7), to: today() }) },
  { label: 'Last 30 days', range: () => ({ from: isoDaysAgo(30), to: today() }) },
];

// SWR hook to fetch administrative statistics within a date range.
const useStats = (params: {
  from: string;
  to: string;
  unknownOnly: boolean;
}) => {
  const fetch = useFetch();
  const query = new URLSearchParams({
    from: params.from,
    to: params.to,
    ...(params.unknownOnly ? { unknownOnly: 'true' } : {}),
  });
  const key = `/admin/stats?${query.toString()}`;
  return useSWR<StatsResponse>(
    key,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Failed to load stats');
      }
      return res.json();
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    }
  );
};

// Renders a single numerical metric summary card.
const SummaryCard: FC<{ label: string; value: number }> = ({
  label,
  value,
}) => (
  <div className="border border-newTableBorder rounded-[8px] p-[16px] bg-newBgColorInner h-full flex flex-col justify-between">
    <div className="text-[12px] opacity-70 break-words">{label}</div>
    <div className="text-[28px] font-[600] mt-[4px]">{value.toLocaleString()}</div>
  </div>
);

// Renders a breakdown table of counts per social provider or client.
const PerSocialTable: FC<{ title: string; block: StatsBlock }> = ({
  title,
  block,
}) => (
  <div className="border border-newTableBorder rounded-[8px] overflow-hidden bg-newBgColorInner w-full min-w-0">
    <div className="grid grid-cols-[1fr_80px] sm:grid-cols-[1fr_120px] gap-[8px] sm:gap-[12px] px-[12px] py-[10px] bg-newBgColorInner text-[12px] uppercase opacity-70 border-b border-newTableBorder">
      <div className="truncate" title={title}>{title}</div>
      <div className="text-right">Count</div>
    </div>
    {block.perSocial.length === 0 ? (
      <div className="px-[12px] py-[10px] text-[13px] opacity-70">
        No data for this timeframe.
      </div>
    ) : (
      block.perSocial.map((row) => (
        <div
          key={row.provider}
          className="grid grid-cols-[1fr_80px] sm:grid-cols-[1fr_120px] gap-[8px] sm:gap-[12px] px-[12px] py-[10px] text-[13px] border-b border-newTableBorder last:border-b-0 items-center"
        >
          <div className="capitalize truncate" title={row.provider}>{row.provider}</div>
          <div className="text-right font-mono">{row.count.toLocaleString()}</div>
        </div>
      ))
    )}
  </div>
);

// Admin page component displaying platform usage metrics, date range filters, and social breakdowns.
export const AdminStatsComponent: FC = () => {
  const user = useUser();

  const [fromInput, setFromInput] = useState(today());
  const [toInput, setToInput] = useState(today());
  const [range, setRange] = useState({ from: today(), to: today() });
  const [unknownOnly, setUnknownOnly] = useState(false);

  const { data, isLoading, error } = useStats({ ...range, unknownOnly });

  const applyRange = useCallback((next: { from: string; to: string }) => {
    setFromInput(next.from);
    setToInput(next.to);
    setRange(next);
  }, []);

  if (!user?.isSuperAdmin) {
    return (
      <div className="text-textColor p-[20px]">
        You do not have access to this page.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[16px] text-textColor w-full min-w-0">
      <div className="flex flex-wrap gap-[8px] items-center justify-between">
        <div className="text-[20px] font-[600]">Admin Stats</div>
        {data && (
          <div className="text-[13px] opacity-70">
            {new Date(data.from).toLocaleDateString()} —{' '}
            {new Date(data.to).toLocaleDateString()}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-[8px]">
        {PRESETS.map((preset) => {
          const next = preset.range();
          const active = range.from === next.from && range.to === next.to;
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyRange(next)}
              className={`h-[36px] sm:h-[32px] px-[12px] rounded-[8px] text-[13px] border cursor-pointer whitespace-nowrap ${
                active
                  ? 'bg-forth text-white border-forth'
                  : 'bg-newBgColorInner text-textColor border-newTableBorder hover:bg-tableBorder'
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-[8px] sm:gap-[12px] items-stretch sm:items-end bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[12px]">
        <div className="flex flex-col gap-[6px] flex-1 sm:flex-none min-w-[130px]">
          <div className="text-[12px] opacity-70">From</div>
          <input
            type="date"
            value={fromInput}
            max={toInput}
            onChange={(e) => setFromInput(e.target.value)}
            className="bg-newBgColorInner h-[38px] border border-newTableBorder rounded-[8px] px-[10px] text-[14px] text-textColor w-full"
          />
        </div>
        <div className="flex flex-col gap-[6px] flex-1 sm:flex-none min-w-[130px]">
          <div className="text-[12px] opacity-70">To</div>
          <input
            type="date"
            value={toInput}
            min={fromInput}
            max={today()}
            onChange={(e) => setToInput(e.target.value)}
            className="bg-newBgColorInner h-[38px] border border-newTableBorder rounded-[8px] px-[10px] text-[14px] text-textColor w-full"
          />
        </div>
        <div className="flex items-end">
          <Button
            className="min-h-[38px]"
            onClick={() => setRange({ from: fromInput, to: toInput })}
            disabled={!fromInput || !toInput || fromInput > toInput}
          >
            Apply
          </Button>
        </div>

        <label
          className="flex items-center gap-[6px] text-[13px] cursor-pointer h-[38px] select-none"
          title='Only count errors whose message matches "message":"Unknown Error" (affects the error stats only)'
        >
          <input
            type="checkbox"
            checked={unknownOnly}
            onChange={(e) => setUnknownOnly(e.target.checked)}
          />
          Unknown errors only
        </label>
      </div>

      {isLoading ? (
        <LoadingComponent />
      ) : error || !data ? (
        <div className="text-red-400">Failed to load stats.</div>
      ) : (
        <div className="flex flex-col gap-[16px] w-full min-w-0">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-[16px] min-w-0">
            <SummaryCard
              label="Total posts published"
              value={data.posts.total}
            />
            <SummaryCard
              label="Total connected accounts"
              value={data.connected.total}
            />
            <SummaryCard
              label={unknownOnly ? 'Total unknown errors' : 'Total errors'}
              value={data.errors.total}
            />
            {data.publishingChannels && (
              <SummaryCard
                label="Unique channels - published (all platforms combined)"
                value={data.publishingChannels.total}
              />
            )}
            {data.scheduledChannels && (
              <SummaryCard
                label="Unique channels - scheduled (all platforms combined)"
                value={data.scheduledChannels.total}
              />
            )}
            {data.publishingAccounts && (
              <SummaryCard
                label="Unique users - published (all platforms combined)"
                value={data.publishingAccounts.total}
              />
            )}
            {data.scheduledAccounts && (
              <SummaryCard
                label="Unique users - scheduled (all platforms combined)"
                value={data.scheduledAccounts.total}
              />
            )}
            {data.activeOrgsBySource && (
              <SummaryCard
                label="Unique users - active (all sources combined)"
                value={data.activeOrgsBySource.total}
              />
            )}
            {data.connectedClients && (
              <SummaryCard
                label="Connected clients (all clients combined)"
                value={data.connectedClients.total}
              />
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-[16px] items-start min-w-0">
            <PerSocialTable
              title="Posts published per social"
              block={data.posts}
            />
            <PerSocialTable
              title="Connected accounts per social"
              block={data.connected}
            />
            <PerSocialTable
              title={
                unknownOnly
                  ? 'Unknown errors per social'
                  : 'Errors per social'
              }
              block={data.errors}
            />
            {data.publishingChannels && (
              <PerSocialTable
                title="Unique channels - published"
                block={data.publishingChannels}
              />
            )}
            {data.scheduledChannels && (
              <PerSocialTable
                title="Unique channels - scheduled"
                block={data.scheduledChannels}
              />
            )}
            {data.publishingAccounts && (
              <PerSocialTable
                title="Unique users - published"
                block={data.publishingAccounts}
              />
            )}
            {data.scheduledAccounts && (
              <PerSocialTable
                title="Unique users - scheduled"
                block={data.scheduledAccounts}
              />
            )}
            {data.activeOrgsBySource && (
              <PerSocialTable
                title="Active users per source"
                block={data.activeOrgsBySource}
              />
            )}
            {data.connectedClients && (
              <PerSocialTable
                title="Connected clients per name"
                block={data.connectedClients}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
