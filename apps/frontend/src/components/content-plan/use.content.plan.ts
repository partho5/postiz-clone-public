'use client';

// Content plan: the plan of the workspace (its status, the setup round or the proposal), loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { PlanView } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The key the plan is cached under; mutations write the answer they got to it.
export const CONTENT_PLAN_KEY = '/content-plan';

// How often (ms) a plan that is busy is asked for again.
const POLL_EVERY = 3000;

// The plan of the workspace in this tab; while the AI is working on it (`busy`) it is asked for again every 3 seconds.
export const useContentPlan = () => {
  const fetch = useFetch();
  // Reads the plan; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(
    async (path: string): Promise<PlanView> => {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`GET ${path} answered ${response.status}`);
      }
      return response.json();
    },
    [fetch]
  );

  return useSWR<PlanView>(CONTENT_PLAN_KEY, load, {
    refreshInterval: (latest) => (latest?.busy ? POLL_EVERY : 0),
  });
};
