// Content plan: the shared types, limits and constants of the AI content plan, and the validated shapes of every
// request body. Both the backend and the frontend import from here.
import { z } from 'zod';

export const ANGLES = [
  'problem',
  'mistake',
  'story',
  'question',
  'comparison',
  'steps',
  'fear_loss',
  'behind_the_scenes',
  'customer_voice',
  'trend',
] as const;
export type Angle = (typeof ANGLES)[number];
export const ROADMAP_WEEKS = 12;
export const CARRY_MAX = 3;
// Weeks with a full outline in the preview.
export const PREVIEW_WEEKS = 4;
export const LIMITS = {
  sourceText: 8000,
  direction: 6000,
  brief: 2000,
  idea: 300,
  urgentNote: 1000,
  feedback: 2000,
  title: 60,
  why: 240,
  hook: 100,
  other: 300,
  // `say` and `closingLine` are never shown while recording (Practice only), so they get no visible-text limit, only a
  // high safety cap against runaway output.
  say: 2000,
  closingLine: 600,
};
// The most options one question of a setup round offers, and so the most one answer can tick.
export const MAX_ANSWER_OPTIONS = 4;
// The phone's text-slide limit.
export const SLIDE_TEXT_MAX = 200;
// Up to this length the phone shows a slide at full size (26sp).
export const SLIDE_TEXT_FULL_SIZE = 100;
export const VIDEO_SECONDS = [30, 60, 90, 120] as const;
export const DEFAULT_VIDEO_SECONDS = 60;
export const VIDEOS_PER_WEEK = [1, 2, 3, 4, 5, 6, 7] as const;
export const DEFAULT_VIDEOS_PER_WEEK = 3;
// Which days of the 7-day week (offsets from the week's start) carry a video: spread evenly, floor(i * 7 / count).
export const SLOT_DAYS: Record<number, number[]> = {
  1: [0],
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 5],
  5: [0, 1, 2, 4, 5],
  6: [0, 1, 2, 3, 4, 5],
  7: [0, 1, 2, 3, 4, 5, 6],
};
// Beats per video, decided by code from the video length: <=45 s -> 3, <=75 s -> 4, <=105 s -> 5, else 6.
export const beatsFor = (seconds: number) =>
  seconds <= 45 ? 3 : seconds <= 75 ? 4 : seconds <= 105 ? 5 : 6;
// Estimate of spoken words per second, used only to give the model a spoken-length target (`targetWords`); code never
// counts words and never checks against it.
export const WORDS_PER_SECOND = 2.3;
export const targetWordsFor = (seconds: number) =>
  Math.round(seconds * WORDS_PER_SECOND);

export type PlanStatus = 'NONE' | 'SETUP' | 'PROPOSED' | 'ACTIVE';
export interface PlanFacts {
  whatWeDo: string;
  audience: string;
  problems: string[];
  solution: string;
  objections: string[];
  tone: string;
  videoSeconds: (typeof VIDEO_SECONDS)[number];
}
export interface PlanBeat {
  hook: string;
  say: string;
}
export interface PlanQuestion {
  id: string;
  text: string;
  options: { id: string; label: string }[];
  // The first recommended option; the only one a round written before several answers were allowed has.
  recommendedOptionId: string;
  // A question the owner may answer with several options; a stored question without it takes one.
  multiple?: boolean;
  // Every recommended option, pre-ticked; a stored question without it recommends `recommendedOptionId` only.
  recommendedOptionIds?: string[];
}
export interface PlanAnswer {
  questionId: string;
  optionId: string | null;
  // The ticked options of a question that takes several; `optionId` stays for a question that takes one.
  optionIds?: string[];
  other: string | null;
}
export interface PlanOutlineItem {
  title: string;
  angle: Angle;
}
export interface PlanCarryItem {
  title: string;
  angle: Angle;
  clusterId: string;
}
export interface PlanProposal {
  version: number;
  facts: PlanFacts;
  themes: { ref: string; name: string; description: string }[];
  clusters: { ref: string; themeRef: string; title: string; problem: string }[];
  weeks: {
    weekStart: string;
    clusterRef: string;
    idea: string;
    outline: PlanOutlineItem[] | null;
  }[];
}
// An instant idea has no day slot and no angle: `kind` is INSTANT_IDEA, `dayIndex` and `angle` are null.
export interface PlanDayView {
  id: string;
  kind: 'PLANNED' | 'INSTANT_IDEA';
  date: string;
  dayIndex: number | null;
  title: string;
  angle: Angle | null;
  why: string;
  beats: PlanBeat[];
  closingLine: string;
  status: 'PLANNED' | 'RECORDED' | 'MISSED';
  busy: boolean;
  version: number;
}
// The owner's own video as the page draws it; DRAFT is the script waiting for the owner to add it to the plan.
export interface PlanInstantIdeaView {
  id: string;
  date: string;
  idea: string;
  title: string;
  why: string;
  beats: PlanBeat[];
  closingLine: string;
  status: 'DRAFT' | 'PLANNED' | 'RECORDED' | 'MISSED';
}
export interface PlanWeekView {
  id: string;
  weekStart: string;
  weekEnd: string;
  idea: string;
  brief: string | null;
  urgentNote: string | null;
  status: 'IDEA' | 'GENERATING' | 'READY' | 'FAILED';
  days: PlanDayView[];
}
export interface PlanUpcomingView {
  id: string;
  weekStart: string;
  idea: string;
  ideaEdited: boolean;
  theme: string;
}
// One video of the week as the phone gets it (`GET /public/v1/content-plan/week`).
export interface PhoneDayView {
  id: string;
  kind: 'PLANNED' | 'INSTANT_IDEA';
  date: string;
  dayIndex: number | null;
  title: string;
  angle: string | null;
  why: string;
  beats: PlanBeat[];
  closingLine: string;
  status: 'PLANNED' | 'RECORDED' | 'MISSED';
  version: number;
}
// The week the phone shows: `week` is the one that contains `today`; `days` is [] unless the week is READY.
export interface PhoneWeekView {
  status: PlanStatus;
  today: string;
  timezone: string;
  week: {
    id: string;
    weekStart: string;
    weekEnd: string;
    idea: string;
    status: 'IDEA' | 'GENERATING' | 'READY' | 'FAILED';
    days: PhoneDayView[];
  } | null;
}
// The phone's cheap "did the week change" value (`GET /public/v1/content-plan/week/stamp`): opaque, it differs whenever
// `PhoneWeekView` would.
export interface PhoneWeekStamp {
  stamp: string;
}
// A round of the setup as the owner sees it when going back to it: its questions, the answers given (null before the
// owner answered) and the direction as the owner left it.
export interface PlanRoundView {
  id: string;
  index: number;
  direction: string;
  questions: PlanQuestion[];
  answers: PlanAnswer[] | null;
  readyForPlan: boolean;
}
export interface PlanView {
  status: PlanStatus;
  canEdit: boolean;
  videosPerWeek: number;
  prefill: string;
  sourceText: string | null;
  direction: string | null;
  facts: PlanFacts | null;
  busy: string | null;
  notice: string | null;
  round: {
    id: string;
    index: number;
    direction: string;
    questions: PlanQuestion[];
    readyForPlan: boolean;
  } | null;
  // Every round of the setup, first to last, so the owner can go back to any of them.
  rounds: PlanRoundView[];
  proposal: PlanProposal | null;
  themes: { id: string; name: string }[];
  // The owner's open instant idea (still refining, refined and not added yet, or failed); null when there is none.
  instantDraft: PlanInstantIdeaView | null;
  today: string;
}

export type PlanSessionStatus = 'ASKING' | 'PROPOSING' | 'PROPOSED' | 'DONE' | 'DISCARDED';
// One round of a session, as the setup's `PlanRoundView` but with the summary of what the AI understood.
export interface PlanSessionRoundView {
  id: string;
  index: number;
  summary: string;
  questions: PlanQuestion[];
  answers: PlanAnswer[] | null;
  readyForPlan: boolean;
}
// A session of the planning engine as the page draws it. `proposal` is what the kind's `viewOf` makes of the stored
// proposal, shown only while the session is PROPOSED.
export interface PlanSessionView {
  id: string;
  kind: string;
  status: PlanSessionStatus;
  canEdit: boolean;
  sourceText: string | null;
  summary: string | null;
  options: Record<string, unknown> | null;
  busy: string | null;
  notice: string | null;
  round: PlanSessionRoundView | null;
  rounds: PlanSessionRoundView[];
  proposalVersion: number;
  proposal: unknown | null;
}
// The most videos one video-set session writes.
export const MAX_VIDEO_SET = 7;
// The options of a video-set session as they are stored: the date of its first video, how many videos, and whether the
// owner chose that number (the AI may then ask about it, and may write another number when the owner answers it).
export interface PlanVideoSetOptions {
  date: string;
  count: number;
  countSet: boolean;
}
// One video of a video-set proposal, with the date it is planned on.
export interface PlanVideoSetVideo {
  ref: string;
  title: string;
  why: string;
  beats: PlanBeat[];
  closingLine: string;
  date: string;
}
// A video-set proposal as the page draws it: the videos in date order, each ready for a phone-shaped preview.
export interface PlanVideoSetView {
  videos: PlanVideoSetVideo[];
}

// A required text: trimmed, not empty, at most `max` characters.
const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().min(1).max(64);
const videosPerWeek = z
  .number()
  .int()
  .refine(
    (value) => (VIDEOS_PER_WEEK as readonly number[]).includes(value),
    'must be a whole number from 1 to 7'
  );
const videoSeconds = z
  .number()
  .refine(
    (value) => (VIDEO_SECONDS as readonly number[]).includes(value),
    'must be 30, 60, 90 or 120'
  );
// A calendar date as YYYY-MM-DD.
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like 2026-11-22')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'must be a real date');

// One answer to a question of a setup round: a chosen option, an "Other" text, or both.
// Typed as PlanAnswer because the repo builds with strictNullChecks off, where z.infer makes every key optional.
const PlanAnswerSchema = z
  .object({
    questionId: id,
    optionId: id.nullable().default(null),
    optionIds: z.array(id).max(MAX_ANSWER_OPTIONS).default([]),
    other: z.string().trim().max(LIMITS.other).nullable().default(null),
  })
  .strict()
  .refine(
    (answer) => !!answer.optionId || !!answer.optionIds.length || !!answer.other,
    { message: 'needs an option or a text' }
  ) as z.ZodType<PlanAnswer, z.ZodTypeDef, unknown>;

// The facts about the business the AI filled in and the owner may edit.
export const FactsSchema = z
  .object({
    facts: z
      .object({
        whatWeDo: text(2000),
        audience: text(2000),
        problems: z.array(text(500)).max(20),
        solution: text(2000),
        objections: z.array(text(500)).max(20),
        tone: text(500),
        videoSeconds,
      })
      .strict(),
  })
  .strict();

// The body of `POST /content-plan/setup/start`.
export const StartSetupSchema = z
  .object({ sourceText: text(LIMITS.sourceText) })
  .strict();

// The body of `POST /content-plan/setup/answer`.
export const AnswerSetupSchema = z
  .object({
    roundId: id,
    direction: text(LIMITS.direction),
    answers: z.array(PlanAnswerSchema).max(4),
  })
  .strict();

// The body of `POST /content-plan/proposal`.
export const ProposeSchema = z
  .object({
    direction: text(LIMITS.direction),
    videosPerWeek,
    answers: z.array(PlanAnswerSchema).max(4).optional(),
  })
  .strict();

// The body of `POST /content-plan/proposal/revise`.
export const ReviseSchema = z
  .object({
    proposalVersion: z.number().int().min(0),
    feedback: text(LIMITS.feedback),
  })
  .strict();

// The body of `POST /content-plan/confirm`.
export const ConfirmSchema = z
  .object({ proposalVersion: z.number().int().min(0) })
  .strict();

// The body of `PUT /content-plan/direction`.
export const DirectionSchema = z
  .object({ direction: text(LIMITS.direction) })
  .strict();

// The body of `PUT /content-plan/weeks/:id/brief`.
export const BriefSchema = z.object({ brief: text(LIMITS.brief) }).strict();

// The body of `PUT /content-plan/weeks/:id/idea`.
export const IdeaSchema = z.object({ idea: text(LIMITS.idea) }).strict();

// The body of `POST /content-plan/weeks/:id/urgent`.
export const UrgentSchema = z
  .object({ note: text(LIMITS.urgentNote) })
  .strict();

// The body of `PUT /content-plan/videos-per-week`.
export const VideosPerWeekSchema = z.object({ videosPerWeek }).strict();

// The body of `POST /content-plan/instant-ideas`: the owner's own idea and the day it is for.
export const InstantIdeaSchema = z
  .object({ idea: text(LIMITS.idea), date })
  .strict();

// The options of a video-set session: the date of the first video (the kind checks it against today and the end of the
// plan) and how many videos, 1 to 7. Leave `count` out when the owner did not choose it.
export const VideoSetOptionsSchema = z
  .object({
    date: date.optional(),
    count: z.number().int().min(1).max(MAX_VIDEO_SET).optional(),
  })
  .strict();

// The edits the owner makes to a video-set proposal when confirming it: another date for any of its videos (the kind
// checks each against today and the end of the plan).
export const VideoSetEditsSchema = z
  .object({
    dates: z.array(z.object({ ref: id, date }).strict()).max(MAX_VIDEO_SET).optional(),
  })
  .strict();

// The body of a session's start: the kind of work, the owner's first text and the kind's own options (the kind checks
// them).
export const StartSessionSchema = z
  .object({
    kind: id,
    sourceText: text(LIMITS.sourceText),
    options: z.record(z.unknown()).optional(),
  })
  .strict();

// The query of `GET /content-plan/sessions/open`: the kind of session to resume.
export const OpenSessionSchema = z.object({ kind: id }).strict();

// The body of a session's answer: the round, the owner's edit of the summary and the answers.
export const AnswerSessionSchema = z
  .object({
    roundId: id,
    summary: text(LIMITS.direction),
    answers: z.array(PlanAnswerSchema).max(4),
  })
  .strict();

// The body of a session's proposal: the summary as the owner left it and the answers of the last round.
export const ProposeSessionSchema = z
  .object({
    summary: text(LIMITS.direction),
    answers: z.array(PlanAnswerSchema).max(4).optional(),
  })
  .strict();

// The body of a session's revise.
export const ReviseSessionSchema = ReviseSchema;

// The body of a session's confirm: the proposal version the owner read and the edits the kind accepts (the kind checks
// them).
export const ConfirmSessionSchema = z
  .object({
    proposalVersion: z.number().int().min(0),
    edits: z.record(z.unknown()).optional(),
  })
  .strict();
