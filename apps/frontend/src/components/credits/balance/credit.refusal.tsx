'use client';

// Balance header: the message shown when the server refuses an action for credits
// (402 INSUFFICIENT_CREDITS or AI_CAP_REACHED), with the server's numbers and, for the owner, a top-up.
import React, { FC, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { WorkspaceLink } from '@gitroom/frontend/components/layout/workspace.navigation';
import { TopupDialog } from '@gitroom/frontend/components/billing/topups/topup.dialog';
import { useCreditBalance } from '@gitroom/frontend/components/credits/balance/use.credit.balance';

// The body of a 402 the server sends for credits.
export interface CreditRefusalBody {
  code: 'INSUFFICIENT_CREDITS' | 'AI_CAP_REACHED';
  required?: number;
  available?: number;
  cap?: number;
  used?: number;
}

// Whether a 402 body is a credits refusal this screen explains.
export const isCreditRefusal = (body: any): body is CreditRefusalBody =>
  body?.code === 'INSUFFICIENT_CREDITS' || body?.code === 'AI_CAP_REACHED';

// What the server refused and with which numbers; the owner can top up from here.
export const CreditRefusal: FC<{
  refusal: CreditRefusalBody;
  onClose: () => void;
}> = ({ refusal, onClose }) => {
  const t = useT();
  const { data } = useCreditBalance();
  const [topping, setTopping] = useState(false);

  if (topping) {
    return <TopupDialog onClose={onClose} />;
  }

  return (
    <div className="flex flex-col gap-[16px] min-w-[320px]">
      <div>
        {refusal.code === 'INSUFFICIENT_CREDITS'
          ? `${t('this_needs', 'This needs')} ${refusal.required} ${t(
              'credits_and_you_have',
              'credits and you have'
            )} ${refusal.available}.`
          : `${t(
              'free_plan_includes',
              'The free plan includes'
            )} ${refusal.cap} ${t(
              'ai_credits_a_month_used',
              'AI credits a month and'
            )} ${refusal.used} ${t('are_used', 'are used.')}`}
      </div>
      <div className="flex gap-[12px] items-center">
        {data?.canTopUp && (
          <Button onClick={() => setTopping(true)}>
            {t('top_up', 'Top up')}
          </Button>
        )}
        <WorkspaceLink href="/billing" className="underline" onClick={onClose}>
          {t('see_plans', 'See plans')}
        </WorkspaceLink>
        <Button secondary={true} onClick={onClose}>
          {t('close', 'Close')}
        </Button>
      </div>
    </div>
  );
};
