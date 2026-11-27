'use client';

// Content plan: the week that contains today with its videos, loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { PlanWeekView } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The key the current week is cached under; changes to it ask for it again.
export const CURRENT_WEEK_KEY = '/content-plan/weeks/current';

// How often (ms) a week that is still being written is asked for again.
const POLL_EVERY = 3000;

// The current week, or null when there is none (the server answers 204). While the week is waiting to be written
// (IDEA), GENERATING or one of its videos is busy it is asked for again every 3 seconds.
export const usePlanCurrentWeek = () => {
  const fetch = useFetch();
  // Reads the week; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(
    async (path: string): Promise<PlanWeekView | null> => {
      const response = await fetch(path);
      if (response.status === 204) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`GET ${path} answered ${response.status}`);
      }
      return response.json();
    },
    [fetch]
  );

  return useSWR<PlanWeekView | null>(CURRENT_WEEK_KEY, load, {
    refreshInterval: (latest) =>
      latest &&
      (latest.status === 'IDEA' ||
        latest.status === 'GENERATING' ||
        latest.days.some((day) => day.busy))
        ? POLL_EVERY
        : 0,
  });
};
