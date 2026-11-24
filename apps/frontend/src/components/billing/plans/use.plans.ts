'use client';

// PayPal subscriptions: the plan tiers and the account's subscription, loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export interface PlanTier {
  key: string;
  name: string;
  monthlyPriceCents: number;
  currency: string;
  monthlyCredits: number;
  // The keys of the app features the tier grants, the free ones included
  features: string[];
}

export interface PlanSubscription {
  accountId: string;
  provider: 'paypal';
  tierKey: string;
  status: 'APPROVAL_PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED';
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface PlansView {
  tiers: PlanTier[];
  current: PlanSubscription | null;
}

// The plan tiers and the workspace account's subscription.
export const usePlans = () => {
  const fetch = useFetch();
  const load = useCallback(async () => {
    return (await fetch('/billing/plans')).json();
  }, [fetch]);

  return useSWR<PlansView>('/billing/plans', load);
};
