'use client';

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { usePathname, useSearchParams } from 'next/navigation';
import { useWorkspaceRouter } from '@gitroom/frontend/components/layout/workspace.navigation';
import { FC, useEffect } from 'react';
dayjs.extend(utc);
dayjs.extend(timezone);
export const IntegrationRedirectComponent: FC = () => {
  const offset = dayjs.tz().utcOffset();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useWorkspaceRouter();
  const newUrl = `${pathname}/continue?${searchParams.toString()}&timezone=${offset}`;
  useEffect(() => {
    router.push(newUrl);
  }, [newUrl]);
  return null;
};
