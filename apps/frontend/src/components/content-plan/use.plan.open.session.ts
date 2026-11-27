'use client';

// Content plan: the open session of a kind (still asking, being written or waiting to be confirmed), so a page can pick
// it up where the owner left it.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { PlanSessionView } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The key the open session of a kind is cached under; a call that opens or closes a session reads it again.
export const openPlanSessionKey = (kind: string) =>
  `/content-plan/sessions/open?kind=${encodeURIComponent(kind)}`;

// The latest open session of this kind, or null when there is none (the server then answers 200 with an empty body).
export const useOpenPlanSession = (kind: string) => {
  const fetch = useFetch();
  // Reads the open session; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(
    async (path: string): Promise<PlanSessionView | null> => {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`GET ${path} answered ${response.status}`);
      }
      const body = await response.text();
      return body ? JSON.parse(body) : null;
    },
    [fetch]
  );

  return useSWR<PlanSessionView | null>(openPlanSessionKey(kind), load);
};
