'use client';

// Content plan: the Content Direction of the running plan. Saving it writes the ideas of the coming weeks again.
import React, { FC, useCallback, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Textarea } from '@gitroom/react/form/textarea';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  PlanFailed,
  PlanSection,
} from '@gitroom/frontend/components/content-plan/plan.parts';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import {
  LIMITS,
  PlanView,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The direction as an editable text with Save. It starts again when the saved direction changes.
const PlanDirectionForm: FC<{ plan: PlanView }> = ({ plan }) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const saved = plan.direction ?? '';
  const [direction, setDirection] = useState(saved);
  const replanning = plan.busy === 'replan';
  const working = pending || !!plan.busy;

  const save = useCallback(() => {
    return send('PUT', '/content-plan/direction', {
      direction: direction.trim(),
    });
  }, [direction, send]);

  return (
    <PlanSection title={t('plan_direction_title', 'Content direction')}>
      <Textarea
        label={t('plan_direction_label', 'What every video follows')}
        name="planContentDirection"
        disableForm={true}
        disabled={working || !plan.canEdit}
        dir="auto"
        value={direction}
        maxLength={LIMITS.direction}
        className="min-h-[180px] w-full"
        onChange={(event) => setDirection(event.target.value)}
      />
      {plan.canEdit && (
        <div className="flex">
          <Button
            loading={pending}
            disabled={working || !direction.trim() || direction.trim() === saved.trim()}
            onClick={save}
            className="min-h-[44px] w-full sm:w-auto"
          >
            {t('plan_save', 'Save')}
          </Button>
        </div>
      )}
      {replanning && (
        <div className="text-textItemBlur" role="status">
          {t('plan_replanning', 'Updating your coming weeks…')}
        </div>
      )}
      {!plan.busy && plan.notice === 'roadmap_updated' && (
        <div className="text-textItemBlur" role="status">
          {t(
            'plan_roadmap_updated',
            'Upcoming weeks updated to your new direction'
          )}
        </div>
      )}
      {!plan.busy && plan.notice === 'replan_failed' && (
        <PlanFailed
          text={t(
            'plan_replan_failed',
            'The coming weeks could not be updated.'
          )}
          loading={pending}
          onRetry={plan.canEdit && direction.trim() ? save : undefined}
        />
      )}
    </PlanSection>
  );
};

// The Content Direction block; it is drawn again from the saved text when that changes.
export const PlanDirection: FC<{ plan: PlanView }> = ({ plan }) => (
  <PlanDirectionForm key={plan.direction ?? ''} plan={plan} />
);
