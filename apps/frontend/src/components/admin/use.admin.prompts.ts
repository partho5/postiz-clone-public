'use client';

// Prompt Book (ai.video-captions): the owner's view of the book, loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export interface AdminPrompt {
  key: string;
  label: string;
  group: 'frame' | 'general' | 'video' | 'text';
  provider?: string;
  locked: boolean;
  body: string;
  model: string;
  reasoningEffort: string;
  version: number;
  note: string | null;
  createdAt: string;
}

export interface AdminPromptVersion {
  version: number;
  body: string;
  model: string;
  reasoningEffort: string;
  note: string | null;
  createdById: string | null;
  createdAt: string;
}

// Every prompt of the book with its current default, locked frames included.
export const useAdminPrompts = () => {
  const fetch = useFetch();
  // Reads the list; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(async () => {
    const response = await fetch('/admin/prompts');
    if (!response.ok) {
      throw new Error(`GET /admin/prompts answered ${response.status}`);
    }
    return response.json();
  }, [fetch]);

  return useSWR<AdminPrompt[]>('/admin/prompts', load);
};

// Every stored version of one default, newest first; nothing is read while `key` is null.
export const useAdminPromptHistory = (key: string | null) => {
  const fetch = useFetch();
  // Reads the versions; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(async () => {
    const response = await fetch(
      `/admin/prompts/${encodeURIComponent(key!)}/history`
    );
    if (!response.ok) {
      throw new Error(`GET /admin/prompts/${key}/history answered ${response.status}`);
    }
    return response.json();
  }, [fetch, key]);

  return useSWR<AdminPromptVersion[]>(
    key ? `/admin/prompts/${key}/history` : null,
    load
  );
};
