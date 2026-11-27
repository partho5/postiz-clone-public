'use client';

// AI captions (ai.video-captions): the captions of the workspace and one caption, loaded from the server.
import { useCallback } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export type AiCaptionStatus =
  | 'PENDING'
  | 'TRANSCRIBING'
  | 'GENERATING'
  | 'READY'
  | 'NO_SPEECH'
  | 'FAILED';

// The states a caption is still being made in; its page follows it until it ends.
const IN_PROGRESS: AiCaptionStatus[] = ['PENDING', 'TRANSCRIBING', 'GENERATING'];

// How often (ms) a caption that is still being made is asked for again.
const FOLLOW_EVERY = 5000;

export const isInProgress = (status: AiCaptionStatus) =>
  IN_PROGRESS.includes(status);

export interface AiCaptionListItem {
  id: string;
  createdAt: string;
  title: string | null;
  status: AiCaptionStatus;
  channels: { integrationId: string; provider: string; picture: string | null }[];
}

export interface AiCaptionsPage {
  items: AiCaptionListItem[];
  pages: number;
}

export interface AiCaptionOutput {
  integrationId: string;
  provider: string;
  kind: 'video' | 'text';
  title?: string;
  text: string;
  postId?: string;
  postGroup?: string;
  // missing when the post was deleted
  postState?: 'QUEUE' | 'PUBLISHED' | 'ERROR' | 'DRAFT';
  publishDate?: string;
}

export interface AiCaptionDetail {
  id: string;
  status: AiCaptionStatus;
  error?: string;
  language?: string;
  title?: string;
  createdAt: string;
  transcript?: string;
  outputs: AiCaptionOutput[];
}

// The key of the page after `previous`; null once the previous page was the last.
const pageKey = (index: number, previous: AiCaptionsPage | null) => {
  if (previous && index >= previous.pages) {
    return null;
  }
  return `/ai-captions?page=${index + 1}`;
};

// Every loaded page of the workspace's captions, newest first; `setSize` loads the next one.
export const useAiCaptions = () => {
  const fetch = useFetch();
  // Reads a page; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(
    async (path: string): Promise<AiCaptionsPage> => {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`GET ${path} answered ${response.status}`);
      }
      return response.json();
    },
    [fetch]
  );

  return useSWRInfinite<AiCaptionsPage>(pageKey, load);
};

// One caption with its transcript and texts; nothing is read while `id` is null. A caption that is still being
// made is asked for again until it ends.
export const useAiCaption = (id: string | null) => {
  const fetch = useFetch();
  // Reads the caption; a refused or failed answer becomes an error so SWR never holds it as data.
  const load = useCallback(
    async (path: string): Promise<AiCaptionDetail> => {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`GET ${path} answered ${response.status}`);
      }
      return response.json();
    },
    [fetch]
  );

  return useSWR<AiCaptionDetail>(
    id ? `/ai-captions/${encodeURIComponent(id)}` : null,
    load,
    {
      refreshInterval: (latest) =>
        latest && isInProgress(latest.status) ? FOLLOW_EVERY : 0,
    }
  );
};
