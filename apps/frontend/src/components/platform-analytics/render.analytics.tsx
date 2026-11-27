// Feature: Platform Analytics - Metric Cards & Performance Charts
import { FC, useCallback, useMemo, useState } from 'react';
import { Integration } from '@prisma/client';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { ChartSocial } from '@gitroom/frontend/components/analytics/chart-social';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useAppCredentialsMissing } from '@gitroom/frontend/components/settings/app-credentials/app.credentials.missing';

interface AnalyticsDataItem {
  label: string;
  data: Array<{ total: number; date: string }>;
  average?: boolean;
  percentageChange?: number;
}

// Renders a percentage or percentage-point change indicator with directional arrow.
const TrendIndicator: FC<{ value: number; average?: boolean }> = ({
  value,
  average,
}) => {
  if (value === 0) return null;

  const isPositive = value > 0;
  const displayValue = Math.abs(value).toFixed(1);

  return (
    <div
      className={`flex items-center gap-[4px] text-[13px] font-medium ${
        isPositive ? 'text-[#32d583]' : 'text-[#f97066]'
      }`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        className={isPositive ? '' : 'rotate-180'}
      >
        <path d="M6 2.5L10 7.5H2L6 2.5Z" fill="currentColor" />
      </svg>
      <span>
        {displayValue}
        {average ? 'pp' : '%'}
      </span>
    </div>
  );
};

// Renders an individual metric card with trend, chart line, and summarized value.
const AnalyticsCard: FC<{
  item: AnalyticsDataItem;
  total: string | number;
  index: number;
}> = ({ item, total, index }) => {
  const colorVariants = ['purple', 'green', 'blue'] as const;
  const color = colorVariants[index % colorVariants.length];

  const hasDataPoints = item.data.length >= 1;

  return (
    <div className="group relative min-w-0">
      <div
        className={`
          flex flex-col h-full
          bg-newTableHeader
          border border-newTableBorder
          rounded-[12px]
          overflow-hidden
          transition-all duration-200
          hover:border-btnPrimary/50
        `}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-[14px] sm:px-[16px] pt-[14px] pb-[8px] gap-[8px]">
          <div className="flex items-center gap-[8px] sm:gap-[10px] min-w-0">
            <div
              className={`
                w-[8px] h-[8px] rounded-full shrink-0
                ${color === 'purple' ? 'bg-btnPrimary' : ''}
                ${color === 'green' ? 'bg-[#32d583]' : ''}
                ${color === 'blue' ? 'bg-[#1d9bf0]' : ''}
              `}
            />
            <span className="text-[14px] sm:text-[15px] font-medium text-newTableText truncate">
              {item.label}
            </span>
          </div>
          {item.percentageChange !== undefined && (
            <div className="shrink-0">
              <TrendIndicator
                value={item.percentageChange}
                average={item.average}
              />
            </div>
          )}
        </div>

        {/* Content */}
        {hasDataPoints ? (
          <>
            {/* Chart */}
            <div className="flex-1 px-[10px] sm:px-[12px] py-[8px] min-w-0">
              <div className="h-[120px] relative w-full overflow-hidden">
                <ChartSocial
                  data={item.data}
                  color={color}
                  key={`chart-${index}`}
                />
              </div>
            </div>

            {/* Value */}
            <div className="px-[14px] sm:px-[16px] pb-[14px]">
              <div className="text-[28px] sm:text-[36px] leading-[34px] sm:leading-[42px] font-semibold tracking-tight truncate">
                {total}
              </div>
            </div>
          </>
        ) : (
          /* Single value display */
          <div className="flex-1 flex flex-col items-center justify-center py-[24px] sm:py-[32px] px-[16px]">
            <div className="text-[36px] sm:text-[48px] leading-[44px] sm:leading-[56px] font-semibold tracking-tight truncate">
              {total}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Displays an empty or unrefreshed state prompt with an action button to refresh.
const EmptyState: FC<{ onRefresh: () => void }> = ({ onRefresh }) => {
  const t = useT();

  return (
    <div className="col-span-full flex flex-col items-center justify-center py-[36px] sm:py-[48px] px-[16px] sm:px-[24px] bg-newTableHeader border border-newTableBorder rounded-[12px] text-center">
      <div className="w-[48px] h-[48px] mb-[16px] rounded-full bg-btnPrimary/10 flex items-center justify-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-btnPrimary"
        >
          <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          <path d="M12 8v4l2 2" />
        </svg>
      </div>
      <p className="text-[14px] sm:text-[15px] text-newTableText text-center mb-[12px] max-w-[340px]">
        {t(
          'this_channel_needs_to_be_refreshed',
          'This channel needs to be refreshed to display analytics'
        )}
      </p>
      <button
        onClick={onRefresh}
        className="inline-flex items-center gap-[6px] px-[16px] py-[8px] text-[14px] font-medium text-white bg-btnPrimary hover:bg-[#5023b8] rounded-[8px] transition-colors"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M23 4v6h-6M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
        </svg>
        {t('refresh_channel', 'Refresh Channel')}
      </button>
    </div>
  );
};

// Loads and renders responsive metric cards and charts for the active social channel.
export const RenderAnalytics: FC<{
  integration: Integration;
  date: number;
}> = (props) => {
  const { integration, date } = props;
  const [loading, setLoading] = useState(true);
  const fetch = useFetch();
  const appCredentialsMissing = useAppCredentialsMissing();

  const load = useCallback(async () => {
    setLoading(true);
    const load = (
      await fetch(`/analytics/${integration.id}?date=${date}`)
    ).json();
    setLoading(false);
    return load;
  }, [integration, date]);

  const { data } = useSWR(`/analytics-${integration?.id}-${date}`, load, {
    refreshInterval: 0,
    refreshWhenHidden: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    refreshWhenOffline: false,
    revalidateOnMount: true,
  });

  const refreshChannel = useCallback(
    (
        integrationData: Integration & {
          identifier: string;
        }
      ) =>
      async () => {
        const answer = await (
          await fetch(
            `/integrations/social/${integrationData.identifier}?refresh=${integrationData.internalId}`,
            {
              method: 'GET',
            }
          )
        ).json();
        if (appCredentialsMissing(answer)) {
          return;
        }
        window.location.href = answer.url;
      },
    []
  );

  const t = useT();

  const totals = useMemo(() => {
    return data?.map((p: AnalyticsDataItem) => {
      const value =
        (p?.data.reduce(
          (acc: number, curr: { total: number }) => acc + curr.total,
          0
        ) || 0) / (p.average ? p.data.length : 1);
      if (p.average) {
        return value.toFixed(2) + '%';
      }
      return new Intl.NumberFormat().format(Math.round(value));
    });
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-[48px]">
        <LoadingComponent />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[16px] min-w-0">
      {data?.length === 0 && (
        <EmptyState onRefresh={refreshChannel(integration as any)} />
      )}
      {data?.map((item: AnalyticsDataItem, index: number) => (
        <AnalyticsCard
          key={`analytics-${index}`}
          item={item}
          total={totals[index]}
          index={index}
        />
      ))}
    </div>
  );
};
