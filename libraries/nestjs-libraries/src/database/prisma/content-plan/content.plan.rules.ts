// Content plan rules: pure helpers (no Nest, no Prisma) shared by the generator and the service. This file holds what a
// slide may contain (`cleanSlideText`), the byte-stable JSON of a model message (`stableJson`), the brand context
// message that opens every call of one brand (`brandContextMessage`), and the plain code rules of the plan: brand-local
// dates, the cluster rotation, the angle choice, the days of a week and the leftovers carried to the next week. Text
// sent to the model lives in `prompts/`; here only its labels are imported.
import type { PlanSlot } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.generator';
import {
  ANGLES,
  Angle,
  CARRY_MAX,
  DEFAULT_VIDEOS_PER_WEEK,
  PlanCarryItem,
  PlanFacts,
  PlanOutlineItem,
  SLIDE_TEXT_MAX,
  SLOT_DAYS,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';
import { BRAND_CONTEXT_LABELS } from '@gitroom/nestjs-libraries/database/prisma/content-plan/prompts';

// Quote pairs that may wrap a whole slide text.
const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['„', '“'],
  ['«', '»'],
  ['「', '」'],
];

// The one owner of what a slide may contain: plain text on one line, at most SLIDE_TEXT_MAX characters. It strips
// markup (list markers, emphasis, wrapping quotes) and never changes a letter, so any script and any language stay
// intact.
export const cleanSlideText = (text: string) => {
  let value = text
    // leading list markers: -, *, bullet, #, 1. and 1)
    .replace(/^\s*(?:(?:[-*•]|#+|\d+[.)])\s+)+/, '')
    // emphasis marks
    .replace(/\*\*|__|`/g, '')
    // line breaks and tabs become spaces, then spaces collapse
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const pair = QUOTE_PAIRS.find(
    ([open, close]) =>
      value.length > 1 && value.startsWith(open) && value.endsWith(close)
  );
  if (pair) {
    value = value.slice(pair[0].length, value.length - pair[1].length).trim();
  }
  return Array.from(value).slice(0, SLIDE_TEXT_MAX).join('').trimEnd();
};

// The JSON text of a model message. The caller builds `value` with a fixed key order (never an object spread from a
// database row), so the same input always gives the same bytes and the prompt cache can match the prefix.
export const stableJson = (value: unknown) => JSON.stringify(value);

// The summary of a round of an interview as the owner left it: the edit the owner sent with the answers (kept under
// `editedKey` in the next round's first turn), or for the latest round `latest`, which holds the owner's last edit, else
// the summary the AI wrote.
export const roundSummary = (
  round: { summary: string },
  next: { userTurn: string } | undefined,
  latest: string | null,
  editedKey: string
) => {
  if (!next) {
    return latest ?? round.summary;
  }
  try {
    const edited = JSON.parse(next.userTurn)?.[editedKey];
    return typeof edited === 'string' && edited ? edited : round.summary;
  } catch {
    return round.summary;
  }
};

// What the brand context message is written from.
export interface BrandContext {
  name: string;
  locale: string;
  facts: PlanFacts | null;
  direction: string | null;
}

// The brand context message: the same text for every call of one brand (no date, no id), so it is part of the cached
// prefix. The facts are written with a fixed key order, whatever the order of the object given.
export const brandContextMessage = (ctx: BrandContext) => {
  const labels = BRAND_CONTEXT_LABELS;
  const blocks = [
    `${labels.brand}: ${ctx.name.trim()}`,
    `${labels.language}: ${ctx.locale.trim()}`,
  ];
  if (ctx.facts) {
    const { facts } = ctx;
    blocks.push(
      `${labels.facts}:\n${stableJson({
        whatWeDo: facts.whatWeDo,
        audience: facts.audience,
        problems: facts.problems,
        solution: facts.solution,
        objections: facts.objections,
        tone: facts.tone,
        videoSeconds: facts.videoSeconds,
      })}`
    );
  }
  if (ctx.direction?.trim()) {
    blocks.push(`${labels.direction}:\n${ctx.direction.trim()}`);
  }
  return blocks.join('\n\n');
};

const DAY_MS = 24 * 60 * 60 * 1000;

// The UTC time of a YYYY-MM-DD date.
const utcOf = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
};

// The calendar date (YYYY-MM-DD) it is now in a time zone; a time zone this runtime does not know reads as UTC.
export const localToday = (now: Date, timeZone: string) => {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
};

// A date moved by `n` days (negative goes back), by UTC math on its parts so no time zone or daylight saving shifts it.
export const addDays = (date: string, n: number) =>
  new Date(utcOf(date) + n * DAY_MS).toISOString().slice(0, 10);

// The whole days from one date to another (negative when `to` is earlier).
export const daysBetween = (from: string, to: string) =>
  Math.round((utcOf(to) - utcOf(from)) / DAY_MS);

// The order the weeks walk through the clusters: the themes in `position` order take turns, each giving its next cluster
// (theme1-c1, theme2-c1, theme3-c1, theme1-c2, ...); a theme that runs out is skipped. Returns the cluster ids.
export const rotationOrder = (
  themes: { id: string; position: number }[],
  clusters: { id: string; themeId: string; position: number }[]
) => {
  const lists = [...themes]
    .sort((a, b) => a.position - b.position)
    .map((theme) =>
      clusters
        .filter((cluster) => cluster.themeId === theme.id)
        .sort((a, b) => a.position - b.position)
        .map((cluster) => cluster.id)
    );
  const order: string[] = [];
  for (let round = 0; lists.some((list) => round < list.length); round += 1) {
    for (const list of lists) {
      if (round < list.length) {
        order.push(list[round]);
      }
    }
  }
  return order;
};

// The cluster of the week after one on `previousClusterId`: the next in the rotation, wrapping round. A week with no
// previous cluster, or one that is no longer in the rotation (archived), starts the rotation again.
export const nextClusterId = (
  rotation: string[],
  previousClusterId: string | null
) => {
  if (!rotation.length) {
    throw new Error('The rotation has no cluster');
  }
  const index = previousClusterId ? rotation.indexOf(previousClusterId) : -1;
  return rotation[(index + 1) % rotation.length];
};

// `count` angles for the videos of a week of one cluster. Never-used angles come first, then the oldest last use; ties
// keep the `ANGLES` order read from index `seed % candidates.length` and wrapping, so weeks do not all open with the
// same angle. `trend` is a candidate only when allowed; `exclude` angles are taken already. When fewer than `count`
// candidates remain, the same order is used again from its start, so the pick never fails. The result is in that
// order, which is also the day order.
export const pickAngles = (
  count: number,
  lastUse: Map<Angle, string>,
  exclude: Angle[],
  allowTrend: boolean,
  seed: number
): Angle[] => {
  const allowed = (angle: Angle) => allowTrend || angle !== 'trend';
  let candidates = ANGLES.filter(
    (angle) => allowed(angle) && !exclude.includes(angle)
  );
  if (!candidates.length) {
    candidates = ANGLES.filter(allowed);
  }
  const start = Math.abs(seed) % candidates.length;
  const ordered = [...candidates.slice(start), ...candidates.slice(0, start)]
    // the sort is stable, so the rotated order breaks the ties
    .sort((a, b) => {
      const left = lastUse.get(a);
      const right = lastUse.get(b);
      if (!left || !right) {
        return left ? 1 : right ? -1 : 0;
      }
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return Array.from({ length: count }, (_, index) => ordered[index % ordered.length]);
};

// The positions (0-based) of a week's videos that a carried-over item takes, in order: 2nd, 4th and 6th.
const CARRY_POSITIONS = [1, 3, 5];

// The positions (0-based) that `count` carried items take in a week of `videosPerWeek` videos: only positions that
// exist, so 1 video takes none, 2-3 take one, 4-5 take two and 6-7 take three.
export const carryPositions = (videosPerWeek: number, count: number) =>
  CARRY_POSITIONS.filter((position) => position < videosPerWeek).slice(0, count);

// The videos of a week to write: `videosPerWeek` slots on the days of `SLOT_DAYS`. A slot takes the title and angle of
// the outline when the week has one, else the picked angle. Carried items replace the slots at the 2nd, 4th and 6th
// video, only where that video exists; an item that does not fit is ignored.
export const slotsForWeek = (input: {
  weekStart: string;
  videosPerWeek: number;
  outline: PlanOutlineItem[] | null;
  carryIn: PlanCarryItem[] | null;
  pickedAngles: Angle[];
}): PlanSlot[] => {
  const days = SLOT_DAYS[input.videosPerWeek] ?? SLOT_DAYS[DEFAULT_VIDEOS_PER_WEEK];
  const slots: PlanSlot[] = days.map((dayIndex, index) => ({
    dayIndex,
    date: addDays(input.weekStart, dayIndex),
    angle: input.outline?.[index]?.angle ?? input.pickedAngles[index] ?? ANGLES[0],
    outlineTitle: input.outline?.[index]?.title,
  }));
  (input.carryIn ?? []).forEach((item, index) => {
    const position = CARRY_POSITIONS[index];
    if (position === undefined || position >= slots.length) {
      return;
    }
    slots[position] = {
      dayIndex: slots[position].dayIndex,
      date: slots[position].date,
      angle: item.angle,
      carried: { title: item.title },
    };
  });
  return slots;
};

// The items a week carries in once the new ones are added: the ones already there stay first, then the new ones in the
// order given (the caller passes the earliest day first), up to `CARRY_MAX`. The rest are dropped.
export const mergeCarry = (
  existing: PlanCarryItem[],
  incoming: PlanCarryItem[]
) => {
  const all = [...existing, ...incoming];
  return { kept: all.slice(0, CARRY_MAX), dropped: all.slice(CARRY_MAX) };
};
