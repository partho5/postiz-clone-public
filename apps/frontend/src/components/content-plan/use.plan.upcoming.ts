'use client';

// Content plan: the weeks after the current one, each with its idea, loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { PlanUpcomingView } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The key the coming weeks are cached under; changes to them ask for them again.
export const UPCOMING_KEY = '/content-plan/weeks/upcoming';

// The weeks after the current one, in date order.
export const usePlanUpcoming = () => {
  const fetch = useFetch();
  // Reads the weeks; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(
    async (path: string): Promise<PlanUpcomingView[]> => {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`GET ${path} answered ${response.status}`);
      }
      return response.json();
    },
    [fetch]
  );

  return useSWR<PlanUpcomingView[]>(UPCOMING_KEY, load);
};
