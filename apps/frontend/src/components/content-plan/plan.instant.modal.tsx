'use client';

// Content plan: the "Instant video plan". A button next to Regenerate opens a dialog where the owner types a rough idea and
// gets a finished video (what is on screen and what to say) on a date. It is a session of the planning engine: the idea,
// questions only when the idea is unclear, and the result, which the owner may ask to change before adding it to the plan.
// Closing the dialog keeps the open session, so the owner finds it where it was left.
import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import {
  PLAN_OUTLINE_BUTTON,
  PLAN_PRIMARY_BUTTON,
  PlanFailed,
  PlanThinking,
} from '@gitroom/frontend/components/content-plan/plan.parts';
import {
  PlanInstantIdea,
  PlanInstantOptions,
} from '@gitroom/frontend/components/content-plan/plan.instant.idea';
import { PlanInstantResult } from '@gitroom/frontend/components/content-plan/plan.instant.result';
import { PlanRoundForm } from '@gitroom/frontend/components/content-plan/plan.round.form';
import {
  PlanStep,
  PlanSteps,
} from '@gitroom/frontend/components/content-plan/plan.steps';
import { CURRENT_WEEK_KEY } from '@gitroom/frontend/components/content-plan/use.plan.current.week';
import { useOpenPlanSession } from '@gitroom/frontend/components/content-plan/use.plan.open.session';
import { usePlanSession } from '@gitroom/frontend/components/content-plan/use.plan.session';
import { usePlanSessionRequest } from '@gitroom/frontend/components/content-plan/use.plan.session.request';
import { UPCOMING_KEY } from '@gitroom/frontend/components/content-plan/use.plan.upcoming';
import {
  PlanAnswer,
  PlanSessionRoundView,
  PlanVideoSetOptions,
  PlanVideoSetView,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The kind of session this dialog works on.
const SESSION_KIND = 'video_set';

// The idea step is the first step of every session; the result is the last.
const IDEA_STEP = 'idea';
const VIDEO_STEP = 'video';

// The dialog. `today` is the brand's today (the earliest date a video may be planned for).
const PlanInstantModal: FC<{ today: string; close: () => void }> = ({
  today,
  close,
}) => {
  const t = useT();
  const { show } = useToaster();
  const { mutate } = useSWRConfig();
  const { start, act, pending } = usePlanSessionRequest();
  const open = useOpenPlanSession(SESSION_KIND);
  // The session the owner works on: the open one found on opening, until the owner starts one or starts over (null).
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const sessionId = picked !== undefined ? picked : open.data?.id ?? null;
  const loaded = usePlanSession(sessionId);
  const found = open.data?.id === sessionId ? open.data : undefined;
  const session = loaded.data ?? found;
  const live =
    session &&
    (session.status === 'ASKING' ||
      session.status === 'PROPOSING' ||
      session.status === 'PROPOSED')
      ? session
      : undefined;
  const [autoFailed, setAutoFailed] = useState<string | null>(null);
  const autoStarted = useRef<string | null>(null);
  const lastFeedback = useRef('');

  const options = live?.options as unknown as PlanVideoSetOptions | null | undefined;
  const proposal = live?.proposal as PlanVideoSetView | null | undefined;
  const count = proposal?.videos.length ?? options?.count ?? 1;
  const round = live?.round ?? null;
  const rounds = useMemo(() => {
    const all = live?.rounds ?? [];
    const single = all.length === 1 && live?.status === 'ASKING';
    // a first round with nothing to ask is not a step (the owner never sees it) unless it is all there is to show
    return all.filter(
      (item, index) =>
        !(index === 0 && !item.questions.length && item.readyForPlan && !single)
    );
  }, [live?.rounds, live?.status]);

  // A clear idea: the first round has no questions and is ready, so the result is asked for at once, one time.
  const autoPending =
    !!live &&
    !!round &&
    live.status === 'ASKING' &&
    live.canEdit &&
    !live.notice &&
    live.rounds.length === 1 &&
    !round.questions.length &&
    round.readyForPlan &&
    autoFailed !== live.id;
  const liveId = live?.id;
  const autoSummary = round?.summary;
  useEffect(() => {
    if (!autoPending || !liveId || autoStarted.current === liveId) {
      return;
    }
    autoStarted.current = liveId;
    act(liveId, 'propose', { summary: autoSummary }).then((view) => {
      if (!view) {
        setAutoFailed(liveId);
      }
    });
  }, [act, autoPending, autoSummary, liveId]);

  const begin = useCallback(
    async (sourceText: string, chosen: PlanInstantOptions) => {
      const view = await start({
        kind: SESSION_KIND,
        sourceText,
        ...(Object.keys(chosen).length ? { options: chosen } : {}),
      });
      if (view) {
        setPicked(view.id);
      }
    },
    [start]
  );

  const startOver = useCallback(async () => {
    if (liveId && (await act(liveId, 'discard'))) {
      setPicked(null);
    }
  }, [act, liveId]);

  if (!live && picked === undefined && open.data === undefined && !open.error) {
    return <PlanThinking />;
  }
  if (!live) {
    return <PlanInstantIdea today={today} starting={pending} onStart={begin} />;
  }
  if (autoPending) {
    return <PlanThinking kind="video" />;
  }

  const busy = pending || !!live.busy || live.status === 'PROPOSING';
  const hasResultStep = live.status === 'PROPOSING' || live.status === 'PROPOSED';
  const resultLabel =
    count === 1
      ? t('plan_instant_step_video_one', 'Your video')
      : t('plan_instant_step_video_other', 'Your videos');
  const steps: PlanStep[] = [
    { key: IDEA_STEP, label: t('plan_instant_step_idea', 'Your idea') },
    ...rounds.map((item, index) => ({
      key: item.id,
      label: t('plan_instant_step_questions', {
        defaultValue: 'Questions {{number}}',
        number: index + 1,
      }),
    })),
    ...(hasResultStep ? [{ key: VIDEO_STEP, label: resultLabel }] : []),
  ];

  const propose = async (summary: string, answers?: PlanAnswer[]) => {
    await act(live.id, 'propose', { summary, ...(answers ? { answers } : {}) });
  };
  const revise = (feedback: string) => {
    lastFeedback.current = feedback;
    return act(live.id, 'revise', {
      proposalVersion: live.proposalVersion,
      feedback,
    });
  };
  const confirm = async (dates: { ref: string; date: string }[]) => {
    const view = await act(live.id, 'confirm', {
      proposalVersion: live.proposalVersion,
      edits: { dates },
    });
    if (view) {
      show(
        t('plan_instant_added', "Added to your plan. It's next on your phone."),
        'success'
      );
      close();
      await Promise.all([mutate(CURRENT_WEEK_KEY), mutate(UPCOMING_KEY)]);
    }
  };

  const renderRound = (
    item: PlanSessionRoundView,
    nav: { back?: () => void; next?: () => void }
  ) => {
    const isLatest = item.id === round?.id;
    const failed =
      isLatest &&
      live.status === 'ASKING' &&
      (live.notice === 'proposal_failed' || autoFailed === live.id);
    return (
      <PlanRoundForm
        round={item}
        summary={item.summary}
        summaryName="planInstantSummary"
        summaryMax={6000}
        resultLabel={
          (options?.count ?? 1) === 1
            ? t('plan_instant_show_one', 'Show my video')
            : t('plan_instant_show_other', 'Show my videos')
        }
        isLatest={isLatest}
        canEdit={live.canEdit}
        busy={busy}
        nav={nav}
        onContinue={async (summary, answers) => {
          await act(live.id, 'answer', { roundId: item.id, summary, answers });
        }}
        onResult={propose}
        failure={
          failed ? (
            <PlanFailed
              text={t('plan_instant_failed', 'The video could not be written.')}
              loading={busy}
              onRetry={
                live.canEdit ? () => propose(item.summary) : undefined
              }
            />
          ) : undefined
        }
        thinking={<PlanThinking kind="video" />}
      />
    );
  };

  return (
    <div className="flex flex-col gap-[16px] whitespace-normal">
      <PlanSteps
        steps={steps}
        upcoming={hasResultStep ? null : resultLabel}
        disabled={busy}
        renderStep={(step, nav) => {
          if (step.key === IDEA_STEP) {
            return (
              <div className="flex flex-col gap-[16px]">
                <div
                  dir="auto"
                  className="whitespace-pre-line break-words rounded-[8px] border border-newTextColor/25 bg-newFieldBg p-[16px] max-h-[40vh] overflow-y-auto"
                >
                  {live.sourceText}
                </div>
                {nav.next && (
                  <div className="flex">
                    <Button onClick={nav.next} className={PLAN_PRIMARY_BUTTON}>
                      {t('plan_continue', 'Continue')}
                    </Button>
                  </div>
                )}
              </div>
            );
          }
          if (step.key === VIDEO_STEP) {
            // a revision keeps the last proposal on screen, dimmed and locked (busy), under the waiting line
            const revising = live.status === 'PROPOSING' && !!proposal;
            return (live.status === 'PROPOSED' || revising) && proposal ? (
              <div className="flex flex-col gap-[16px]">
                {revising && <PlanThinking kind="video" />}
                <div
                  aria-busy={revising}
                  className={revising ? 'opacity-50' : undefined}
                >
                  <PlanInstantResult
                    key={live.proposalVersion}
                    videos={proposal.videos}
                    today={today}
                    canEdit={live.canEdit}
                    busy={busy}
                    failed={live.notice === 'proposal_failed'}
                    onRetry={
                      lastFeedback.current
                        ? () => revise(lastFeedback.current)
                        : undefined
                    }
                    onRevise={revise}
                    onConfirm={confirm}
                  />
                </div>
              </div>
            ) : (
              <PlanThinking kind="video" />
            );
          }
          const item = rounds.find((candidate) => candidate.id === step.key);
          return item ? renderRound(item, nav) : null;
        }}
      />
      {live.canEdit && (
        <div className="flex">
          <button
            type="button"
            disabled={busy}
            onClick={startOver}
            className="min-h-[44px] rounded-[8px] px-[4px] underline text-[14px] text-newTextColor/70 hover:text-newTextColor outline-none focus-visible:ring-[3px] focus-visible:ring-btnPrimary/40 disabled:opacity-50"
          >
            {t('plan_instant_start_over', 'Start over')}
          </button>
        </div>
      )}
    </div>
  );
};

// The button of the week's brief that opens the dialog; the page shows it only to an admin. Closing the dialog keeps the
// open session, which the dialog picks up again.
export const PlanInstantButton: FC<{ today: string }> = ({ today }) => {
  const t = useT();
  const modals = useModals();
  const openDialog = useCallback(() => {
    modals.openModal({
      id: 'plan-instant-video',
      title: t('plan_instant_title', 'Instant video plan'),
      withCloseButton: true,
      maxSize: 760,
      children: (close) => <PlanInstantModal today={today} close={close} />,
    });
  }, [modals, t, today]);

  return (
    <Button onClick={openDialog} className={PLAN_OUTLINE_BUTTON}>
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="me-[8px] h-[18px] w-[18px]"
        fill="currentColor"
      >
        <path d="M13.5 2 4.5 13.5h6L9.5 22l9-11.5h-6z" />
      </svg>
      {t('plan_instant_open', 'Instant video plan')}
    </Button>
  );
};
