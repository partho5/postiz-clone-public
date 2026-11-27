'use client';

// Brand profile: the current workspace's brand, loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { BrandView } from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';

// The brand of the workspace in this tab: typed fields and the creative profile.
export const useCurrentBrand = () => {
  const fetch = useFetch();
  // Reads the brand; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(async () => {
    const response = await fetch('/brands/current');
    if (!response.ok) {
      throw new Error(`GET /brands/current answered ${response.status}`);
    }
    return response.json();
  }, [fetch]);

  return useSWR<BrandView>('/brands/current', load);
};
