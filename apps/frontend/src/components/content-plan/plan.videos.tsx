'use client';

// Content plan: how many videos a week the plan makes. The new number applies from the next week.
import React, { FC, useCallback, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { PlanSection } from '@gitroom/frontend/components/content-plan/plan.parts';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import {
  PlanView,
  VIDEOS_PER_WEEK,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The videos-per-week control: a select with Save, or the plain number for a member who cannot change it.
const PlanVideosForm: FC<{ plan: PlanView }> = ({ plan }) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const [videosPerWeek, setVideosPerWeek] = useState<number>(plan.videosPerWeek);

  const save = useCallback(() => {
    return send('PUT', '/content-plan/videos-per-week', { videosPerWeek });
  }, [send, videosPerWeek]);

  return (
    <PlanSection title={t('plan_videos_per_week', 'Videos per week')}>
      {plan.canEdit ? (
        <div className="flex flex-col sm:flex-row gap-[12px]">
          <select
            value={videosPerWeek}
            disabled={pending || !!plan.busy}
            aria-label={t('plan_videos_per_week', 'Videos per week')}
            onChange={(event) => setVideosPerWeek(Number(event.target.value))}
            className="bg-newBgColorInner h-[56px] border-2 border-newTextColor/15 rounded-[14px] px-[14px] text-[17px] focus:border-btnPrimary outline-none text-textColor w-full sm:w-[120px]"
          >
            {VIDEOS_PER_WEEK.map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
          <Button
            loading={pending}
            disabled={pending || !!plan.busy || videosPerWeek === plan.videosPerWeek}
            onClick={save}
            className="min-h-[44px] w-full sm:w-auto"
          >
            {t('plan_save', 'Save')}
          </Button>
        </div>
      ) : (
        <div>
          {t('plan_videos_a_week', {
            defaultValue: '{{videos}} videos a week',
            videos: plan.videosPerWeek,
          })}
        </div>
      )}
      <div className="text-newTextColor/60 text-[15px]">
        {t('plan_applies_next_week', 'Applies from next week')}
      </div>
    </PlanSection>
  );
};

// The block; it is drawn again from the saved number when that changes.
export const PlanVideos: FC<{ plan: PlanView }> = ({ plan }) => (
  <PlanVideosForm key={plan.videosPerWeek} plan={plan} />
);
