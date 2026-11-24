'use client';

// Quick start: how many posts the workspace has in one state, to tell whether a first post exists.
import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { expandPostsList } from '@gitroom/helpers/utils/posts.list.minify';

// The number of posts in the state (`scheduled` or `published`), read from the server's posts list.
export const usePostTotal = (state: 'scheduled' | 'published') => {
  const fetch = useFetch();
  // Reads one page of one post and returns the total; a refused answer becomes an error.
  const load = useCallback(
    async (path: string) => {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`GET ${path} answered ${response.status}`);
      }
      return expandPostsList(await response.json()).total as number;
    },
    [fetch]
  );

  return useSWR<number>(`/posts/list?state=${state}&limit=1`, load);
};
