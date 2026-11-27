'use client';

import { FC, useEffect } from 'react';
import { useWorkspaceRouter } from '@gitroom/frontend/components/layout/workspace.navigation';

// Opens a new agent chat in this tab's workspace, replacing /agents in the history
const Page: FC = () => {
  const router = useWorkspaceRouter();
  useEffect(() => {
    router.replace('/agents/new');
  }, [router]);
  return null;
};

export default Page;
