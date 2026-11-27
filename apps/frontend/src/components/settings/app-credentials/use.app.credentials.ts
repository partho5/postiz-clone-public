'use client';

// Workspace app credentials (T4): the providers that need the keys of a developer app, and what
// the current workspace has set, loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useUser } from '@gitroom/frontend/components/layout/user.context';

export interface AppCredentialField {
  key: string;
  label: string;
  secret: boolean;
  optional: boolean;
  set: boolean;
  value: string | null;
  usedBy: string[];
}

export interface AppCredentialsProvider {
  identifier: string;
  name: string;
  callbackUrl: string | null;
  guideUrl: string;
  configured: boolean;
  fields: AppCredentialField[];
}

// The list answer was not ok; carries the status so the card can tell "admins only" from a failure.
export class AppCredentialsLoadError extends Error {
  // Keeps the refused answer's status on the error.
  constructor(public status: number) {
    super(`GET /app-credentials answered ${status}`);
  }
}

// The current workspace's providers and keys; keyed by workspace so one workspace's answer is never
// shown in another.
export const useAppCredentials = () => {
  const fetch = useFetch();
  const user = useUser();
  // Reads the list; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(async () => {
    const response = await fetch('/app-credentials');
    if (!response.ok) {
      throw new AppCredentialsLoadError(response.status);
    }
    return response.json();
  }, [fetch]);

  return useSWR<AppCredentialsProvider[]>(
    user?.orgId ? ['/app-credentials', user.orgId] : null,
    load
  );
};
