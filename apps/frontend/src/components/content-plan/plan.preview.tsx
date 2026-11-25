'use client';

// Content plan: the proposal. The owner reads the direction, the facts, the themes and the first weeks, then confirms
// the whole plan or says what is not right (which writes a new proposal).
import React, { FC, useCallback, useState } from 'react';
import clsx from 'clsx';
import { Button } from '@gitroom/react/form/button';
import { Textarea } from '@gitroom/react/form/textarea';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { PlanAngleChip } from '@gitroom/frontend/components/content-plan/plan.angle.chip';
import {
  PLAN_OUTLINE_BUTTON,
  PLAN_PRIMARY_BUTTON,
  PLAN_TEXTAREA,
  PlanBackButton,
  PlanFailed,
  PlanSection,
  PlanThinking,
  planWeekRange,
} from '@gitroom/frontend/components/content-plan/plan.parts';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import {
  LIMITS,
  PREVIEW_WEEKS,
  PlanFacts,
  PlanProposal,
  PlanView,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// One fact of the "About your business" block; nothing when it is empty.
const Fact: FC<{ label: string; value: string | string[] }> = ({
  label,
  value,
}) => {
  const text = Array.isArray(value) ? value.join('\n') : value;
  if (!text.trim()) {
    return null;
  }
  return (
    <div className="flex flex-col">
      <div className="text-newTextColor/60 text-[15px]">{label}</div>
      <div dir="auto" className="whitespace-pre-line break-words">
        {text}
      </div>
    </div>
  );
};

// What the AI filled in about the business, as plain text.
const PlanFactsText: FC<{ facts: PlanFacts }> = ({ facts }) => {
  const t = useT();
  return (
    <div className="flex flex-col gap-[10px]">
      <Fact label={t('plan_fact_what', 'What you do')} value={facts.whatWeDo} />
      <Fact label={t('plan_fact_audience', 'Who it is for')} value={facts.audience} />
      <Fact label={t('plan_fact_problems', 'Problems you solve')} value={facts.problems} />
      <Fact label={t('plan_fact_solution', 'How you solve them')} value={facts.solution} />
      <Fact label={t('plan_fact_objections', 'What people worry about')} value={facts.objections} />
      <Fact label={t('plan_fact_tone', 'Tone')} value={facts.tone} />
      <Fact
        label={t('plan_fact_length', 'Video length')}
        value={t('plan_seconds', {
          defaultValue: '{{seconds}} seconds',
          seconds: facts.videoSeconds,
        })}
      />
    </div>
  );
};

// One of the first weeks in full: its dates, its idea and one title with an angle chip per video.
const PlanWeekCard: FC<{ week: PlanProposal['weeks'][number] }> = ({ week }) => (
  <div className="flex flex-col gap-[8px] bg-newBgColorInner rounded-[12px] p-[16px] border border-newTextColor/20 min-w-0">
    <div className="text-newTextColor/60 text-[15px]">{planWeekRange(week.weekStart)}</div>
    <div dir="auto" className="font-[600] break-words">
      {week.idea}
    </div>
    {!!week.outline?.length && (
      <ul className="flex flex-col gap-[6px]">
        {week.outline.map((video, index) => (
          <li key={index} className="flex items-center gap-[8px] flex-wrap">
            <span dir="auto" className="break-words">
              {video.title}
            </span>
            <PlanAngleChip angle={video.angle} />
          </li>
        ))}
      </ul>
    )}
  </div>
);

// The proposal page. A plan that is being written again shows "Thinking…" in place of the proposal.
export const PlanPreview: FC<{ plan: PlanView; onBack?: () => void }> = ({
  plan,
  onBack,
}) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const [asking, setAsking] = useState(false);
  const [feedback, setFeedback] = useState('');
  const { proposal } = plan;
  const working = pending || !!plan.busy;
  const canEdit = plan.canEdit;

  const confirm = useCallback(() => {
    if (!proposal) {
      return;
    }
    return send('POST', '/content-plan/confirm', {
      proposalVersion: proposal.version,
    });
  }, [proposal, send]);

  const revise = useCallback(async () => {
    if (!proposal) {
      return;
    }
    const answer = await send('POST', '/content-plan/proposal/revise', {
      proposalVersion: proposal.version,
      feedback: feedback.trim(),
    });
    if (answer) {
      setAsking(false);
    }
  }, [feedback, proposal, send]);

  if (!proposal) {
    return working ? <PlanThinking kind="proposal" /> : null;
  }

  const failed = plan.notice === 'proposal_failed';
  const previewWeeks = proposal.weeks.slice(0, PREVIEW_WEEKS);
  const laterWeeks = proposal.weeks.slice(PREVIEW_WEEKS);

  return (
    <div className="flex flex-col gap-[16px]">
      <PlanSection title={t('plan_understood', "Here's what I understood")}>
        <div dir="auto" className="whitespace-pre-line break-words">
          {plan.direction}
        </div>
        <div className="text-newTextColor/70">
          {t('plan_videos_a_week', {
            defaultValue: '{{videos}} videos a week',
            videos: plan.videosPerWeek,
          })}
        </div>
      </PlanSection>

      <PlanSection title={t('plan_about_business', 'About your business')}>
        <PlanFactsText facts={proposal.facts} />
      </PlanSection>

      <PlanSection title={t('plan_themes', 'Themes')}>
        <div className="flex flex-wrap gap-[8px]">
          {proposal.themes.map((theme) => (
            <span
              key={theme.ref}
              dir="auto"
              title={theme.description}
              className="inline-flex items-center rounded-full border border-newTextColor/20 px-[12px] py-[4px] break-words"
            >
              {theme.name}
            </span>
          ))}
        </div>
      </PlanSection>

      <div className="flex flex-col gap-[12px]">
        {previewWeeks.map((week) => (
          <PlanWeekCard key={week.weekStart} week={week} />
        ))}
      </div>

      {!!laterWeeks.length && (
        <details className="bg-newBgColorInner rounded-[12px] p-[16px] border border-newTextColor/20 min-w-0">
          <summary className="cursor-pointer font-[600]">
            {t('plan_later_weeks', {
              defaultValue: 'Weeks {{from}}-{{to}}',
              from: PREVIEW_WEEKS + 1,
              to: proposal.weeks.length,
            })}
          </summary>
          <ul className="flex flex-col gap-[10px] mt-[10px]">
            {laterWeeks.map((week) => (
              <li key={week.weekStart} className="flex flex-col">
                <span className="text-newTextColor/60 text-[15px]">
                  {planWeekRange(week.weekStart)}
                </span>
                <span dir="auto" className="break-words">
                  {week.idea}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {working && <PlanThinking kind="proposal" />}
      {failed && !working && (
        <PlanFailed
          text={t(
            'plan_proposal_failed',
            'The plan could not be written. Please try again.'
          )}
          loading={pending}
          onRetry={
            canEdit
              ? feedback.trim()
                ? revise
                : () => setAsking(true)
              : undefined
          }
        />
      )}

      {canEdit && (
        <div className="flex flex-col gap-[12px]">
          {asking && (
            <>
              <Textarea
                label={t('plan_whats_wrong', "What's not right?")}
                name="planFeedback"
                disableForm={true}
                disabled={working}
                dir="auto"
                value={feedback}
                maxLength={LIMITS.feedback}
                className={clsx(PLAN_TEXTAREA, 'min-h-[120px]')}
                onChange={(event) => setFeedback(event.target.value)}
              />
              <div className="flex">
                <Button
                  disabled={working || !feedback.trim()}
                  onClick={revise}
                  className={PLAN_PRIMARY_BUTTON}
                >
                  {t('plan_revise', 'Write it again')}
                </Button>
              </div>
            </>
          )}
          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-[12px]">
            {onBack ? (
              <PlanBackButton onClick={onBack} disabled={working} />
            ) : (
              <span />
            )}
            <div className="flex flex-col sm:flex-row gap-[12px]">
              {!asking && (
                <Button
                  disabled={working}
                  onClick={() => setAsking(true)}
                  className={PLAN_OUTLINE_BUTTON}
                >
                  {t('plan_not_right', "Something's not right")}
                </Button>
              )}
              <Button
                disabled={working}
                onClick={confirm}
                className={PLAN_PRIMARY_BUTTON}
              >
                {t('plan_confirm', 'Confirm plan')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
