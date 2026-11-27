'use client';

// Cost preview: what publishing to these channels costs, from the server's price list.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { postQuote } from '@gitroom/frontend/components/credits/cost/cost.request';
import { publishCostButton } from '@gitroom/frontend/components/credits/cost/publish.cost.button';

// The credits scheduling a post to these channels takes (for an edit: only the added channels).
// Nothing is asked while no channel is chosen.
export const usePublishCost = (req: {
  group?: string;
  integrationIds: string[];
}) => {
  const fetch = useFetch();
  const key = JSON.stringify({
    ...(req.group ? { group: req.group } : {}),
    integrationIds: req.integrationIds,
  });
  const load = useCallback(
    () =>
      postQuote<{ amount: number }>(fetch, '/posts/charge-preview', JSON.parse(key)),
    [fetch, key]
  );

  return useSWR<{ amount: number }>(
    req.integrationIds.length ? `publish-cost:${key}` : null,
    load,
    { revalidateOnFocus: false }
  );
};

// The publish confirm button's cost text, and whether the cost holds the button back, for these channels.
// A draft or a set (`applies: false`) asks nothing and is never held back.
export const usePublishCostButton = (
  req: { group?: string; integrationIds: string[]; applies: boolean },
  t: (key: string, fallback: string) => string
) => {
  const cost = usePublishCost({
    group: req.group,
    integrationIds: req.applies ? req.integrationIds : [],
  });

  return publishCostButton(
    {
      applies: req.applies,
      channels: req.integrationIds.length,
      cost: cost.data,
      error: cost.error,
    },
    t
  );
};
