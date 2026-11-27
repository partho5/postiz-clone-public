'use client';

import { FC, useEffect } from 'react';
import { useWorkspaceRouter } from '@gitroom/frontend/components/layout/workspace.navigation';
export const Redirect: FC<{
  url: string;
  delay: number;
}> = (props) => {
  const { url, delay } = props;
  const router = useWorkspaceRouter();
  useEffect(() => {
    setTimeout(() => {
      router.push(url);
    }, delay);
  }, []);
  return null;
};
