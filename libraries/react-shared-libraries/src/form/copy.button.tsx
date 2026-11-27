'use client';

// Copy controls: the control itself confirms the copy (the icon turns into a check and the label
// into "Copied" for a moment), so no toast is needed. CopyButton is a small button; CopyField is
// a read-only value shown as a code chip that copies on a click anywhere on it.
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import copy from 'copy-to-clipboard';
import { useToaster } from '../toaster/toaster';
import { useT } from '../translation/get.transation.service.client';

const COPIED_FOR_MS = 1500;

// Copies, then reports `copied` for a moment; a failed copy says so instead.
const useCopied = (text: string) => {
  const toaster = useToaster();
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const onCopy = useCallback(() => {
    if (!copy(text)) {
      toaster.show(t('copy_failed', 'Could not copy, select it and copy by hand'), 'warning');
      return;
    }
    if (timer.current) {
      clearTimeout(timer.current);
    }
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
  }, [t, text, toaster]);

  return { copied, onCopy };
};

// The copy icon, or a check that pops in once copied.
const CopyIcon: FC<{ copied: boolean }> = ({ copied }) =>
  copied ? (
    <svg
      key="copied"
      className="animate-copyPop motion-reduce:animate-none shrink-0"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ) : (
    <svg
      key="copy"
      className="shrink-0"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );

// The label, announced to screen readers when it turns into "Copied".
const CopyLabel: FC<{ copied: boolean; label?: string }> = ({
  copied,
  label,
}) => {
  const t = useT();
  return (
    <span aria-live="polite">
      {copied ? t('copied_short', 'Copied') : label || t('copy', 'Copy')}
    </span>
  );
};

export const CopyButton: FC<{
  text: string;
  label?: string;
  primary?: boolean;
  className?: string;
}> = ({ text, label, primary, className }) => {
  const { copied, onCopy } = useCopied(text);
  return (
    <button
      type="button"
      onClick={onCopy}
      className={clsx(
        'cursor-pointer flex items-center justify-center gap-[6px] transition-[background-color,color,transform] duration-200 active:scale-[0.96] motion-reduce:active:scale-100 focus-visible:ring-[3px] focus-visible:ring-btnPrimary/40',
        // primary matches the design-system Button it sits next to; the small one is a pill.
        primary
          ? 'px-[24px] h-[40px]'
          : 'px-[16px] h-[36px] text-[13px] font-[600] rounded-[8px]',
        copied
          ? 'bg-green-500 text-white'
          : primary
          ? 'bg-forth text-white'
          : 'bg-btnSimple hover:bg-boxHover',
        className
      )}
    >
      <CopyIcon copied={copied} />
      <CopyLabel copied={copied} label={label} />
    </button>
  );
};

export const CopyField: FC<{ text: string; className?: string }> = ({
  text,
  className,
}) => {
  const { copied, onCopy } = useCopied(text);
  return (
    <button
      type="button"
      onClick={onCopy}
      className={clsx(
        'group w-full cursor-pointer flex items-stretch rounded-[8px] border border-dashed text-start transition-colors duration-200 focus-visible:ring-[3px] focus-visible:ring-btnPrimary/40',
        copied
          ? 'border-green-500 bg-green-500/10'
          : 'border-newTextColor/30 bg-newBgColorInner hover:border-newTextColor/60',
        className
      )}
    >
      <span
        className="flex-1 min-w-0 px-[12px] py-[10px] font-mono text-[12px] leading-[1.5] break-all select-all"
        dir="ltr"
      >
        {text}
      </span>
      <span
        className={clsx(
          'shrink-0 flex items-center gap-[6px] px-[12px] text-[13px] font-[600] border-s border-dashed transition-[color,transform] duration-200 group-active:scale-[0.96] motion-reduce:group-active:scale-100',
          copied
            ? 'border-green-500 text-green-500'
            : 'border-newTextColor/30 text-newTextColor/80 group-hover:text-newTextColor'
        )}
      >
        <CopyIcon copied={copied} />
        <CopyLabel copied={copied} />
      </span>
    </button>
  );
};
