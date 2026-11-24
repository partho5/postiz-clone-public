'use client';

// Recurring charging: the "can't be paid" marker on a repeating post in the calendar,
// shown while the server flags its next occurrence.
import React, { FC, useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { uniq } from 'lodash';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useCalendar } from '@gitroom/frontend/components/launches/calendar.context';
import { WorkspaceLink } from '@gitroom/frontend/components/layout/workspace.navigation';
import { newDayjs } from '@gitroom/frontend/components/layout/set.timezone';
import { isUSCitizen } from '@gitroom/frontend/components/launches/helpers/isuscitizen.utils';

// A repeating post whose next occurrence could not be reserved, as the server reports it.
interface RecurringFlag {
  occurrence: number;
  dueAt: string;
  reason: 'INSUFFICIENT_CREDITS';
  since: string;
}

// The flags of the repeating posts the calendar shows, loaded once for all of them.
export const useRecurringFlags = () => {
  const fetch = useFetch();
  const { posts, listPosts } = useCalendar();
  const ids = useMemo(
    () =>
      uniq(
        [...posts, ...listPosts]
          .filter((p) => p.intervalInDays)
          .map((p) => p.id)
      )
        .sort()
        .join(','),
    [posts, listPosts]
  );
  const load = useCallback(async () => {
    return (await fetch(`/posts/recurring-flags?ids=${ids}`)).json();
  }, [ids, fetch]);

  return useSWR<Record<string, RecurringFlag>>(
    ids ? `/posts/recurring-flags?ids=${ids}` : null,
    load
  );
};

// The marker on one post: can't be paid, the due date of that occurrence, and a link to top up.
export const CreditFlag: FC<{ postId: string }> = ({ postId }) => {
  const t = useT();
  const { data } = useRecurringFlags();
  const flag = data?.[postId];
  if (!flag) {
    return null;
  }

  const due = newDayjs(flag.dueAt)
    .local()
    .format(isUSCitizen() ? 'MM/DD hh:mm A' : 'DD/MM HH:mm');

  return (
    <div
      className="flex flex-col mt-[2px] px-[8px] py-[4px] rounded-[6px] bg-red-500/15 text-red-400 text-[11px]"
      data-tooltip-id="tooltip"
      data-tooltip-content={t(
        'recurring_cant_be_paid_tooltip',
        "Your credits don't cover the next repeat of this post. Top up before it is due, or it will be skipped."
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="font-[600]">{t('cant_be_paid', "Can't be paid")}</div>
      <div className="whitespace-nowrap">
        {t('due', 'Due')} {due}
      </div>
      <WorkspaceLink href="/billing" className="underline whitespace-nowrap">
        {t('top_up', 'Top up')}
      </WorkspaceLink>
    </div>
  );
};
