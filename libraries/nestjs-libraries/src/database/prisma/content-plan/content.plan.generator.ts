// Content plan generator: every AI call of the content plan (setup rounds, plan structure, week ideas, outlines, a
// week of videos, one video) through the Meta chat client, and nothing else: no database, no credits. Each call sends
// the messages in one fixed order (rules, brand context, frame, then the task) so Meta's prompt cache can match the
// shared start; the answers are validated, tidied and clamped to the limits here. All prompt text lives in
// `prompts/`; this file only imports it. The angle of a video comes from its slot, never from the model.
import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { z } from 'zod';
import {
  MuseChatService,
  ChatTurn,
  PlanUsage,
} from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import {
  INSTANT_FIELD_HINTS,
  PLANNER_MODEL,
  PLANNER_PROMPTS,
  PLANNER_RULES,
  PROPOSAL_FIELD_HINTS,
  PlannerPromptKey,
  SETUP_FIELD_HINTS,
  VIDEO_SET_FIELD_HINTS,
  WEEKLY_FIELD_HINTS,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/prompts';
import {
  brandContextMessage,
  cleanSlideText,
  stableJson,
} from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.rules';
import { cutAtWord } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.generator';
import {
  Angle,
  beatsFor,
  DEFAULT_VIDEO_SECONDS,
  LIMITS,
  MAX_ANSWER_OPTIONS,
  MAX_VIDEO_SET,
  PlanBeat,
  PlanFacts,
  PlanQuestion,
  targetWordsFor,
  VIDEO_SECONDS,
} from '@gitroom/nestjs-libraries/dtos/content-plan/content.plan.schema';

// The planner is not usable on this deployment: no Meta key, or Meta refused the key or the billing. The service turns
// it into 503 PLAN_NOT_AVAILABLE.
export class PlanNotConfigured extends Error {
  constructor() {
    super('The content planner is not available');
    this.name = 'PlanNotConfigured';
  }
}

// One AI call failed or answered something unusable. The job that made the call decides whether to try again.
export class PlanAiFailed extends Error {
  constructor(message = 'The content planner could not write this') {
    super(message);
    this.name = 'PlanAiFailed';
  }
}

// The most questions of a setup round, options of a question and beats of a video.
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MIN_BEATS = 3;
const MAX_BEATS = 6;
const MAX_THEMES = 6;
const MIN_THEMES = 3;

// The field hints of a question round's answer schema: the setup's, or another kind's with the same keys.
export type RoundFieldHints = typeof SETUP_FIELD_HINTS;

// The answer schemas of the model: Meta's strict subset (objects, arrays, strings, booleans, numbers; every field
// required). The `.describe()` texts are the field hints of the prompt files; lengths are clamped after parsing.
const roundSchema = (hints: RoundFieldHints) =>
  z.object({
    direction: z.string().describe(hints.direction),
    questions: z
      .array(
        z.object({
          text: z.string().describe(hints.text),
          options: z.array(z.string()).describe(hints.options),
          multiple: z.boolean().describe(hints.multiple),
          recommendedIndexes: z
            .array(z.number())
            .describe(hints.recommendedIndexes),
        })
      )
      .describe(hints.questions),
    readyForPlan: z.boolean().describe(hints.readyForPlan),
  });

const setupSchema = roundSchema(SETUP_FIELD_HINTS);

const proposalSchema = z.object({
  facts: z
    .object({
      whatWeDo: z.string().describe(PROPOSAL_FIELD_HINTS.whatWeDo),
      audience: z.string().describe(PROPOSAL_FIELD_HINTS.audience),
      problems: z.array(z.string()).describe(PROPOSAL_FIELD_HINTS.problems),
      solution: z.string().describe(PROPOSAL_FIELD_HINTS.solution),
      objections: z
        .array(z.string())
        .describe(PROPOSAL_FIELD_HINTS.objections),
      tone: z.string().describe(PROPOSAL_FIELD_HINTS.tone),
      videoSeconds: z.number().describe(PROPOSAL_FIELD_HINTS.videoSeconds),
    })
    .describe(PROPOSAL_FIELD_HINTS.facts),
  themes: z
    .array(
      z.object({
        ref: z.string().describe(PROPOSAL_FIELD_HINTS.ref),
        name: z.string().describe(PROPOSAL_FIELD_HINTS.name),
        description: z.string().describe(PROPOSAL_FIELD_HINTS.description),
      })
    )
    .describe(PROPOSAL_FIELD_HINTS.themes),
  clusters: z
    .array(
      z.object({
        ref: z.string().describe(PROPOSAL_FIELD_HINTS.ref),
        themeRef: z.string().describe(PROPOSAL_FIELD_HINTS.themeRef),
        title: z.string().describe(PROPOSAL_FIELD_HINTS.title),
        problem: z.string().describe(PROPOSAL_FIELD_HINTS.problem),
      })
    )
    .describe(PROPOSAL_FIELD_HINTS.clusters),
});

const ideasSchema = z.object({
  ideas: z.array(z.string()).describe(WEEKLY_FIELD_HINTS.ideas),
});

const outlineSchema = z.object({
  titles: z.array(z.string()).describe(WEEKLY_FIELD_HINTS.titles),
});

// A week answer; a day answer has the same shape with one video.
const weekSchema = z.object({
  brief: z.string().describe(WEEKLY_FIELD_HINTS.brief),
  videos: z
    .array(
      z.object({
        title: z.string().describe(WEEKLY_FIELD_HINTS.title),
        why: z.string().describe(WEEKLY_FIELD_HINTS.why),
        beats: z
          .array(
            z.object({
              hook: z.string().describe(WEEKLY_FIELD_HINTS.hook),
              say: z.string().describe(WEEKLY_FIELD_HINTS.say),
            })
          )
          .describe(WEEKLY_FIELD_HINTS.beats),
        closingLine: z.string().describe(WEEKLY_FIELD_HINTS.closingLine),
      })
    )
    .describe(WEEKLY_FIELD_HINTS.videos),
});

// An instant idea answer: one video, no angle.
const instantSchema = z.object({
  title: z.string().describe(INSTANT_FIELD_HINTS.title),
  why: z.string().describe(INSTANT_FIELD_HINTS.why),
  beats: z
    .array(
      z.object({
        hook: z.string().describe(INSTANT_FIELD_HINTS.hook),
        say: z.string().describe(INSTANT_FIELD_HINTS.say),
      })
    )
    .describe(INSTANT_FIELD_HINTS.beats),
  closingLine: z.string().describe(INSTANT_FIELD_HINTS.closingLine),
});

// A video-set answer: the videos of the set, each one an instant idea's video with a ref.
const videoSetSchema = z.object({
  videos: z
    .array(
      z.object({
        ref: z.string().describe(VIDEO_SET_FIELD_HINTS.ref),
        title: z.string().describe(VIDEO_SET_FIELD_HINTS.title),
        why: z.string().describe(VIDEO_SET_FIELD_HINTS.why),
        beats: z
          .array(
            z.object({
              hook: z.string().describe(VIDEO_SET_FIELD_HINTS.hook),
              say: z.string().describe(VIDEO_SET_FIELD_HINTS.say),
            })
          )
          .describe(VIDEO_SET_FIELD_HINTS.beats),
        closingLine: z.string().describe(VIDEO_SET_FIELD_HINTS.closingLine),
      })
    )
    .describe(VIDEO_SET_FIELD_HINTS.videos),
});

type RawVideo = z.infer<typeof instantSchema>;

// A text trimmed and cut at a word to at most `max` characters.
const cut = (text: string, max: number) =>
  cutAtWord(text.trim(), (value) => value.length <= max);

// What the weekly calls know about the brand. `facts` and `direction` are the confirmed ones.
export interface PlanWriteContext {
  orgId: string;
  name: string;
  locale: string;
  direction: string;
  facts: PlanFacts;
}

// What a week or a day is written from.
export interface PlanVideoContext extends PlanWriteContext {
  idea: string;
  clusterTitle: string;
  problem: string;
  brief: string | null;
  briefEdited: boolean;
  urgentNote: string | null;
  // The titles of the other days of the week, which this one must differ from.
  otherTitles: string[];
}

// One video day to write: the day of the week, its date, the angle code picked, and what it starts from.
export interface PlanSlot {
  dayIndex: number;
  date: string;
  angle: Angle;
  carried?: { title: string };
  outlineTitle?: string;
}

// One written video day.
export interface PlanDayDraft {
  dayIndex: number;
  title: string;
  why: string;
  beats: PlanBeat[];
  closingLine: string;
}

// One refined instant idea: the script of the owner's own video (no day, no angle).
export interface PlanInstantDraft {
  title: string;
  why: string;
  beats: PlanBeat[];
  closingLine: string;
}

// One video of a video set, written without a date: the session sets the dates.
export interface PlanVideoSetDraft extends PlanInstantDraft {
  ref: string;
}

// What a chat call (a setup round, the proposal or a revise) is made from.
export interface PlanChatInput {
  orgId: string;
  brandContext: string;
  // The stored earlier turns, re-sent exactly as they were stored.
  turns: ChatTurn[];
  newUserTurn: string;
}

// One written round of an interview chat.
export interface PlanChatRound {
  direction: string;
  questions: PlanQuestion[];
  readyForPlan: boolean;
  assistantTurn: string;
  usage: PlanUsage;
}

@Injectable()
export class ContentPlanGenerator {
  private readonly _logger = new Logger(ContentPlanGenerator.name);

  // Receives the client of Meta's chat model.
  constructor(private _muse: MuseChatService) {}

  // One call: the messages in the fixed order (rules, brand context, frame, then the task turns), the answer as
  // `schema`. Meta refusing the key or the billing is `PlanNotConfigured`; any other failure or an empty answer is
  // `PlanAiFailed`. Logs ids and numbers only, never a text.
  private async ask<T extends z.ZodTypeAny>(
    orgId: string,
    key: PlannerPromptKey,
    brandContext: string,
    task: ChatTurn[],
    schema: T,
    name: string
  ): Promise<{ data: z.infer<T>; text: string; usage: PlanUsage }> {
    if (!this._muse.configured()) {
      throw new PlanNotConfigured();
    }
    const frame = PLANNER_PROMPTS[key];
    const messages: ChatTurn[] = [
      { role: 'developer', content: PLANNER_RULES },
      { role: 'user', content: brandContext },
      { role: 'developer', content: frame.body },
      ...task,
    ];
    let answer;
    try {
      answer = await this._muse.writePlanPart(
        PLANNER_MODEL,
        frame.effort,
        messages,
        schema,
        name,
        `content-plan:${key}`
      );
    } catch (error) {
      const status =
        error instanceof OpenAI.APIError ? error.status : undefined;
      if (status === 401 || status === 402 || status === 403) {
        this._logger.error(
          `content plan: Meta key or billing refused status=${status}`
        );
        throw new PlanNotConfigured();
      }
      this._logger.warn(
        `content plan: call failed key=${key} org=${orgId} status=${
          status ?? 'none'
        } error=${(error as Error)?.name ?? 'unknown'}`
      );
      throw new PlanAiFailed();
    }
    const { usage } = answer;
    this._logger.log(
      `content plan tokens key=${key} org=${orgId} prompt=${usage.prompt} cached=${usage.cached} completion=${usage.completion}`
    );
    if (!answer.data) {
      throw new PlanAiFailed();
    }
    return { data: answer.data as z.infer<T>, text: answer.text, usage };
  }

  // One round of the setup interview: `chatRound` on the setup frame.
  setupRound(input: PlanChatInput): Promise<PlanChatRound> {
    return this.chatRound('planner.frame.setup', input);
  }

  // One round of an interview chat on the frame `frameKey` (the setup's, or the frame of a session kind). The owner's
  // first text, the answers and edits are in `newUserTurn`; the earlier rounds are in `turns`. Questions and options get
  // ids made here (q1.., o1..); `assistantTurn` is the raw answer text, stored as it was said. The answer is read as
  // `direction`, which a session stores as its summary. `hints` are the field hints of the answer schema: the setup's
  // unless a kind brings its own wording.
  async chatRound(
    frameKey: PlannerPromptKey,
    input: PlanChatInput,
    hints: RoundFieldHints = SETUP_FIELD_HINTS
  ): Promise<PlanChatRound> {
    const { data, text, usage } = await this.ask(
      input.orgId,
      frameKey,
      input.brandContext,
      [...input.turns, { role: 'user', content: input.newUserTurn }],
      hints === SETUP_FIELD_HINTS ? setupSchema : roundSchema(hints),
      'plan_setup'
    );
    const direction = cut(data.direction, LIMITS.direction);
    if (!direction) {
      throw new PlanAiFailed();
    }
    const questions: PlanQuestion[] = [];
    for (const question of data.questions) {
      const label = cut(question.text, LIMITS.other);
      // the options keep their place in the answer, so `recommendedIndexes` still point at the right ones
      const options = question.options
        .map((option, index) => ({ label: cut(option, LIMITS.other), index }))
        .filter((option) => option.label)
        .slice(0, MAX_ANSWER_OPTIONS);
      if (!label || options.length < MIN_OPTIONS) {
        continue;
      }
      if (questions.length === MAX_QUESTIONS) {
        break;
      }
      const number = questions.length + 1;
      // the positions of the recommended options that survived; a question takes one, so only its first counts
      const recommended = [
        ...new Set(
          question.recommendedIndexes.flatMap((recommendedIndex) => {
            const position = options.findIndex(
              (option) => option.index === recommendedIndex
            );
            return position < 0 ? [] : [position];
          })
        ),
      ].slice(0, question.multiple ? MAX_ANSWER_OPTIONS : 1);
      const recommendedOptionIds = (recommended.length ? recommended : [0]).map(
        (position) => `o${position + 1}`
      );
      questions.push({
        id: `q${number}`,
        text: label,
        options: options.map((option, index) => ({
          id: `o${index + 1}`,
          label: option.label,
        })),
        recommendedOptionId: recommendedOptionIds[0],
        multiple: !!question.multiple,
        recommendedOptionIds,
      });
    }
    return {
      direction,
      questions,
      readyForPlan: data.readyForPlan,
      assistantTurn: text,
      usage,
    };
  }

  // The structure of the plan (facts, themes, clusters) from the proposal chat (`newUserTurn` holds the direction, or
  // the owner's feedback on a revise). Themes and clusters get refs t1.. and c1.. made here; a cluster of an unknown
  // theme is dropped; the call fails when fewer than 3 themes remain or a theme has no cluster.
  async proposeStructure(input: PlanChatInput): Promise<{
    facts: PlanFacts;
    themes: { ref: string; name: string; description: string }[];
    clusters: { ref: string; themeRef: string; title: string; problem: string }[];
    assistantTurn: string;
    usage: PlanUsage;
  }> {
    const { data, text, usage } = await this.ask(
      input.orgId,
      'planner.frame.proposal',
      input.brandContext,
      [...input.turns, { role: 'user', content: input.newUserTurn }],
      proposalSchema,
      'plan_proposal'
    );
    const themeRefs = new Map<string, string>();
    const themes: { ref: string; name: string; description: string }[] = [];
    for (const theme of data.themes) {
      const name = cut(theme.name, LIMITS.title);
      if (!name || themeRefs.has(theme.ref) || themes.length === MAX_THEMES) {
        continue;
      }
      const ref = `t${themes.length + 1}`;
      themeRefs.set(theme.ref, ref);
      themes.push({ ref, name, description: cut(theme.description, LIMITS.why) });
    }
    const clusters: {
      ref: string;
      themeRef: string;
      title: string;
      problem: string;
    }[] = [];
    for (const cluster of data.clusters) {
      const themeRef = themeRefs.get(cluster.themeRef);
      const title = cut(cluster.title, LIMITS.title);
      const problem = cut(cluster.problem, LIMITS.other);
      if (!themeRef || !title || !problem) {
        continue;
      }
      clusters.push({ ref: `c${clusters.length + 1}`, themeRef, title, problem });
    }
    if (
      themes.length < MIN_THEMES ||
      themes.some((theme) => !clusters.some((c) => c.themeRef === theme.ref))
    ) {
      throw new PlanAiFailed();
    }
    return {
      facts: this.cleanFacts(data.facts),
      themes,
      clusters,
      assistantTurn: text,
      usage,
    };
  }

  // The facts as the owner may edit them later: trimmed, within the limits of the facts form, and a video length that
  // is one of the allowed ones (else the default).
  private cleanFacts(facts: z.infer<typeof proposalSchema>['facts']): PlanFacts {
    const list = (items: string[]) =>
      items
        .map((item) => cut(item, 500))
        .filter(Boolean)
        .slice(0, 20);
    const videoSeconds = (VIDEO_SECONDS as readonly number[]).includes(
      facts.videoSeconds
    )
      ? facts.videoSeconds
      : DEFAULT_VIDEO_SECONDS;
    return {
      whatWeDo: cut(facts.whatWeDo, 2000),
      audience: cut(facts.audience, 2000),
      problems: list(facts.problems),
      solution: cut(facts.solution, 2000),
      objections: list(facts.objections),
      tone: cut(facts.tone, 500),
      videoSeconds: videoSeconds as PlanFacts['videoSeconds'],
    };
  }

  // The brand context message of a confirmed plan.
  private contextOf(context: PlanWriteContext) {
    return brandContextMessage({
      name: context.name,
      locale: context.locale,
      facts: context.facts,
      direction: context.direction,
    });
  }

  // One idea per given week, in the same order.
  async writeIdeas(
    input: PlanWriteContext & {
      weeks: {
        weekStart: string;
        weekEnd: string;
        clusterTitle: string;
        problem: string;
        previousIdeas: string[];
      }[];
    }
  ): Promise<{ ideas: string[]; usage: PlanUsage }> {
    const { data, usage } = await this.ask(
      input.orgId,
      'planner.frame.roadmap',
      this.contextOf(input),
      [
        {
          role: 'user',
          content: stableJson({
            weeks: input.weeks.map((week) => ({
              weekStart: week.weekStart,
              weekEnd: week.weekEnd,
              clusterTitle: week.clusterTitle,
              problem: week.problem,
              previousIdeas: week.previousIdeas,
            })),
          }),
        },
      ],
      ideasSchema,
      'plan_ideas'
    );
    if (data.ideas.length !== input.weeks.length) {
      throw new PlanAiFailed();
    }
    const ideas = data.ideas.map((idea) => cut(idea, LIMITS.idea));
    if (ideas.some((idea) => !idea)) {
      throw new PlanAiFailed();
    }
    return { ideas, usage };
  }

  // One title per angle (one per video of the week), in the same order.
  async writeOutline(
    input: PlanWriteContext & {
      idea: string;
      clusterTitle: string;
      problem: string;
      angles: Angle[];
      videosPerWeek: number;
    }
  ): Promise<{ titles: string[]; usage: PlanUsage }> {
    const { data, usage } = await this.ask(
      input.orgId,
      'planner.frame.outline',
      this.contextOf(input),
      [
        {
          role: 'user',
          content: stableJson({
            idea: input.idea,
            clusterTitle: input.clusterTitle,
            problem: input.problem,
            videosPerWeek: input.videosPerWeek,
            titleMaxChars: LIMITS.title,
            slots: input.angles.map((angle) => ({ angle })),
          }),
        },
      ],
      outlineSchema,
      'plan_outline'
    );
    if (data.titles.length !== input.angles.length) {
      throw new PlanAiFailed();
    }
    const titles = data.titles.map((title) => cut(title, LIMITS.title));
    if (titles.some((title) => !title)) {
      throw new PlanAiFailed();
    }
    return { titles, usage };
  }

  // A week of videos: the brief and one day per slot, in slot order. The model answers by position; the day index and
  // the angle come from the slot. `videosPerWeek` is the week's count when only some of its videos are written (else
  // the number of slots).
  async writeWeek(
    input: PlanVideoContext & { slots: PlanSlot[]; videosPerWeek?: number }
  ): Promise<{ brief: string; days: PlanDayDraft[]; usage: PlanUsage }> {
    const { data, usage } = await this.writeVideos(
      'planner.frame.week',
      'plan_week',
      input,
      input.slots,
      input.videosPerWeek ?? input.slots.length
    );
    const brief = cut(data.brief, LIMITS.brief);
    if (!brief) {
      throw new PlanAiFailed();
    }
    return {
      brief,
      days: input.slots.map((slot, index) =>
        this.cleanVideo(slot.dayIndex, data.videos[index])
      ),
      usage,
    };
  }

  // One video of a week (a regenerated day, or a day that fills a free slot). `videosPerWeek` is the week's count.
  async writeDay(
    input: PlanVideoContext & { slot: PlanSlot; videosPerWeek: number }
  ): Promise<{ day: PlanDayDraft; usage: PlanUsage }> {
    const { data, usage } = await this.writeVideos(
      'planner.frame.day',
      'plan_day',
      input,
      [input.slot],
      input.videosPerWeek
    );
    return { day: this.cleanVideo(input.slot.dayIndex, data.videos[0]), usage };
  }

  // The owner's own idea refined into one video: a title, the why line, the beats and the closing line. The model gets
  // only the idea, the brand context and the video length; nothing of the plan, and no angle.
  async writeInstantIdea(
    input: PlanWriteContext & { idea: string }
  ): Promise<{ day: PlanInstantDraft; usage: PlanUsage }> {
    const videoSeconds = this.videoSecondsOf(input.facts);
    const { data, usage } = await this.ask(
      input.orgId,
      'planner.frame.instant',
      this.contextOf(input),
      [
        {
          role: 'user',
          content: stableJson({
            idea: input.idea,
            videoSeconds,
            beatsCount: beatsFor(videoSeconds),
            targetWords: targetWordsFor(videoSeconds),
            titleMaxChars: LIMITS.title,
          }),
        },
      ],
      instantSchema,
      'plan_instant'
    );
    return { day: this.tidyVideo(data), usage };
  }

  // The videos of a video set from the owner's idea (`idea` is what was understood, `answers` what the owner chose), as
  // the first turn of the proposal chat, or from the owner's `feedback` as the next turn after `turns`. `count` is how
  // many videos to write, exactly when `countFixed` (the owner chose it), else a default that the idea or the answers may
  // change; a revise may change it too. Videos get refs v1.. made here and no date. `userTurn` and `assistantTurn` are
  // the texts of the turns, stored as they were said.
  async writeVideoSet(
    input: PlanWriteContext & {
      idea: string;
      answers: { question: string; answer: string }[];
      count: number;
      countFixed: boolean;
      turns: ChatTurn[];
      feedback: string | null;
    }
  ): Promise<{
    videos: PlanVideoSetDraft[];
    userTurn: string;
    assistantTurn: string;
    usage: PlanUsage;
  }> {
    const videoSeconds = this.videoSecondsOf(input.facts);
    const userTurn = stableJson(
      input.feedback
        ? { feedback: input.feedback }
        : {
            idea: input.idea,
            answers: input.answers.length ? input.answers : undefined,
            videoCount: input.count,
            videoCountFixed: input.countFixed,
            videoSeconds,
            beatsCount: beatsFor(videoSeconds),
            targetWords: targetWordsFor(videoSeconds),
            titleMaxChars: LIMITS.title,
          }
    );
    const { data, text, usage } = await this.ask(
      input.orgId,
      'planner.frame.video_set',
      this.contextOf(input),
      [...input.turns, { role: 'user', content: userTurn }],
      videoSetSchema,
      'plan_video_set'
    );
    // exactly the owner's count on a first proposal that has one; otherwise 1 to the most a set holds
    const exact = !input.feedback && input.countFixed ? input.count : null;
    if (data.videos.length < (exact ?? 1)) {
      throw new PlanAiFailed();
    }
    const videos = data.videos
      .slice(0, exact ?? MAX_VIDEO_SET)
      .map((video, index) => ({ ref: `v${index + 1}`, ...this.tidyVideo(video) }));
    return { videos, userTurn, assistantTurn: text, usage };
  }

  // The video length of the facts when it is an allowed one, else the default.
  private videoSecondsOf(facts: PlanFacts) {
    return (VIDEO_SECONDS as readonly number[]).includes(facts.videoSeconds)
      ? facts.videoSeconds
      : DEFAULT_VIDEO_SECONDS;
  }

  // The call behind `writeWeek` and `writeDay`: the answer must hold exactly one video per slot.
  private async writeVideos(
    key: 'planner.frame.week' | 'planner.frame.day',
    name: string,
    input: PlanVideoContext,
    slots: PlanSlot[],
    videosPerWeek: number
  ) {
    const videoSeconds = this.videoSecondsOf(input.facts);
    const answer = await this.ask(
      input.orgId,
      key,
      this.contextOf(input),
      [
        {
          role: 'user',
          content: stableJson({
            idea: input.idea,
            clusterTitle: input.clusterTitle,
            problem: input.problem,
            brief: input.brief || undefined,
            briefEdited: input.briefEdited,
            urgentNote: input.urgentNote || undefined,
            otherTitles: input.otherTitles,
            slots: slots.map((slot) => ({
              angle: slot.angle,
              carried: slot.carried ? { title: slot.carried.title } : undefined,
              outlineTitle: slot.outlineTitle || undefined,
            })),
            videosPerWeek,
            videoSeconds,
            beatsCount: beatsFor(videoSeconds),
            targetWords: targetWordsFor(videoSeconds),
            titleMaxChars: LIMITS.title,
          }),
        },
      ],
      weekSchema,
      name
    );
    if (answer.data.videos.length !== slots.length) {
      throw new PlanAiFailed();
    }
    return answer;
  }

  // One written video of a day: tidied, with the day it is for.
  private cleanVideo(dayIndex: number, video: RawVideo): PlanDayDraft {
    return { dayIndex, ...this.tidyVideo(video) };
  }

  // One written video, tidied and clamped: visible texts cut at a word, hooks cleaned for a slide, beats with an empty
  // hook or say dropped. Fails when the video has no title or fewer than 3 usable beats.
  private tidyVideo(video: RawVideo): PlanInstantDraft {
    const title = cut(video.title, LIMITS.title);
    const beats = video.beats
      .map((beat) => ({
        hook: cut(cleanSlideText(beat.hook), LIMITS.hook),
        say: cut(beat.say, LIMITS.say),
      }))
      .filter((beat) => beat.hook && beat.say)
      .slice(0, MAX_BEATS);
    if (!title || beats.length < MIN_BEATS) {
      throw new PlanAiFailed();
    }
    return {
      title,
      why: cut(video.why, LIMITS.why),
      beats,
      closingLine: cut(video.closingLine, LIMITS.closingLine),
    };
  }
}
