'use client';

// Content plan: sends one change to a session of the planning engine (start it, answer a round, ask for the proposal,
// revise, confirm, discard). It is `usePlanRequest` (the friendly error lines, the idempotency key) with the answer
// written to the session's own cache key instead of the plan's.
import { useCallback } from 'react';
import { useSWRConfig } from 'swr';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import { planSessionKey } from '@gitroom/frontend/components/content-plan/use.plan.session';
import { openPlanSessionKey } from '@gitroom/frontend/components/content-plan/use.plan.open.session';
import { PlanSessionView } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The calls on a session that has an id.
export type PlanSessionAction =
  | 'answer'
  | 'propose'
  | 'revise'
  | 'confirm'
  | 'discard';

// `start(body)` opens a session; `act(id, action, body)` changes one. Both answer the session's new view, or null when
// the call failed (the reason is already shown, and the session is read again). `pending` is true while a call runs.
export const usePlanSessionRequest = () => {
  const { send, pending } = usePlanRequest();
  const { mutate } = useSWRConfig();

  // Keeps the cache in step with a session the server answered: its own key, and the open session of its kind.
  const keep = useCallback(
    async (view: PlanSessionView) => {
      await mutate(planSessionKey(view.id), view, { revalidate: false });
      await mutate(openPlanSessionKey(view.kind));
    },
    [mutate]
  );

  const start = useCallback(
    async (body: unknown) => {
      const view = await send<PlanSessionView>('POST', '/content-plan/sessions', body, {
        write: null,
      });
      if (view) {
        await keep(view);
      }
      return view;
    },
    [keep, send]
  );

  const act = useCallback(
    async (id: string, action: PlanSessionAction, body?: unknown) => {
      const view = await send<PlanSessionView>(
        'POST',
        `/content-plan/sessions/${id}/${action}`,
        body,
        { write: null }
      );
      if (view) {
        await keep(view);
      } else {
        await mutate(planSessionKey(id));
      }
      return view;
    },
    [keep, mutate, send]
  );

  return { start, act, pending };
};
