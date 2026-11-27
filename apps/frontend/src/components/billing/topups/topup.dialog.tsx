// Feature: Billing Credit Pack Top-Up Dialog
'use client';

// PayPal top-ups: the dialog where the account owner picks a credit pack and is sent to PayPal.
import React, { FC, useCallback, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useIdempotencyKey } from '@gitroom/frontend/components/layout/use.idempotency.key';
import {
  TopupPack,
  useTopupPacks,
} from '@gitroom/frontend/components/billing/topups/use.topup';

// A price in cents as the pack's currency writes it.
const formatPrice = (cents: number, currency: string) =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency });

// The credit pack list: choosing one creates the order and sends the owner to PayPal to pay.
export const TopupDialog: FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = useT();
  const fetch = useFetch();
  const idempotency = useIdempotencyKey();
  const { data, isLoading } = useTopupPacks();
  const [busyPack, setBusyPack] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Creates the order for a pack and opens PayPal's approval page; shows why it failed otherwise.
  const buy = useCallback(
    async (pack: TopupPack) => {
      setBusyPack(pack.key);
      setMessage(null);
      try {
        const response = await fetch('/billing/topups', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotency.key(pack.key) },
          body: JSON.stringify({ packKey: pack.key }),
        });
        if (response.status < 500) {
          idempotency.reset();
        }
        const answer = await response.json();
        if (!response.ok) {
          setMessage(
            answer?.code === 'NOT_ACCOUNT_OWNER'
              ? t(
                  'only_owner_buys_credits',
                  'Only the account owner can buy credits. Ask the owner to do it.'
                )
              : answer?.code === 'BILLING_NOT_CONFIGURED'
              ? t(
                  'billing_not_available',
                  'Buying credits is not available right now.'
                )
              : answer?.code === 'PAYMENT_PROVIDER_ERROR' && answer?.message
              ? answer.message
              : t('topup_failed', 'This did not work. Try again.')
          );
          return;
        }
        window.location.assign(answer.approveUrl);
      } finally {
        setBusyPack(null);
      }
    },
    [fetch, idempotency, t]
  );

  if (isLoading || !data) {
    return <LoadingComponent />;
  }

  return (
    <div className="flex flex-col gap-[16px] w-full min-w-0">
      <div className="text-textItemBlur">
        {t(
          'topup_intro',
          'Extra credits are added when PayPal confirms your payment, and they never expire.'
        )}
      </div>
      {message && <div className="text-red-400">{message}</div>}
      <div className="flex flex-col gap-[12px]">
        {data.topupPacks.map((pack) => (
          <div
            key={pack.key}
            className="flex items-center justify-between gap-[12px] sm:gap-[16px] bg-newBgColorInner rounded-[12px] p-[12px] sm:p-[16px] border border-newTableBorder"
          >
            <div className="flex flex-col min-w-0">
              <div className="text-[16px] sm:text-[18px] font-[600] truncate">
                {pack.credits} {t('credits', 'credits')}
              </div>
              <div className="text-textItemBlur text-[14px]">
                {formatPrice(pack.priceCents, pack.currency)}
              </div>
            </div>
            <Button
              className="min-h-[44px] shrink-0"
              loading={busyPack === pack.key}
              disabled={!!busyPack}
              onClick={() => buy(pack)}
            >
              {t('buy', 'Buy')}
            </Button>
          </div>
        ))}
      </div>
      <Button secondary={true} onClick={onClose} className="min-h-[44px] w-full">
        {t('close', 'Close')}
      </Button>
    </div>
  );
};
