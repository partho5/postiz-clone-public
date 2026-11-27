'use client';

import { useVariables } from '@gitroom/react/helpers/variable.context';
import { Analytics as DubAnalyticsIn } from '@dub/analytics/react';
import { getCookie } from 'react-use-cookie';
import { PRODUCT_DOMAIN } from '@gitroom/helpers/brand/brand.identity';

// Mounts the referral analytics script for the product domain when it is enabled.
export const DubAnalytics = () => {
  const { dub } = useVariables();
  if (!dub) return null;
  return (
    <DubAnalyticsIn
      domainsConfig={{
        refer: PRODUCT_DOMAIN,
      }}
    />
  );
};

export const useDubClickId = () => {
  const { dub } = useVariables();
  if (!dub) return undefined;

  const dubCookie = getCookie('dub_partner_data', '{}');
  return JSON.parse(dubCookie)?.clickId || undefined;
};
