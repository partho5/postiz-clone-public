'use client';

// PayPal top-ups: the page PayPal sends the buyer back to. It captures the order once and
// shows what the server says: credits granted, payment pending, or declined.
import React, { FC, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { WorkspaceLink } from '@gitroom/frontend/components/layout/workspace.navigation';
import { TopupView } from '@gitroom/frontend/components/billing/topups/use.topup';

type Result =
  | { kind: 'granted'; credits: number }
  | { kind: 'pending' }
  | { kind: 'declined' }
  | { kind: 'owner' }
  | { kind: 'failed'; message?: string };

// The result the server's answer to the capture call stands for.
const resultOf = async (response: Response): Promise<Result> => {
  const answer = await response.json();
  if (response.ok) {
    const view = answer as TopupView;
    return view.status === 'CAPTURED' && view.grantedAt
      ? { kind: 'granted', credits: view.credits }
      : { kind: 'pending' };
  }
  if (answer?.code === 'PAYMENT_DECLINED') {
    return { kind: 'declined' };
  }
  if (answer?.code === 'NOT_ACCOUNT_OWNER') {
    return { kind: 'owner' };
  }
  // PayPal's own reason, when the server passed it on.
  return answer?.code === 'PAYMENT_PROVIDER_ERROR' && answer?.message
    ? { kind: 'failed', message: answer.message }
    : { kind: 'failed' };
};

// Captures the order named by the `token` PayPal appended to the return URL, once, and shows the outcome.
export const TopupReturn: FC = () => {
  const t = useT();
  const fetch = useFetch();
  const searchParams = useSearchParams();
  const orderId = searchParams.get('token');
  const [result, setResult] = useState<Result | null>(
    orderId ? null : { kind: 'failed' }
  );
  const started = useRef(false);

  useEffect(() => {
    if (!orderId || started.current) {
      return;
    }
    started.current = true;
    (async () => {
      const response = await fetch(
        `/billing/topups/${encodeURIComponent(orderId)}/capture`,
        { method: 'POST' }
      );
      setResult(await resultOf(response));
    })();
  }, [orderId, fetch]);

  if (!result) {
    return <LoadingComponent />;
  }

  const text = {
    granted: `${result.kind === 'granted' ? result.credits : 0} ${t(
      'credits_added',
      'credits were added to your balance.'
    )}`,
    pending: t(
      'topup_pending',
      'PayPal is still processing your payment. Your credits are added as soon as it completes.'
    ),
    declined: t(
      'topup_declined',
      'PayPal declined the payment. Nothing was charged and no credits were added.'
    ),
    owner: t(
      'only_owner_buys_credits',
      'Only the account owner can buy credits. Ask the owner to do it.'
    ),
    failed:
      (result.kind === 'failed' && result.message) ||
      t('topup_failed', 'This did not work. Try again.'),
  }[result.kind];

  return (
    <div className="flex flex-col gap-[16px]">
      <div className="text-[24px] font-[600]">
        {t('buy_credits', 'Buy credits')}
      </div>
      <div className={result.kind === 'granted' ? '' : 'text-textItemBlur'}>
        {text}
      </div>
      <WorkspaceLink href="/billing" className="underline">
        {t('back_to_billing', 'Back to billing')}
      </WorkspaceLink>
    </div>
  );
};
