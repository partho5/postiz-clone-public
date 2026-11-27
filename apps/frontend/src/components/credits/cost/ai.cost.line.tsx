'use client';

// Cost preview: the line beside an AI generate action: its cost, and on the free plan how much of
// the monthly AI cap is used; says so when the server could not state the cost.
import React, { FC } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { CostLabel } from '@gitroom/frontend/components/credits/cost/cost.label';
import { AiEstimate } from '@gitroom/frontend/components/credits/cost/use.ai.cost';

// The cost and cap of one AI request, from the result of `useAiCost`.
export const AiCostLine: FC<{ estimate?: AiEstimate; error?: unknown }> = ({
  estimate,
  error,
}) => {
  const t = useT();
  if (error && !estimate) {
    return (
      <span className="text-red-400">
        {t('cost_unavailable', 'Cost unavailable')}
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      <CostLabel amount={estimate?.amount} />
      {!!estimate?.cap && estimate.amount > 0 && (
        <span className="text-textItemBlur text-[12px]">
          {estimate.cap.used} {t('of', 'of')} {estimate.cap.limit}{' '}
          {t(
            'free_ai_credits_used_this_month',
            'free AI credits used this month'
          )}
        </span>
      )}
    </span>
  );
};
