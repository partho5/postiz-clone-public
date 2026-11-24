'use client';

// Cost preview: what an AI request costs, and how much of the free plan's monthly AI cap is used.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { postQuote } from '@gitroom/frontend/components/credits/cost/cost.request';

// The server's estimate of one AI request; `cap` is null when the plan has no AI cap.
export interface AiEstimate {
  actionKey: string;
  unitCost: number;
  units: number;
  amount: number;
  cap: { limit: number; used: number } | null;
}

// The estimate for a text, image, video, clip or captions request.
export const useAiCost = (req: {
  kind: 'text' | 'image' | 'video' | 'clip' | 'captions';
  quantity?: number;
  videoType?: string;
  videoParams?: object;
}) => {
  const fetch = useFetch();
  const key = JSON.stringify(req);
  const load = useCallback(
    () => postQuote<AiEstimate>(fetch, '/ai/quote', req),
    [fetch, key]
  );

  return useSWR<AiEstimate>(`ai-cost:${key}`, load, {
    revalidateOnFocus: false,
  });
};
