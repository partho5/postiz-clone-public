'use client';

// Content plan: "Something happened in my industry?". The owner tells what happened; this week then focuses on it and
// the videos it displaces move to next week.
import React, { FC, useCallback, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Textarea } from '@gitroom/react/form/textarea';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { PlanSection } from '@gitroom/frontend/components/content-plan/plan.parts';
import { CURRENT_WEEK_KEY } from '@gitroom/frontend/components/content-plan/use.plan.current.week';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import {
  LIMITS,
  PlanWeekView,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The note about something that happened, for the current week.
export const PlanUrgent: FC<{ week: PlanWeekView }> = ({ week }) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const [note, setNote] = useState('');
  const working =
    pending || week.status === 'GENERATING' || week.days.some((day) => day.busy);

  const tell = useCallback(async () => {
    const answer = await send<PlanWeekView>(
      'POST',
      `/content-plan/weeks/${week.id}/urgent`,
      { note: note.trim() },
      { write: CURRENT_WEEK_KEY }
    );
    if (answer) {
      setNote('');
    }
  }, [note, send, week.id]);

  return (
    <PlanSection title={t('plan_urgent_title', 'Something happened in my industry?')}>
      <Textarea
        label={t('plan_urgent_label', 'What happened?')}
        name="planUrgent"
        disableForm={true}
        disabled={working}
        dir="auto"
        value={note}
        maxLength={LIMITS.urgentNote}
        className="min-h-[100px] w-full"
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex">
        <Button
          loading={pending}
          disabled={working || !note.trim()}
          onClick={tell}
          className="min-h-[44px] w-full sm:w-auto"
        >
          {t('plan_urgent_send', 'Plan around it')}
        </Button>
      </div>
      {!!week.urgentNote && (
        <div className="text-textItemBlur">
          {t(
            'plan_urgent_done',
            'This week now focuses on it. The rest moves to next week.'
          )}
        </div>
      )}
    </PlanSection>
  );
};
