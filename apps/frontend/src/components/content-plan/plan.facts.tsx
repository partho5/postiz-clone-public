'use client';

// Content plan: the facts about the business ("About your business") that every video is written from, editable.
import React, { FC, useCallback, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { Textarea } from '@gitroom/react/form/textarea';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  PLAN_PRIMARY_BUTTON,
  PLAN_SELECT,
  PlanSection,
} from '@gitroom/frontend/components/content-plan/plan.parts';
import { usePlanRequest } from '@gitroom/frontend/components/content-plan/use.plan.request';
import {
  PlanFacts,
  PlanView,
  VIDEO_SECONDS,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// One line per entry, as the lists of the facts are edited.
const toLines = (items: string[]) => items.join('\n');
const fromLines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

// What the owner edits: the lists are text with one entry per line.
interface FactsDraft {
  whatWeDo: string;
  audience: string;
  problems: string;
  solution: string;
  objections: string;
  tone: string;
  videoSeconds: PlanFacts['videoSeconds'];
}

const draftOf = (facts: PlanFacts): FactsDraft => ({
  ...facts,
  problems: toLines(facts.problems),
  objections: toLines(facts.objections),
});

const factsOf = (draft: FactsDraft): PlanFacts => ({
  whatWeDo: draft.whatWeDo.trim(),
  audience: draft.audience.trim(),
  problems: fromLines(draft.problems),
  solution: draft.solution.trim(),
  objections: fromLines(draft.objections),
  tone: draft.tone.trim(),
  videoSeconds: draft.videoSeconds,
});

// The form of the facts with Save. It starts again when the saved facts change.
const PlanFactsForm: FC<{ plan: PlanView; facts: PlanFacts }> = ({
  plan,
  facts,
}) => {
  const t = useT();
  const { send, pending } = usePlanRequest();
  const [draft, setDraft] = useState<FactsDraft>(() => draftOf(facts));
  const disabled = pending || !!plan.busy || !plan.canEdit;
  const changed = JSON.stringify(factsOf(draft)) !== JSON.stringify(factsOf(draftOf(facts)));

  const set = <K extends keyof FactsDraft>(key: K, value: FactsDraft[K]) =>
    setDraft((held) => ({ ...held, [key]: value }));

  const save = useCallback(() => {
    return send('PUT', '/content-plan/facts', { facts: factsOf(draft) });
  }, [draft, send]);

  return (
    <PlanSection title={t('plan_about_business', 'About your business')}>
      <Input
        label={t('plan_fact_what', 'What you do')}
        name="planFactWhat"
        disableForm={true}
        removeError={true}
        disabled={disabled}
        dir="auto"
        value={draft.whatWeDo}
        maxLength={2000}
        onChange={(event) => set('whatWeDo', event.target.value)}
      />
      <Input
        label={t('plan_fact_audience', 'Who it is for')}
        name="planFactAudience"
        disableForm={true}
        removeError={true}
        disabled={disabled}
        dir="auto"
        value={draft.audience}
        maxLength={2000}
        onChange={(event) => set('audience', event.target.value)}
      />
      <Textarea
        label={t('plan_fact_problems', 'Problems you solve')}
        name="planFactProblems"
        disableForm={true}
        disabled={disabled}
        dir="auto"
        value={draft.problems}
        className="min-h-[100px] w-full"
        onChange={(event) => set('problems', event.target.value)}
      />
      <Input
        label={t('plan_fact_solution', 'How you solve them')}
        name="planFactSolution"
        disableForm={true}
        removeError={true}
        disabled={disabled}
        dir="auto"
        value={draft.solution}
        maxLength={2000}
        onChange={(event) => set('solution', event.target.value)}
      />
      <Textarea
        label={t('plan_fact_objections', 'What people worry about')}
        name="planFactObjections"
        disableForm={true}
        disabled={disabled}
        dir="auto"
        value={draft.objections}
        className="min-h-[100px] w-full"
        onChange={(event) => set('objections', event.target.value)}
      />
      <div className="text-newTextColor/60 text-[15px]">
        {t('plan_fact_one_per_line', 'One entry per line')}
      </div>
      <Input
        label={t('plan_fact_tone', 'Tone')}
        name="planFactTone"
        disableForm={true}
        removeError={true}
        disabled={disabled}
        dir="auto"
        value={draft.tone}
        maxLength={500}
        onChange={(event) => set('tone', event.target.value)}
      />
      <div className="flex flex-col gap-[6px]">
        <div className="text-[14px]">{t('plan_fact_length', 'Video length')}</div>
        <select
          value={draft.videoSeconds}
          disabled={disabled}
          aria-label={t('plan_fact_length', 'Video length')}
          onChange={(event) =>
            set(
              'videoSeconds',
              Number(event.target.value) as PlanFacts['videoSeconds']
            )
          }
          className={PLAN_SELECT}
        >
          {VIDEO_SECONDS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {t('plan_seconds', {
                defaultValue: '{{seconds}} seconds',
                seconds,
              })}
            </option>
          ))}
        </select>
        <div className="text-newTextColor/60 text-[15px]">
          {t(
            'plan_fact_length_help',
            'A new length applies from the next week that is written.'
          )}
        </div>
      </div>
      {plan.canEdit && (
        <div className="flex">
          <Button
            loading={pending}
            disabled={disabled || !changed}
            onClick={save}
            className={PLAN_PRIMARY_BUTTON}
          >
            {t('plan_save', 'Save')}
          </Button>
        </div>
      )}
    </PlanSection>
  );
};

// The "About your business" block; nothing while the plan holds no facts.
export const PlanFactsEditor: FC<{ plan: PlanView }> = ({ plan }) =>
  plan.facts ? (
    <PlanFactsForm
      key={JSON.stringify(plan.facts)}
      plan={plan}
      facts={plan.facts}
    />
  ) : null;
