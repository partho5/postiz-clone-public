'use client';

// Cost preview: the price of one named billable action (brand create, channel connect).
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { postQuote } from '@gitroom/frontend/components/credits/cost/cost.request';

// The total price of `quantity` of an action for the workspace's plan.
export const useActionCost = (actionKey: string, quantity?: number) => {
  const fetch = useFetch();
  const load = useCallback(
    () =>
      postQuote<{ amount: number }>(fetch, '/credits/quote', {
        actionKey,
        ...(quantity === undefined ? {} : { quantity }),
      }),
    [fetch, actionKey, quantity]
  );

  return useSWR<{ amount: number }>(
    `action-cost:${actionKey}:${quantity ?? ''}`,
    load,
    { revalidateOnFocus: false }
  );
};
