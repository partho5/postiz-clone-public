'use client';

// Device sessions: the signed-in devices of the user, loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export interface DeviceSession {
  id: string;
  name: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

// The user's live device sessions, newest activity first.
export const useSessions = () => {
  const fetch = useFetch();
  const load = useCallback(async () => {
    return (await fetch('/auth/sessions')).json();
  }, [fetch]);

  return useSWR<DeviceSession[]>('/auth/sessions', load);
};
