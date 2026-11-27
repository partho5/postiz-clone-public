'use client';

// Brand switcher: the brands the user can switch to, asked for only while the palette is open.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { BrandSummary } from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';

// The user's brands from the server; with `enabled` false nothing is requested.
export const useSwitcherBrands = (enabled: boolean) => {
  const fetch = useFetch();
  // Reads the brand list; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(async () => {
    const response = await fetch('/brands');
    if (!response.ok) {
      throw new Error(`GET /brands answered ${response.status}`);
    }
    return response.json();
  }, [fetch]);

  return useSWR<BrandSummary[]>(enabled ? '/brands' : null, load, {
    revalidateOnFocus: false,
  });
};
