'use client';

// Prompt Book (ai.video-captions): the workspace's AI prompts, loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useUser } from '@gitroom/frontend/components/layout/user.context';

export interface PromptBookItem {
  key: string;
  label: string;
  group: 'general' | 'video' | 'text';
  provider?: string;
  body: string;
  isDefault: boolean;
  version?: number;
}

// Every editable prompt of the current workspace: its own text, else the default's; keyed by
// workspace so one workspace's answer is never shown in another.
export const usePromptBook = () => {
  const fetch = useFetch();
  const user = useUser();
  // Reads the list; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(async () => {
    const response = await fetch('/prompt-book');
    if (!response.ok) {
      throw new Error(`GET /prompt-book answered ${response.status}`);
    }
    return response.json();
  }, [fetch]);

  return useSWR<PromptBookItem[]>(
    user?.orgId ? ['/prompt-book', user.orgId] : null,
    load
  );
};
