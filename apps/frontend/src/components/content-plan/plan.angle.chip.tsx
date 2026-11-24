'use client';

// Content plan: the small chip that names the angle of a video (how the topic is told).
import React, { FC } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { Angle } from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The angle in words; an angle this page does not know shows nothing.
export const PlanAngleChip: FC<{ angle: Angle | string | null }> = ({ angle }) => {
  const t = useT();
  const labels: Record<Angle, string> = {
    problem: t('plan_angle_problem', 'Problem'),
    mistake: t('plan_angle_mistake', 'Mistake'),
    story: t('plan_angle_story', 'Story'),
    question: t('plan_angle_question', 'Question'),
    comparison: t('plan_angle_comparison', 'Comparison'),
    steps: t('plan_angle_steps', 'Steps'),
    fear_loss: t('plan_angle_fear_loss', 'What you could lose'),
    behind_the_scenes: t('plan_angle_behind_the_scenes', 'Behind the scenes'),
    customer_voice: t('plan_angle_customer_voice', 'Customer voice'),
    trend: t('plan_angle_trend', 'Trend'),
  };
  const label = angle ? labels[angle as Angle] : undefined;
  if (!label) {
    return null;
  }
  return (
    <span className="inline-flex items-center rounded-full border border-newTableBorder px-[10px] py-[2px] text-[12px] text-textItemBlur whitespace-nowrap">
      {label}
    </span>
  );
};
