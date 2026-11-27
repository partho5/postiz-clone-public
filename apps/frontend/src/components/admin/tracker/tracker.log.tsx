// Activity tracker (api.activity-tracker): the activity log of the Activity tab and the device page. Days newest first;
// inside a day one line per action, oldest to newest, in the phone's own clock ("8:12:03 AM | clicked record").
'use client';

import React, { FC, ReactNode, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { WorkspaceLink } from '@gitroom/frontend/components/layout/workspace.navigation';
import {
  TrackerActivityRow,
  TrackerFeedDevice,
  useTrackerActivity,
  useTrackerFeed,
} from '@gitroom/frontend/components/admin/tracker/tracker.hooks';

dayjs.extend(utc);

type Translate = ReturnType<typeof useT>;

// The steps hidden until "Show screens" is ticked: screen changes are noise between the actions.
const SCREEN_NAMES = ['screen'];

// The spans that get no "ended" line: a screen ends when the next one starts, and the app coming back is its own step.
const NO_END_LINE_NAMES = ['screen', 'app_background'];

// The shortest span that gets an "ended" line; a quicker one is shown on its start line only.
const MIN_END_LINE_MS = 1000;

// One line of the log: the start of an activity, or the end of a span. `at` is the UTC time in ms.
interface LogLine {
  key: string;
  at: number;
  row: TrackerActivityRow;
  end: boolean;
}

// One day of the log, with its lines oldest to newest.
interface LogDay {
  label: string;
  lines: LogLine[];
}

// The phone's local time of a UTC time in ms, from the phone's offset in minutes.
const phoneTime = (at: number, tzMinutes: number) => dayjs.utc(at).utcOffset(tzMinutes);

// Formats a span in ms as "0.3 s" under a minute, and as "1 m 12 s" from a minute up.
const formatSpan = (ms: number) => {
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
};

// A step name as words: "onboarding_page" reads "onboarding page".
const words = (name: string) => name.replace(/_/g, ' ');

// The sentence of a start line, and the meta keys it already says (left out of the details after it).
const startSentence = (
  row: TrackerActivityRow,
  t: Translate
): { text: string; used: string[] } => {
  const what = row.description ?? '';
  if (row.kind === 'error') {
    return {
      text: t('activity_line_error', 'error: {{what}}', {
        what: row.errorType ?? words(row.name),
      }),
      used: [],
    };
  }
  switch (row.name) {
    case 'click':
      return { text: t('activity_line_click', 'clicked {{what}}', { what }), used: [] };
    case 'toggle':
      return typeof row.meta?.on === 'boolean'
        ? {
            text: row.meta.on
              ? t('activity_line_toggle_on', '{{what}} on', { what })
              : t('activity_line_toggle_off', '{{what}} off', { what }),
            used: ['on'],
          }
        : { text: t('activity_line_toggle', 'toggled {{what}}', { what }), used: [] };
    case 'app_open':
      return {
        text: what
          ? t('activity_line_app_open_how', 'app opened ({{what}})', { what })
          : t('activity_line_app_open', 'app opened'),
        used: [],
      };
    case 'app_exit':
      return {
        text: what
          ? t('activity_line_app_exit_how', 'app closed ({{what}})', { what })
          : t('activity_line_app_exit', 'app closed'),
        used: [],
      };
    case 'app_foreground':
      return { text: t('activity_line_app_foreground', 'app came back'), used: [] };
    case 'app_background':
      return { text: t('activity_line_app_background', 'app minimized'), used: [] };
    case 'record':
      return { text: t('activity_line_record_start', 'recording started'), used: [] };
    case 'screen':
      return { text: t('activity_line_screen', 'screen: {{what}}', { what }), used: [] };
    default:
      return {
        text: what ? `${words(row.name)} — ${what}` : words(row.name),
        used: [],
      };
  }
};

// The sentence of a span's end line, with how long the span lasted.
const endSentence = (row: TrackerActivityRow, t: Translate) => {
  const span = formatSpan(row.durationMs ?? 0);
  return row.name === 'record'
    ? t('activity_line_record_stop', 'recording stopped ({{span}})', { span })
    : t('activity_line_span_end', '{{what}} ended ({{span}})', {
        what: row.description ?? words(row.name),
        span,
      });
};

// The lines of the loaded rows, newest first: each row's start, and the end of a span that lasted long enough.
// A screen is left out unless `showScreens` is on or it is the `at` activity the log was opened at.
const linesOf = (rows: TrackerActivityRow[], showScreens: boolean, at?: string) =>
  rows
    .filter((row) => showScreens || row.id === at || !SCREEN_NAMES.includes(row.name))
    .flatMap((row): LogLine[] => {
      const start = { key: row.id, at: Date.parse(row.startedAt), row, end: false };
      const hasEnd =
        row.kind !== 'error' &&
        row.endedAt !== null &&
        (row.durationMs ?? 0) >= MIN_END_LINE_MS &&
        !NO_END_LINE_NAMES.includes(row.name);
      return hasEnd
        ? [{ key: `${row.id}:end`, at: Date.parse(row.endedAt as string), row, end: true }, start]
        : [start];
    })
    .sort((a, b) => b.at - a.at);

// Groups lines (newest first) into days of the phone's calendar, newest day first, each day's lines oldest to newest.
// Devices in different zones interleave, so the days are gathered by label, one section per day.
const daysOf = (lines: LogLine[]): LogDay[] => {
  const days = new Map<string, LogLine[]>();
  for (const line of lines) {
    const label = phoneTime(line.at, line.row.tz).format('DD/MM/YYYY');
    days.set(label, [...(days.get(label) ?? []), line]);
  }
  return [...days].map(([label, dayLines]) => ({
    label,
    lines: dayLines.reverse(),
  }));
};

// A small label above a value in the error detail.
const Labelled: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex flex-col gap-[2px] min-w-0">
    <div className="text-[12px] opacity-60">{label}</div>
    <div className="break-words min-w-0">{children}</div>
  </div>
);

// The error's detail, opened from its line: the message, thread and last activity from the row, and the stack and causes loaded in full.
const ErrorDetail: FC<{ row: TrackerActivityRow }> = ({ row }) => {
  const t = useT();
  const { data, isLoading, error } = useTrackerActivity(row.id);
  return (
    <div className="flex flex-col gap-[10px] min-w-0">
      {row.errorMessage ? (
        <Labelled label={t('activity_error_message', 'Message')}>
          <pre className="whitespace-pre-wrap text-[12px] overflow-auto max-h-[40vh]">
            {row.errorMessage}
          </pre>
        </Labelled>
      ) : null}
      {isLoading ? <LoadingComponent /> : null}
      {error ? (
        <div className="text-red-400">
          {t('activity_error_detail_failed', "Could not load this error's stack.")}
        </div>
      ) : null}
      {data?.errorStack ? (
        <Labelled label={t('activity_error_stack', 'Stack')}>
          <pre className="whitespace-pre-wrap text-[12px] overflow-auto max-h-[40vh]">
            {data.errorStack}
          </pre>
        </Labelled>
      ) : null}
      {data?.errorCauses?.length ? (
        <Labelled label={t('activity_error_causes', 'Causes')}>
          {data.errorCauses.map((cause, i) => (
            <div key={i} className="break-words">
              {cause.type}
              {cause.message ? `: ${cause.message}` : ''}
            </div>
          ))}
        </Labelled>
      ) : null}
      {row.errorThread ? (
        <Labelled label={t('activity_error_thread', 'Thread')}>{row.errorThread}</Labelled>
      ) : null}
      {row.lastActivity ? (
        <Labelled label={t('activity_error_last_activity', 'Last activity before this error')}>
          {row.lastActivity}
        </Labelled>
      ) : null}
      {row.fatal !== null ? (
        <Labelled label={t('activity_error_fatal', 'Fatal')}>
          {row.fatal ? t('activity_yes', 'Yes') : t('activity_no', 'No')}
        </Labelled>
      ) : null}
    </div>
  );
};

// One line: the phone's time, then the sentence and its other details, dimmed. Errors are red and open their detail.
const LogLineRow: FC<{
  line: LogLine;
  highlighted: boolean;
  expanded: boolean;
  onToggle: () => void;
}> = ({ line, highlighted, expanded, onToggle }) => {
  const t = useT();
  const { row } = line;
  const isError = row.kind === 'error' && !line.end;
  const sentence = line.end ? { text: endSentence(row, t), used: [] } : startSentence(row, t);
  const details = line.end
    ? []
    : Object.entries(row.meta ?? {}).filter(([key]) => !sentence.used.includes(key));
  const body = (
    <>
      <span className="font-mono text-[12px] opacity-70 text-end pe-[12px] border-e border-newTableBorder">
        {phoneTime(line.at, row.tz).format('h:mm:ss A')}
      </span>
      <span className="min-w-0 break-words ps-[12px]">
        <span
          dir="auto"
          className={clsx(
            isError && 'text-red-400 font-[600]',
            row.name === 'screen' && 'opacity-60'
          )}
        >
          {sentence.text}
        </span>
        {details.length > 0 ? (
          <span className="opacity-50 text-[12px]">
            {' · '}
            {details.map(([key, value]) => `${words(key)} ${String(value)}`).join(' · ')}
          </span>
        ) : null}
      </span>
    </>
  );
  const rowClass = clsx(
    'grid grid-cols-[96px_1fr] items-baseline py-[3px] text-[14px] w-full text-start rounded-[4px]',
    highlighted && 'bg-boxHover'
  );
  if (!isError) {
    return <div className={rowClass}>{body}</div>;
  }
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={clsx(rowClass, 'hover:bg-boxHover cursor-pointer')}
      >
        {body}
      </button>
      {expanded ? (
        <div className="ps-[108px] pb-[8px] text-[13px]">
          <ErrorDetail row={row} />
        </div>
      ) : null}
    </div>
  );
};

// The line above the steps of a new session: who it is (a link to the device's log) on the log of every device,
// "New session" on the log of one device.
const SessionDivider: FC<{ device?: TrackerFeedDevice; deviceId: string; linked: boolean }> = ({
  device,
  deviceId,
  linked,
}) => {
  const t = useT();
  const who = device?.email ?? t('activity_anonymous', 'anonymous');
  const model = [device?.model, device?.os].filter(Boolean).join(' · ');
  return (
    <div className="flex items-center gap-[8px] pt-[10px] pb-[4px] text-[12px] min-w-0">
      {linked ? (
        <WorkspaceLink
          href={`/super-admin/activity/${deviceId}`}
          className="font-[600] underline break-all"
        >
          {who}
        </WorkspaceLink>
      ) : (
        <span className="opacity-60">{t('activity_new_session', 'New session')}</span>
      )}
      {linked && model ? <span className="opacity-50 break-words">{model}</span> : null}
      <span className="flex-1 h-px bg-newTableBorder" />
    </div>
  );
};

// The activity log: of one device when `deviceId` is given, of every device otherwise. `at` opens the log at that
// activity: its line is highlighted and scrolled into view, and an error opens its detail. "Load more" adds older days.
export const TrackerLog: FC<{ deviceId?: string; at?: string }> = ({ deviceId, at }) => {
  const t = useT();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<TrackerActivityRow[]>([]);
  const [devices, setDevices] = useState<Record<string, TrackerFeedDevice>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [showScreens, setShowScreens] = useState(false);
  // Which error lines are open, by activity id. The `at` error starts open.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    at ? { [at]: true } : {}
  );
  const atRef = useRef<HTMLDivElement>(null);
  const scrolledTo = useRef<string | null>(null);
  const { data, isLoading, error } = useTrackerFeed({ deviceId, cursor, at });

  // The first page replaces the rows and a "Load more" page joins them. A page re-run by SWR (focus revalidation)
  // replaces its own rows, so none are listed twice.
  useEffect(() => {
    if (!data) {
      return;
    }
    setRows((prev) => {
      if (!cursor) {
        return data.items;
      }
      const loaded = new Set(data.items.map((row) => row.id));
      return [...prev.filter((row) => !loaded.has(row.id)), ...data.items];
    });
    setDevices((prev) => ({
      ...prev,
      ...Object.fromEntries(data.devices.map((device) => [device.deviceId, device])),
    }));
    setNextCursor(data.nextCursor);
  }, [data, cursor]);

  // Once the `at` line is on screen, it is scrolled into view (once).
  useEffect(() => {
    if (at && scrolledTo.current !== at && atRef.current) {
      scrolledTo.current = at;
      atRef.current.scrollIntoView({ block: 'center' });
    }
  }, [at, rows]);

  if (error && rows.length === 0) {
    return (
      <div className="text-red-400">
        {t('activity_log_failed', 'Failed to load the activity log.')}
      </div>
    );
  }
  if (!data && rows.length === 0) {
    return <LoadingComponent />;
  }

  const days = daysOf(linesOf(rows, showScreens, at));

  return (
    <div className="flex flex-col gap-[12px] min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-[8px]">
        <div className="text-[16px] font-[600]">{t('activity_log', 'Activity log')}</div>
        <label className="flex items-center gap-[6px] text-[13px] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showScreens}
            onChange={(e) => setShowScreens(e.target.checked)}
          />
          {t('activity_show_screens', 'Show screens')}
        </label>
      </div>
      {days.length === 0 ? (
        <div className="opacity-70">{t('activity_no_activity_yet', 'No activity yet')}</div>
      ) : (
        days.map((day) => (
          <section
            key={day.label}
            className="border border-newTableBorder rounded-[8px] bg-newBgColorInner px-[12px] pb-[10px] min-w-0"
          >
            <h3 className="text-[15px] font-[600] py-[10px] border-b border-newTableBorder">
              {day.label}
            </h3>
            {day.lines.map((line, i) => {
              const before = day.lines[i - 1];
              const newSession = !before || before.row.sessionKey !== line.row.sessionKey;
              return (
                <div key={line.key} ref={line.key === at ? atRef : undefined}>
                  {newSession ? (
                    <SessionDivider
                      device={devices[line.row.deviceId]}
                      deviceId={line.row.deviceId}
                      linked={!deviceId}
                    />
                  ) : null}
                  <LogLineRow
                    line={line}
                    highlighted={line.key === at}
                    expanded={!!expanded[line.row.id]}
                    onToggle={() =>
                      setExpanded((prev) => ({ ...prev, [line.row.id]: !prev[line.row.id] }))
                    }
                  />
                </div>
              );
            })}
          </section>
        ))
      )}
      {error ? (
        <div className="text-[13px] text-red-400">
          {t('activity_log_failed', 'Failed to load the activity log.')}
        </div>
      ) : null}
      {nextCursor ? (
        <div className="flex justify-center">
          <Button
            secondary
            loading={isLoading && !!cursor}
            onClick={() => setCursor(nextCursor)}
          >
            {t('activity_load_older', 'Load older')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
