// Activity tracker (api.activity-tracker): /super-admin/activity/[deviceId], one device's header and its activity log.
'use client';

import React, { FC, ReactNode } from 'react';
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
  useTrackerFeed,
} from '@gitroom/frontend/components/admin/tracker/tracker.hooks';
import { TrackerLog } from '@gitroom/frontend/components/admin/tracker/tracker.log';

// Shows a date and time in the viewer's zone, such as "2026-11-21 13:05".
const dateTime = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm');

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

// The device header: who it is (email or anonymous), the device id with a copy button, model and OS, app version,
// first and last seen, totals, a back link to the Activity tab and, when the log was opened at one activity, a link to its latest lines.
const ReplayHeader: FC<{ device: TrackerDevice; opened: boolean }> = ({
  device,
  opened,
}) => {
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
        <div className="flex flex-col items-end gap-[4px] text-[13px]">
          <WorkspaceLink href="/super-admin/activity" className="opacity-80 underline">
            {t('activity_back', 'Back to activity')}
          </WorkspaceLink>
          {opened ? (
            <WorkspaceLink
              href={`/super-admin/activity/${device.deviceId}`}
              className="opacity-80 underline"
            >
              {t('activity_show_latest', 'Show latest')}
            </WorkspaceLink>
          ) : null}
        </div>
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

// One device: its header and its activity log. `?at=<activityId>` (from Top errors) opens the log at that activity.
export const TrackerReplay: FC<{ deviceId: string }> = ({ deviceId }) => {
  const t = useT();
  const searchParams = useSearchParams();
  const at = searchParams.get('at') ?? undefined;
  // The same first page the log reads, so SWR answers both from one request.
  const { data, error } = useTrackerFeed({ deviceId, at });

  return (
    <div className="flex flex-col gap-[16px] text-textColor w-full min-w-0">
      {data?.device ? (
        <ReplayHeader device={data.device} opened={!!at} />
      ) : error ? (
        <div className="text-red-400">
          {t('activity_device_failed', 'Failed to load the device.')}
        </div>
      ) : (
        <LoadingComponent />
      )}
      {data?.device ? <TrackerLog key={at ?? ''} deviceId={deviceId} at={at} /> : null}
    </div>
  );
};
