'use client';

// Balance header: "Available X · Reserved Y" from the server in the app header, Y linking
// to the reserved posts, and below the low-balance mark a warning with a top-up for the owner.
import React, { FC, useCallback } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { WorkspaceLink } from '@gitroom/frontend/components/layout/workspace.navigation';
import { TopupDialog } from '@gitroom/frontend/components/billing/topups/topup.dialog';
import { useCreditBalance } from '@gitroom/frontend/components/credits/balance/use.credit.balance';

// The balance line of the header; while the server is being asked it shows a pending mark instead of a number.
export const BalanceHeader: FC = () => {
  const t = useT();
  const modals = useModals();
  const { data, error, isValidating } = useCreditBalance();

  // Opens the credit pack dialog; only the account owner is offered it.
  const topUp = useCallback(() => {
    modals.openModal({
      title: t('buy_credits', 'Buy credits'),
      children: (close) => <TopupDialog onClose={close} />,
    });
  }, [modals, t]);

  if (!data && error) {
    return null;
  }

  const pending = !data || isValidating;
  // The server's number, or the pending mark while it is being asked.
  const show = (value?: number) => (pending || value === undefined ? '…' : value);

  return (
    <div
      className="flex items-center gap-[10px] text-[14px] whitespace-nowrap"
      aria-busy={pending}
    >
      <div>
        {t('available', 'Available')}{' '}
        <span className="font-[600] text-newTextColor">
          {show(data?.available)}
        </span>
      </div>
      <span>·</span>
      <WorkspaceLink
        href="/credits/reserved"
        className="hover:text-newTextColor underline"
      >
        {t('reserved', 'Reserved')}{' '}
        <span className="font-[600] text-newTextColor">
          {show(data?.reserved)}
        </span>
      </WorkspaceLink>
      {!pending && data?.low && (
        <>
          <span className="text-red-400 font-[600]">
            {t('low_credits', 'Low credits')}
          </span>
          {data.canTopUp && (
            <Button className="!h-[32px] !px-[12px]" onClick={topUp}>
              {t('top_up', 'Top up')}
            </Button>
          )}
        </>
      )}
    </div>
  );
};
