'use client';

// Cost preview: a note naming the price of an action (channel connect, brand create); shown only
// when that price is above 0, and says so when the server could not state it.
import React, { FC } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { CostLabel } from '@gitroom/frontend/components/credits/cost/cost.label';
import { useActionCost } from '@gitroom/frontend/components/credits/cost/use.action.cost';

// "<label>: N credits" for a paid action; nothing while loading, nothing for a free one.
export const ActionCostNote: FC<{ actionKey: string; label: string }> = ({
  actionKey,
  label,
}) => {
  const t = useT();
  const { data, error } = useActionCost(actionKey);
  if (error && !data) {
    return (
      <div className="text-red-400">
        {t('cost_unavailable', 'Cost unavailable')}
      </div>
    );
  }
  if (!data || data.amount === 0) {
    return null;
  }
  return (
    <div>
      {label}: <CostLabel amount={data.amount} />
    </div>
  );
};
