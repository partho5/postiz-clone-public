'use client';

// Balance header: the server's balance of the workspace's account, loaded once, kept fresh
// on focus and every minute, and revalidated by whatever just changed it.
import { useCallback } from 'react';
import useSWR, { mutate } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export interface BalanceView {
  available: number;
  reserved: number;
  plan: string;
  allotment: number;
  low: boolean;
  canTopUp: boolean;
}

export const BALANCE_KEY = '/credits/balance';

// The balance as the server states it; an answer that is not a balance is an error, never a number.
export const useCreditBalance = () => {
  const fetch = useFetch();
  const load = useCallback(async () => {
    const response = await fetch(BALANCE_KEY);
    if (!response.ok) {
      throw new Error('balance unavailable');
    }
    return response.json();
  }, [fetch]);

  return useSWR<BalanceView>(BALANCE_KEY, load, {
    revalidateOnFocus: true,
    refreshInterval: 60000,
    refreshWhenHidden: false,
  });
};

// Asks the server for the balance again, after something that may have changed it.
export const mutateCreditBalance = async () => {
  await mutate(BALANCE_KEY);
};

// The agent chat's "run in progress" callback: once a run has ended, asks the server for the balance.
export const refreshCreditBalanceAfterRun = (inProgress: boolean) => {
  if (!inProgress) {
    mutateCreditBalance();
  }
};
