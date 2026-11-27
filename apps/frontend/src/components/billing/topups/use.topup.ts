'use client';

// PayPal top-ups: the credit packs an owner can buy, loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export interface TopupPack {
  key: string;
  credits: number;
  priceCents: number;
  currency: string;
}

export interface TopupView {
  orderId: string;
  packKey: string;
  credits: number;
  priceCents: number;
  currency: string;
  status: 'CREATED' | 'APPROVED' | 'CAPTURED' | 'FAILED';
  grantedAt: string | null;
}

// The credit packs from the pricing file.
export const useTopupPacks = () => {
  const fetch = useFetch();
  const load = useCallback(async () => {
    return (await fetch('/credits/pricing')).json();
  }, [fetch]);

  return useSWR<{ topupPacks: TopupPack[] }>('/credits/pricing', load);
};
