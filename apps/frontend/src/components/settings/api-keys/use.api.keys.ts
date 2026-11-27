'use client';

// Scoped API keys: the workspace's keys, loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { ApiScope } from '@gitroom/nestjs-libraries/dtos/api-keys/api.scopes';

export interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

// The list answer was not ok; carries the status so the card can tell "admins only" from a failure.
export class ApiKeysLoadError extends Error {
  // Keeps the refused answer's status on the error.
  constructor(public status: number) {
    super(`GET /workspace-keys answered ${status}`);
  }
}

// The workspace's API keys, revoked ones included, newest first; never a secret.
export const useApiKeys = () => {
  const fetch = useFetch();
  // Reads the key list; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(async () => {
    const response = await fetch('/workspace-keys');
    if (!response.ok) {
      throw new ApiKeysLoadError(response.status);
    }
    return response.json();
  }, [fetch]);

  return useSWR<ApiKeyItem[]>('/workspace-keys', load);
};
