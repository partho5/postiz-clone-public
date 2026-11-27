// Activity tracker (api.activity-tracker): SWR hooks and response types for the super admin's Activity tab (/admin/tracker/*).
'use client';

import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

// One device with every column the device row holds (the log of one device answers it as `device`).
export interface TrackerDevice {
  deviceId: string;
  userId: string | null;
  email: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  appVersion: string | null;
  appBuild: number | null;
  os: string | null;
  sdk: number | null;
  manufacturer: string | null;
  model: string | null;
  locale: string | null;
  activityCount: number;
  errorCount: number;
}

// One device as the devices list shows it.
export type TrackerDeviceRow = Pick<
  TrackerDevice,
  | 'deviceId'
  | 'email'
  | 'userId'
  | 'model'
  | 'os'
  | 'appVersion'
  | 'firstSeenAt'
  | 'lastSeenAt'
  | 'activityCount'
  | 'errorCount'
>;

// One activity or error as the log returns it (without the stack and causes).
export interface TrackerActivityRow {
  id: string;
  deviceId: string;
  userId: string | null;
  sessionKey: string;
  seq: number;
  kind: 'activity' | 'error';
  name: string;
  description: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  tz: number;
  appBuild: number | null;
  screen: string | null;
  source: string | null;
  meta: Record<string, string | number | boolean> | null;
  errorType: string | null;
  errorMessage: string | null;
  errorThread: string | null;
  fatal: boolean | null;
  lastActivity: string | null;
  receivedAt: string;
}

// One full activity as the activity call returns it: every column, the error stack and causes included.
export interface TrackerActivity extends TrackerActivityRow {
  errorStack: string | null;
  errorCauses: { type?: string; message?: string }[] | null;
}

// The overview of one period: totals, top features, where sessions end, how they start and the top errors.
export interface TrackerOverview {
  since: string;
  devices: number;
  activeDevices: number;
  sessions: number;
  activities: number;
  errors: number;
  topFeatures: {
    name: string;
    description: string | null;
    devices: number;
    count: number;
  }[];
  dropOff: { screen: string; sessions: number }[];
  entrySources: { source: string | null; sessions: number }[];
  topErrors: {
    errorType: string | null;
    screen: string | null;
    count: number;
    devices: number;
    lastAt: string;
    sampleId: string | null;
  }[];
}

// One page of devices, with the cursor of the next page (null on the last one).
export interface TrackerDevicesPage {
  items: TrackerDeviceRow[];
  nextCursor: string | null;
}

// The user line of the log: a device's email, model and OS.
export type TrackerFeedDevice = Pick<
  TrackerDevice,
  'deviceId' | 'email' | 'model' | 'os'
>;

// One page of the activity log, newest first, with the devices on the page and the device itself when the log is of one device.
export interface TrackerFeedPage {
  device: TrackerDevice | null;
  items: TrackerActivityRow[];
  devices: TrackerFeedDevice[];
  nextCursor: string | null;
}

// Fetches the activity overview of the last `days` days; nothing is read while `days` is null.
export const useTrackerOverview = (days: number | null) => {
  const fetch = useFetch();
  return useSWR<TrackerOverview>(
    days === null ? null : `/admin/tracker/overview?days=${days}`,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Failed to load overview');
      }
      return res.json();
    }
  );
};

// Fetches one page of devices, filtered by the search text and the has-errors flag; `cursor` is the page before's nextCursor.
export const useTrackerDevices = (params: {
  q: string;
  hasErrors: boolean;
  cursor?: string;
}) => {
  const fetch = useFetch();
  const query = new URLSearchParams();
  if (params.q) {
    query.set('q', params.q);
  }
  if (params.hasErrors) {
    query.set('hasErrors', 'true');
  }
  if (params.cursor) {
    query.set('cursor', params.cursor);
  }
  return useSWR<TrackerDevicesPage>(
    `/admin/tracker/devices?${query.toString()}`,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Failed to load devices');
      }
      return res.json();
    }
  );
};

// Fetches one page of the activity log, newest first: one device's when `deviceId` is set, every device's otherwise.
// `cursor` is the page before's nextCursor; `at` starts the log at that activity.
export const useTrackerFeed = (params: {
  deviceId?: string;
  cursor?: string;
  at?: string;
}) => {
  const fetch = useFetch();
  const query = new URLSearchParams();
  if (params.deviceId) {
    query.set('deviceId', params.deviceId);
  }
  if (params.cursor) {
    query.set('cursor', params.cursor);
  }
  if (params.at) {
    query.set('at', params.at);
  }
  return useSWR<TrackerFeedPage>(
    `/admin/tracker/feed?${query.toString()}`,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Failed to load activity log');
      }
      return res.json();
    }
  );
};

// Fetches one full activity by its id, for the error detail; nothing is read while `id` is null.
export const useTrackerActivity = (id: string | null) => {
  const fetch = useFetch();
  return useSWR<TrackerActivity>(
    id ? `/admin/tracker/activity/${encodeURIComponent(id)}` : null,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Failed to load activity');
      }
      return res.json();
    }
  );
};
