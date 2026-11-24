// Mobile activity log (api.activity-log): the plain-text timeline an admin reads for one user or device.
import type { ActivityEvent } from '@gitroom/nestjs-libraries/database/prisma/activity-log/activity.log.service';

// A detail value as it reads in a line: bare, or quoted when it holds spaces, `|` or `=`.
const valueText = (value: string | number | boolean) =>
  typeof value === 'string' && /[\s|=]/.test(value)
    ? JSON.stringify(value)
    : String(value);

// The event's time in the device's own clock, `2026-02-27 14:34:07` (`tz` minutes east of UTC).
export function localTime(event: Pick<ActivityEvent, 't' | 'tz'>) {
  return new Date(event.t + event.tz * 60000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

// One line: `2026-02-27 14:34:07 | record_stop | duration_ms=92000 source=button` (no third column without details).
export function timelineLine(event: ActivityEvent) {
  const meta = Object.entries(event.m ?? {})
    .map(([key, value]) => `${key}=${valueText(value)}`)
    .join(' ');
  return [localTime(event), event.a, meta].filter(Boolean).join(' | ');
}

// The whole text: the header lines, then the events in time order with a marker where the session changes.
// `truncated` says the event limit cut the end off.
export function renderTimeline(
  header: string[],
  events: ActivityEvent[],
  truncated: boolean
) {
  const lines = [...header, ''];
  events.forEach((event, i) => {
    if (i > 0 && events[i - 1].s !== event.s) {
      lines.push('-- new session --');
    }
    lines.push(timelineLine(event));
  });
  if (!events.length) {
    lines.push('(no events in this range)');
  }
  if (truncated) {
    lines.push('... more events exist; narrow from / to to see them');
  }
  return lines.join('\n') + '\n';
}
