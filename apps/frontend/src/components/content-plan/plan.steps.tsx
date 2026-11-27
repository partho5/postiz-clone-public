'use client';

// Content plan: a flow of steps any planning session shares. A bar shows where the owner is, every reached step can be
// gone back to, and moving between steps slides. All steps stay mounted (the others hidden), so what was typed in a
// step is still there when the owner comes back to it.
import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

// How long (ms) the step that goes out stays on the page, a little more than the slide.
const SLIDE_MS = 450;

export type PlanStep = { key: string; label: string };

// Where a step can go: back to the step before it, and on to the step after it when there is one already.
export interface PlanStepNav {
  back?: () => void;
  next?: () => void;
}

// The bar of steps: a reached step is a button that goes back to it; the plan step not reached yet is shown dimmed.
export const PlanStepBar: FC<{
  steps: PlanStep[];
  current: string;
  upcoming: string | null;
  disabled: boolean;
  onGo: (key: string) => void;
}> = ({ steps, current, upcoming, disabled, onGo }) => {
  const entries = [...steps, ...(upcoming ? [{ key: '', label: upcoming }] : [])];
  const currentIndex = steps.findIndex((step) => step.key === current);
  return (
    <ol className="flex items-center flex-wrap gap-y-[8px]">
      {entries.map((step, index) => {
        const reached = index < steps.length;
        const active = index === currentIndex;
        const done = reached && index < currentIndex;
        return (
          <li key={step.key || 'upcoming'} className="flex items-center">
            <button
              type="button"
              disabled={!reached || active || disabled}
              aria-current={active ? 'step' : undefined}
              onClick={() => onGo(step.key)}
              className={clsx(
                'flex items-center gap-[10px] rounded-full border px-[16px] min-h-[44px] text-[16px] transition-colors',
                active
                  ? 'border-btnPrimary bg-btnPrimary/15 font-[600]'
                  : reached
                  ? 'border-newTextColor/30 cursor-pointer hover:border-btnPrimary/60'
                  : 'border-newTextColor/15 text-newTextColor/50'
              )}
            >
              <span
                aria-hidden="true"
                className={clsx(
                  'flex items-center justify-center h-[24px] w-[24px] rounded-full ',
                  active || done
                    ? 'bg-btnPrimary text-white'
                    : 'border border-newTextColor/40'
                )}
              >
                {done ? (
                  <svg viewBox="0 0 16 16" className="h-[12px] w-[12px]" fill="none">
                    <path
                      d="M3.5 8.5l3 3 6-7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </span>
              <span className={clsx(!active && 'hidden sm:inline')}>
                {step.label}
              </span>
            </button>
            {index < entries.length - 1 && (
              <span
                aria-hidden="true"
                className="mx-[6px] h-[2px] w-[16px] bg-newTextColor/20"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
};

// The bar and the sliding steps. The last step is the "front": when it moves (a new round, the result is written) the
// page slides to it by itself; otherwise the owner moves with the bar or the `nav` each step is given. `upcoming` is
// the label of a step not reached yet, shown dimmed; `renderStep` draws the body of one step.
export const PlanSteps: FC<{
  steps: PlanStep[];
  upcoming: string | null;
  disabled: boolean;
  renderStep: (step: PlanStep, nav: PlanStepNav) => React.ReactNode;
}> = ({ steps, upcoming, disabled, renderStep }) => {
  const front = steps[steps.length - 1].key;
  const [current, setCurrent] = useState(front);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [moved, setMoved] = useState(false);
  const [seenFront, setSeenFront] = useState(front);
  const root = useRef<HTMLDivElement | null>(null);

  const go = useCallback(
    (key: string) => {
      const to = steps.findIndex((step) => step.key === key);
      const from = steps.findIndex((step) => step.key === current);
      if (to < 0 || key === current) {
        return;
      }
      setDirection(to > from ? 'next' : 'prev');
      setLeaving(from >= 0 ? current : null);
      setCurrent(key);
      setMoved(true);
    },
    [current, steps]
  );

  // The front moved (or the step the owner was on is gone): slide to the front.
  if (front !== seenFront || !steps.some((step) => step.key === current)) {
    setSeenFront(front);
    go(front);
  }

  // A new step starts at the top of the flow.
  useEffect(() => {
    if (moved) {
      root.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [current, moved]);

  // The step that went out leaves the page once it has slid away.
  useEffect(() => {
    if (!leaving) {
      return;
    }
    const timer = setTimeout(() => setLeaving(null), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const labelOf = steps.find((step) => step.key === current)?.label;
  return (
    <div className="flex flex-col gap-[28px]" ref={root}>
      <PlanStepBar
        steps={steps}
        current={current}
        upcoming={upcoming}
        disabled={disabled}
        onGo={go}
      />
      <div className="sr-only" role="status">
        {labelOf}
      </div>
      <div className="relative overflow-x-clip">
        {steps.map((step, index) => {
          const isCurrent = step.key === current;
          const isLeaving = step.key === leaving;
          const nav = {
            back: index > 0 ? () => go(steps[index - 1].key) : undefined,
            next:
              index < steps.length - 1 ? () => go(steps[index + 1].key) : undefined,
          };
          return (
            <div
              key={step.key}
              hidden={!isCurrent && !isLeaving}
              className={clsx(
                moved && isCurrent && `plan-step plan-in-${direction}`,
                isLeaving &&
                  `plan-step plan-out-${direction} absolute inset-x-0 top-0 pointer-events-none`
              )}
            >
              <h2 className="text-[24px] sm:text-[28px] font-[700] mb-[20px]">{step.label}</h2>
              {renderStep(step, nav)}
            </div>
          );
        })}
      </div>
    </div>
  );
};
