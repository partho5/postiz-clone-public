'use client';

import { useMemo } from 'react';
import { useMenuItem } from '@gitroom/frontend/components/layout/top.menu';
import { useWorkspacePathname } from '@gitroom/frontend/components/layout/workspace.navigation';
export const Title = () => {
  const path = useWorkspacePathname();
  const { all: menuItems } = useMenuItem();
  const currentTitle = useMemo(() => {
    return menuItems.find((item) => path.indexOf(item.path) > -1)?.name;
  }, [path]);

  return <h1>{currentTitle}</h1>;
};
