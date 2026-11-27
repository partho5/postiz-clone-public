'use client';

// Content plan: sends one change to the plan (a POST or PUT under /content-plan), shows the server's `code` as a
// friendly line and keeps the cached plan in step with the answer.
import { useCallback, useState } from 'react';
import { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useIdempotencyKey } from '@gitroom/frontend/components/layout/use.idempotency.key';
import { CONTENT_PLAN_KEY } from '@gitroom/frontend/components/content-plan/use.content.plan';
import { CURRENT_WEEK_KEY } from '@gitroom/frontend/components/content-plan/use.plan.current.week';
import { UPCOMING_KEY } from '@gitroom/frontend/components/content-plan/use.plan.upcoming';
import { PlanView } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The conflicts that mean the page showed an old plan: the plan, the week and the coming weeks are read again.
const STALE_CODES = [
  'ROUND_STALE',
  'PROPOSAL_STALE',
  'PLAN_BUSY',
  'PLAN_EXISTS',
  'PLAN_NOT_ACTIVE',
  'WEEK_LOCKED',
  'DAY_LOCKED',
  'WEEK_NOT_FOUND',
  'DAY_NOT_FOUND',
];

// Where the answer of a call goes. By default the answer is a PlanView written to the cached plan. A route that answers
// something else sets `write` to the key its answer belongs to (or null to keep it out of the cache) and lists in
// `refresh` the keys that are read again.
export interface PlanRequestTarget {
  write?: string | null;
  refresh?: string[];
}

// `send(method, path, body)` makes the call; it answers what the server returned (a PlanView unless told otherwise), or
// null when the call failed (the reason is already shown). `pending` is true while a call runs.
export const usePlanRequest = () => {
  const fetch = useFetch();
  const t = useT();
  const { show } = useToaster();
  const { mutate } = useSWRConfig();
  const idempotency = useIdempotencyKey();
  const [running, setRunning] = useState(0);

  // The friendly line for an answer that is not OK.
  const failure = useCallback(
    (status: number, code: string | undefined) => {
      if (status === 429) {
        return t('plan_error_throttled', 'Busy, try again in a minute');
      }
      switch (code) {
        case 'PLAN_BUSY':
          return t('plan_error_busy', 'Already working on it');
        case 'ROUND_STALE':
        case 'PROPOSAL_STALE':
        case 'PLAN_EXISTS':
        case 'PLAN_NOT_ACTIVE':
        case 'WEEK_NOT_FOUND':
        case 'DAY_NOT_FOUND':
        case 'SESSION_CLOSED':
        case 'SESSION_NOT_FOUND':
          return t(
            'plan_error_stale',
            'The plan changed in the meantime. It has been refreshed.'
          );
        case 'WEEK_LOCKED':
          return t(
            'plan_error_week_locked',
            'That week has started or is being written, so it cannot be changed now.'
          );
        case 'DAY_LOCKED':
          return t(
            'plan_error_day_locked',
            'This video is recorded or its day has passed, so it cannot be changed.'
          );
        case 'ADMIN_REQUIRED':
          return t('plan_error_admin', 'Only admins can change the plan');
        case 'INVALID_PLAN':
          return t('plan_error_invalid', 'Some of the text is empty or too long');
        case 'PLAN_NOT_AVAILABLE':
          return t(
            'plan_error_not_available',
            'The content plan is not available right now'
          );
        default:
          return t('plan_error_failed', 'That did not work. Please try again.');
      }
    },
    [t]
  );

  const send = useCallback(
    async <T extends object = PlanView>(
      method: 'POST' | 'PUT',
      path: string,
      body?: unknown,
      target?: PlanRequestTarget
    ): Promise<T | null> => {
      const payload = JSON.stringify(body ?? {});
      setRunning((count) => count + 1);
      try {
        const response = await fetch(path, {
          method,
          headers: {
            'Idempotency-Key': idempotency.key(`${method} ${path} ${payload}`),
          },
          body: payload,
        });
        if (response.status < 500) {
          idempotency.reset();
        }
        if (!response.ok) {
          const code = (await response.json().catch(() => ({})))?.code as
            | string
            | undefined;
          show(failure(response.status, code), 'warning');
          if (code && STALE_CODES.includes(code)) {
            await Promise.all(
              [CONTENT_PLAN_KEY, CURRENT_WEEK_KEY, UPCOMING_KEY].map((key) =>
                mutate(key)
              )
            );
          }
          return null;
        }
        const answer: T = await response.json();
        const write =
          target?.write === undefined ? CONTENT_PLAN_KEY : target.write;
        if (write) {
          await mutate(write, answer, { revalidate: false });
        }
        await Promise.all((target?.refresh ?? []).map((key) => mutate(key)));
        return answer;
      } catch {
        show(failure(0, undefined), 'warning');
        return null;
      } finally {
        setRunning((count) => count - 1);
      }
    },
    [failure, fetch, idempotency, mutate, show]
  );

  return { send, pending: running > 0 };
};
