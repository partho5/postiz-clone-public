'use client';

// Balance header: the reserved credits of the workspace, a page at a time from the server.
import { useCallback } from 'react';
import useSWRInfinite from 'swr/infinite';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export interface ReservationItem {
  ledgerId: string;
  actionKey: string;
  amount: number;
  createdAt: string;
  postId?: string;
  integrationId?: string;
  group?: string;
  occurrence?: number;
  publishDate?: string;
}

export interface ReservationsPage {
  items: ReservationItem[];
  nextCursor: string | null;
  otherWorkspacesReserved: number;
}

// The path of the page after `previous`; null once the previous page was the last.
const pagePath = (index: number, previous: ReservationsPage | null) => {
  if (previous && !previous.nextCursor) {
    return null;
  }
  return `/credits/reservations${
    previous?.nextCursor
      ? `?cursor=${encodeURIComponent(previous.nextCursor)}`
      : ''
  }`;
};

// Every loaded page of reservations, newest first; `setSize` loads the next one.
export const useReservations = () => {
  const fetch = useFetch();
  const load = useCallback(
    async (path: string): Promise<ReservationsPage> => {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error('reservations unavailable');
      }
      return response.json();
    },
    [fetch]
  );

  return useSWRInfinite<ReservationsPage>(pagePath, load);
};
