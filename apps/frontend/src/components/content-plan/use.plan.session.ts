'use client';

// Content plan: one session of the planning engine (its status, the round of questions or the proposal), loaded from the
// server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { PlanSessionView } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The key a session is cached under; mutations write the answer they got to it.
export const planSessionKey = (id: string) => `/content-plan/sessions/${id}`;

// How often (ms) a session that is busy is asked for again.
const POLL_EVERY = 3000;

// The session with this id (nothing is loaded while `id` is null); while the AI is writing its proposal (PROPOSING) or
// is busy it is asked for again every 3 seconds.
export const usePlanSession = (id: string | null) => {
  const fetch = useFetch();
  // Reads the session; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(
    async (path: string): Promise<PlanSessionView> => {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`GET ${path} answered ${response.status}`);
      }
      return response.json();
    },
    [fetch]
  );

  return useSWR<PlanSessionView>(id ? planSessionKey(id) : null, load, {
    refreshInterval: (latest) =>
      latest && (latest.status === 'PROPOSING' || latest.busy) ? POLL_EVERY : 0,
  });
};
