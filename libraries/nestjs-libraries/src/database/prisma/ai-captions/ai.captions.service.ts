// AI captions (ai.video-captions): the caption job of one recording. The phone uploads the speech audio, then
// asks for a job: the credits for its whole minutes are held, and a workflow transcribes the audio, writes each
// channel's caption from the Prompt Book and keeps the credits held (or gives them back when nothing was written).
// The workflow's steps are the `...Caption` methods at the end, one per activity. A READY caption keeps its credits
// held until the phone says what became of the recording: `useCaption` commits them, `releaseCaption` gives them
// back (recording and throwing away are free), `includeInEdit` hands them to an AI edit that reuses the transcript.
// `applyToPosts` then puts a READY caption's text into the posts of a publish call, and `linkPosts` records the
// posts made. AI never blocks a publish: every way this can fail leaves the post as it would have been without it.
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, State } from '@prisma/client';
import { ApplicationFailure, TypedSearchAttributes } from '@temporalio/common';
import dayjs from 'dayjs';
import { TemporalService } from 'nestjs-temporal-core';
import {
  AiCaptionsRepository,
  NewAiCaptionOutput,
} from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.repository';
import {
  AiCaptionsGenerator,
  CaptionKind,
  CaptionTarget,
  captionToHtml,
  cutAtWord,
  GeneratedCaption,
} from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.generator';
import { AiCaptionCreateDto } from '@gitroom/nestjs-libraries/dtos/ai-captions/ai.captions.create.dto';
import { MOBILE_UPLOAD_PURPOSE_AUDIO } from '@gitroom/nestjs-libraries/dtos/mobile-upload/mobile.upload.create.dto';
import { AiChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { PublishChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.service';
import {
  captionMinutes,
  MAX_CAPTION_SECONDS,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/caption.minutes';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import {
  autoPublishDefaults,
  textPostDefaults,
} from '@gitroom/nestjs-libraries/integrations/auto.publish.defaults';
import { postTextLength } from '@gitroom/nestjs-libraries/integrations/post.text.limits';
import {
  MuseTranscribeError,
  MuseTranscriptionService,
} from '@gitroom/nestjs-libraries/muse/muse.transcription.service';
import { AiCaptionsNotConfigured } from '@gitroom/nestjs-libraries/muse/transcription.provider';
import type {
  TranscriptionProvider,
  TranscriptSegment,
  TranscriptWord,
} from '@gitroom/nestjs-libraries/muse/transcription.provider';
export type { TranscriptSegment, TranscriptWord };
import { organizationId } from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { deleteObject } from '@gitroom/nestjs-libraries/upload/r2.uploader';

// Where a caption job stands. PENDING until the workflow starts, then TRANSCRIBING and GENERATING; the last
// three are final.
export type AiCaptionStatus =
  | 'PENDING'
  | 'TRANSCRIBING'
  | 'GENERATING'
  | 'READY'
  | 'NO_SPEECH'
  | 'FAILED';
const FINAL_STATUSES: AiCaptionStatus[] = ['READY', 'NO_SPEECH', 'FAILED'];

// Where the credits of a caption stand (the AiCaption model says what each means).
export type AiCaptionCreditState =
  | 'SETTLED'
  | 'HELD'
  | 'COMMITTED'
  | 'RELEASED'
  | 'INCLUDED';

// A job in progress that has not changed for this long is dead: its workflow was lost, or the process stopped
// between holding the credits and starting it. A live job's whole run is about 80 minutes at the worst (3 tries of
// 15 minutes to transcribe, 3 of 10 to write, the waits between them) plus up to 35 while the credits are settled,
// and its row changes along the way; 3 hours is well past that, so a live job is never taken for a dead one.
const STALE_HOURS = 3;

// A recording with fewer spoken words than this has nothing worth a caption.
const MIN_SPOKEN_WORDS = 3;

// The phone cuts the audio at 60 minutes, and the cut can end a few samples (or a frame) past it. Only audio more
// than this many seconds over the limit is refused; the charge stays capped at 60 minutes.
const AUDIO_SLACK_SECONDS = 10;

// What the customer reads. The reason itself (a provider's answer, a stack) is only logged.
const FAILED_TEXT = 'The captions could not be written for this recording.';
const AUDIO_FAILED_TEXT = 'The audio of this recording could not be transcribed.';
const NO_SPEECH_TEXT = 'No speech was found in this recording.';
const NOT_STARTED_TEXT = 'The captions could not be started.';

// The answer of `create` for a job that was made (or made before: `status` is where it stands now).
export interface AiCaptionCreated {
  id: string;
  status: AiCaptionStatus;
  // credits held for the whole minutes of speech (0 under a minute)
  cost: number;
  minutes: number;
}

// The answer of `create` when the credits for the captions and the publish do not both fit; nothing was held.
export interface AiCaptionSkipped {
  status: 'SKIPPED';
  reason: 'CREDITS';
}

// Subtitle synchronization data for video playback and subtitle burn-in.
export interface AiCaptionSubtitles {
  language?: string;
  words: TranscriptWord[];
  segments: TranscriptSegment[];
}

// A caption as the phone reads it (the transcript is for the web page only).
export interface AiCaptionView {
  id: string;
  status: AiCaptionStatus;
  error?: string;
  language?: string;
  subtitles?: AiCaptionSubtitles;
  outputs: Array<{
    integrationId: string;
    provider: string;
    kind: CaptionKind;
    title?: string;
    text: string;
  }>;
}

// A caption as the web page reads it: the phone's view with the recording name, the transcript and, for each text,
// the post made from it and where that post stands (`postState` is missing when the post was deleted).
export interface AiCaptionDetail extends Omit<AiCaptionView, 'outputs'> {
  title?: string;
  createdAt: Date;
  transcript?: string;
  segments?: TranscriptSegment[];
  words?: TranscriptWord[];
  outputs: Array<
    AiCaptionView['outputs'][number] & {
      postId?: string;
      postGroup?: string;
      postState?: State;
      publishDate?: Date;
    }
  >;
}

// A channel entry of a create-post body, as far as the captions touch it.
export interface CaptionablePost {
  integration: { id: string };
  settings?: Record<string, unknown>;
  value: Array<{ content?: string; image?: unknown[] }>;
}

// How the posts' first text is made.
export interface ApplyCaptionContext {
  // The marker of a Set's text where the caption goes: the Set's other text stays, a text without the marker
  // gets the caption in front, and a title the Set already has is kept. Without it the first text is what the
  // creator typed (a manual publish): the caption comes first, the creator's text follows word for word, and
  // the caption's title replaces the one the app derived.
  placeholder?: string;
}

// An error of the caption routes, in the public API's shape { statusCode, code, message }.
export class AiCaptionsException extends HttpException {
  // Answers `status` with the stable `code` the app switches on.
  constructor(status: number, code: string, message: string) {
    super({ statusCode: status, code, message }, status);
  }
}

// A reason retrying can't change (an audio the transcriber cannot take, no key): the workflow stops and the
// message is the text the customer reads.
export class AiCaptionsStop extends ApplicationFailure {
  constructor(message: string) {
    super(message, 'ai_captions_stop', true);
  }
}

// The idempotency key of the credits held for a caption: its id, so the job holds them once.
const creditsKey = (captionId: string) => `ai:captions:${captionId}`;

// A channel's stored additionalSettings (JSON text) as the array providers' maxLength reads; [] when missing or
// not JSON.
const parseAdditionalSettings = (value: string | null | undefined) => {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// The caption's lines as one escaped line, for a placeholder inside a line of the Set's text.
const oneLine = (text: string) =>
  captionToHtml(text)
    .replace(/(<\/p><p>)+/g, ' ')
    .slice('<p>'.length, -'</p>'.length);

// A post's text as HTML: the editor's own stays as it is; a text with no HTML at all (not from the editor) is
// taken as plain text, one paragraph per line.
const asHtml = (content: string) =>
  !content.trim() || /<[a-z!/]/i.test(content)
    ? content
    : captionToHtml(content);

// The Set's first text with the caption where its placeholder is: a paragraph of its own is replaced by the
// caption's paragraphs, a placeholder inside a line by the caption as part of the line; a text without a
// placeholder in a paragraph gets the caption in front. The rest of the Set's text stays as it is.
const placeCaption = (content: string, placeholder: string, text: string) => {
  const html = captionToHtml(text);
  const set = asHtml(content);
  const placed = set.replace(
    /<p[^>]*>([\s\S]*?)<\/p>/g,
    (paragraph, inner: string) =>
      inner.trim() === placeholder
        ? html
        : paragraph.split(placeholder).join(oneLine(text))
  );
  return placed === set ? html + set : placed;
};

// The first text of a post with the caption's text in it: in a Set's text at the placeholder, else in front of
// the creator's own text (`own`, already HTML). The caption is cut after the last whole word that still fits the
// channel's limit, measured as validation counts the whole text; undefined when none of it fits.
const captionedContent = (
  identifier: string,
  first: string,
  caption: string,
  own: string,
  limit: number | undefined,
  placeholder?: string
) => {
  const compose = (text: string) =>
    placeholder ? placeCaption(first, placeholder, text) : captionToHtml(text) + own;
  const fits = (text: string) =>
    !limit || postTextLength(identifier, compose(text)) <= limit;
  const kept = fits(caption) ? caption : cutAtWord(caption, fits);
  return kept ? compose(kept) : undefined;
};

// Intl.Segmenter is newer than the TypeScript lib the project builds with.
type WordSegmenter = new (
  locale: string | undefined,
  options: { granularity: 'word' }
) => { segment(text: string): Iterable<{ isWordLike?: boolean }> };

// How many words the text has, as the language itself divides them (Japanese and Chinese have no spaces).
const spokenWords = (text: string) => {
  const Segmenter = (Intl as unknown as { Segmenter: WordSegmenter }).Segmenter;
  let count = 0;
  for (const part of new Segmenter(undefined, {
    granularity: 'word',
  }).segment(text)) {
    if (part.isWordLike) {
      count++;
    }
  }
  return count;
};

// A live caption of the workspace with its written texts, as the repository gives it.
type StoredCaption = NonNullable<
  Awaited<ReturnType<AiCaptionsRepository['getCaption']>>
>;

@Injectable()
export class AiCaptionsService {
  private readonly _logger = new Logger(AiCaptionsService.name);

  // Receives the storage of the jobs, the credits services that hold and settle their cost, the channel services
  // that tell what each channel takes, the transcriber, the writer of the captions and the workflow engine.
  constructor(
    private _aiCaptionsRepository: AiCaptionsRepository,
    private _aiChargingService: AiChargingService,
    private _creditsService: CreditsService,
    private _publishChargingService: PublishChargingService,
    private _integrationService: IntegrationService,
    private _integrationManager: IntegrationManager,
    // the one transcriber (Muse); this service only knows its interface
    @Inject(MuseTranscriptionService)
    private _transcription: TranscriptionProvider,
    private _aiCaptionsGenerator: AiCaptionsGenerator,
    private _temporalService: TemporalService
  ) {}

  // Starts the caption job of an uploaded speech audio for these channels (the ones auto-publish posts to, or the
  // ones the phone named; the caller works them out; none is fine: the job then makes the transcript and subtitles
  // only, and costs the transcription alone). A repeat for the same audio answers the caption it made and
  // holds nothing again. Answers SKIPPED, holding nothing, when the captions and the publish together cost more
  // than the available credits. Refuses with 503 when a key is missing, 404 AUDIO_NOT_FOUND, 409
  // AUDIO_NOT_COMPLETE, 404 CHANNEL_NOT_FOUND, and 400 AUDIO_NOT_SUPPORTED or AUDIO_TOO_LONG. The audio of a caption
  // deleted since is 404 CAPTION_NOT_FOUND. A repeat that finds its job dead (`expire`) ends it and answers FAILED.
  async create(
    orgId: string,
    userId: string | undefined,
    body: AiCaptionCreateDto,
    integrationIds: string[]
  ): Promise<AiCaptionCreated | AiCaptionSkipped> {
    // Asked before the audio is checked: the sweep marks even a captioned audio expired after a day, and a repeat
    // must answer its caption, not 409.
    const existing = await this._aiCaptionsRepository.findByAudioUpload(
      orgId,
      body.audioUploadId
    );
    if (existing) {
      return this.repeated(orgId, existing);
    }

    this.requireConfigured();
    const audio = await this._aiCaptionsRepository.audioUpload(
      orgId,
      body.audioUploadId
    );
    if (!audio || audio.purpose !== MOBILE_UPLOAD_PURPOSE_AUDIO) {
      throw new AiCaptionsException(
        404,
        'AUDIO_NOT_FOUND',
        'Audio upload not found'
      );
    }
    if (audio.status !== 'completed') {
      throw new AiCaptionsException(
        409,
        'AUDIO_NOT_COMPLETE',
        'The audio upload is not complete'
      );
    }

    const channels = await this.liveChannels(orgId, integrationIds);
    const client = this._temporalService.client.getRawClient();
    if (!client) {
      throw new HttpException('AI captions are not available', 503);
    }

    // What is charged is the length in the file, never what the phone says
    const seconds = await this.audioSeconds(audio.objectKey);
    if (seconds > MAX_CAPTION_SECONDS + AUDIO_SLACK_SECONDS) {
      throw new AiCaptionsException(
        400,
        'AUDIO_TOO_LONG',
        'The audio is longer than 60 minutes'
      );
    }
    const minutes = captionMinutes(seconds);

    const [cost, publishCost, { available }] = await Promise.all([
      this.costOf(orgId, minutes),
      // no channel, no post to keep credits for
      channels.length
        ? this._publishChargingService
            .preview(orgId, { integrationIds: channels.map((c) => c.id) })
            .then((preview) => preview.amount)
        : 0,
      this._creditsService.balance(orgId),
    ]);
    // AI never takes credits a post needs
    if (cost + publishCost > available) {
      return { status: 'SKIPPED', reason: 'CREDITS' };
    }

    const caption = await this._aiCaptionsRepository.createCaption({
      organizationId: orgId,
      userId,
      audioUploadId: body.audioUploadId,
      mode: body.mode,
      title: body.title,
      userText: body.userText,
      integrationIds: channels.map((c) => c.id),
      // whole seconds keep the minutes: floor(floor(s) / 60) = floor(s / 60)
      audioSeconds: Math.floor(seconds),
    });
    if (!caption) {
      // two creates for one audio raced and the other won
      const winner = await this._aiCaptionsRepository.findByAudioUpload(
        orgId,
        body.audioUploadId
      );
      // The winner is gone when its credits could not be held: it removed its row and answered SKIPPED. They are
      // short for this audio too, and nothing is held here either.
      return winner
        ? this.repeated(orgId, winner)
        : { status: 'SKIPPED', reason: 'CREDITS' };
    }

    try {
      await this.holdCredits(caption);
    } catch (err) {
      // Nothing is held, so nothing is made: the audio may ask again
      await this._aiCaptionsRepository.deleteCaption(orgId, caption.id);
      if (err instanceof HttpException && err.getStatus() === 402) {
        return { status: 'SKIPPED', reason: 'CREDITS' };
      }
      throw err;
    }

    try {
      await client.workflow.start('aiCaptionsWorkflow', {
        workflowId: `ai_captions_${caption.id}`,
        taskQueue: 'main',
        args: [{ captionId: caption.id }],
        typedSearchAttributes: new TypedSearchAttributes([
          {
            key: organizationId,
            value: orgId,
          },
        ]),
      });
    } catch (err) {
      // no workflow means nothing will ever move the caption on
      this._logger.error(
        `Could not start the workflow of caption ${caption.id}: ${
          (err as Error).message
        }`
      );
      try {
        await this.settle(caption, false);
      } catch (releaseErr) {
        // a hold that could not be released is released by the reconciliation job
        this._logger.error(
          `Could not release the credits of caption ${caption.id}: ${
            (releaseErr as Error).message
          }`
        );
      }
      await this._aiCaptionsRepository.updateCaption(orgId, caption.id, {
        status: 'FAILED',
        error: NOT_STARTED_TEXT,
      });
      await this.removeAudio(caption);
      throw new HttpException('AI captions are not available', 503);
    }

    return { id: caption.id, status: 'PENDING', cost, minutes };
  }

  // A caption as the phone reads it; 404 CAPTION_NOT_FOUND for another workspace's or a deleted one. The texts and
  // subtitle synchronization data are given once the caption is READY. A job that stopped moving is ended first
  // (`expire`) and read as FAILED.
  async get(orgId: string, id: string): Promise<AiCaptionView> {
    const caption = await this.live(orgId, id);
    if (!caption) {
      throw this.notFound();
    }
    const rawSegments = caption.segments as unknown as TranscriptSegment[] | null;
    const segments = Array.isArray(rawSegments) ? rawSegments : [];
    const extractedWords = segments.flatMap((s) => s.words || []);
    const subtitles: AiCaptionSubtitles | undefined =
      caption.status === 'READY' && (segments.length > 0 || extractedWords.length > 0)
        ? {
            language: caption.language ?? undefined,
            words: extractedWords,
            segments,
          }
        : undefined;

    return {
      ...this.head(caption),
      ...(subtitles ? { subtitles } : {}),
      outputs: this.texts(caption).map((output) => this.textView(output)),
    };
  }

  // A caption as the web page reads it: the phone's view, the transcript, and for each text the post made from it
  // and where that post stands; 404 CAPTION_NOT_FOUND for another workspace's or a deleted one. A job that stopped
  // moving is ended first, as in `get`.
  async detail(orgId: string, id: string): Promise<AiCaptionDetail> {
    const caption = await this.live(orgId, id);
    if (!caption) {
      throw this.notFound();
    }
    const texts = this.texts(caption);
    const postIds = texts.flatMap((output) =>
      output.postId ? [output.postId] : []
    );
    // only the workspace's own live posts are looked up: a deleted post has no state
    const posts = postIds.length
      ? await this._aiCaptionsRepository.postStates(orgId, postIds)
      : [];
    const rawSegments = caption.segments as unknown as TranscriptSegment[] | null;
    const segments = Array.isArray(rawSegments) ? rawSegments : undefined;
    const words = segments ? segments.flatMap((s) => s.words || []) : undefined;
    return {
      ...this.head(caption),
      ...(caption.title ? { title: caption.title } : {}),
      createdAt: caption.createdAt,
      ...(caption.transcript ? { transcript: caption.transcript } : {}),
      ...(segments ? { segments, words } : {}),
      outputs: texts.map((output) => {
        const post = posts.find((p) => p.id === output.postId);
        return {
          ...this.textView(output),
          ...(output.postId ? { postId: output.postId } : {}),
          ...(output.postGroup ? { postGroup: output.postGroup } : {}),
          ...(post
            ? { postState: post.state, publishDate: post.publishDate }
            : {}),
        };
      }),
    };
  }

  // One page of the workspace's captions, newest first, each with the channels it was written for. A job that
  // stopped moving is ended first (`expire`) and listed as the caption it now is.
  async list(orgId: string, page: number) {
    const [{ items, pages }, integrations] = await Promise.all([
      this._aiCaptionsRepository.listCaptions(orgId, page),
      this._integrationService.getIntegrationsList(orgId),
    ]);
    const statuses = await Promise.all(
      items.map(async (caption) =>
        this.isStale(caption)
          ? (await this.expire(caption.id)) ?? caption.status
          : caption.status
      )
    );
    return {
      pages,
      items: items.map((caption, index) => ({
        id: caption.id,
        createdAt: caption.createdAt,
        title: caption.title,
        status: statuses[index] as AiCaptionStatus,
        channels: caption.integrationIds.flatMap((integrationId) => {
          const integration = integrations.find((i) => i.id === integrationId);
          return integration
            ? [
                {
                  integrationId,
                  provider: integration.providerIdentifier,
                  picture: integration.picture ?? null,
                },
              ]
            : [];
        }),
      })),
    };
  }

  // Deletes a caption of the workspace (hidden, and the transcript dropped); 404 for another workspace's.
  async softDelete(orgId: string, id: string) {
    if (!(await this._aiCaptionsRepository.softDeleteCaption(orgId, id))) {
      throw this.notFound();
    }
  }

  // What one minute of captions costs this workspace now (the phone shows it before it records).
  costPerMinute(orgId: string) {
    return this.costOf(orgId, 1);
  }

  // What the captions of this many seconds of speech cost this workspace now; 0 under a minute.
  costOfSeconds(orgId: string, seconds: number) {
    return this.costOf(orgId, captionMinutes(seconds));
  }

  // The posts of a publish call with the text of a READY caption of the workspace: each channel gets the text
  // written for it (and its title), and a channel that takes no video gets that text without the video. The posts
  // are changed only here, before the shared create-post code validates and charges them:
  // - a caption that is not READY, deleted, unknown or another workspace's changes nothing for a channel that takes
  //   a video; a channel that takes none keeps only the creator's own text (and no video), or is dropped when it
  //   has none
  // - a channel the caption wrote no text for (a READY caption can have none) is treated the same way
  // - the first text of each post only; thread comments stay as they are
  // Any failure here leaves the posts as they came: AI never breaks a publish.
  async applyToPosts<T extends CaptionablePost>(
    orgId: string,
    captionId: string,
    posts: T[],
    ctx: ApplyCaptionContext = {}
  ): Promise<T[]> {
    try {
      return await this.apply(orgId, captionId, posts, ctx);
    } catch (err) {
      this._logger.error(
        `Could not apply caption ${captionId}: ${(err as Error).message}`
      );
      return posts;
    }
  }

  // Records, on the text written for each channel, the post that was made from it. The posts exist already, so
  // this never fails the publish.
  async linkPosts(
    orgId: string,
    captionId: string,
    created: Array<{ postId: string; integration: string }>
  ) {
    try {
      if (created.length) {
        await this._aiCaptionsRepository.linkOutputs(
          orgId,
          captionId,
          created.map((post) => ({
            integrationId: post.integration,
            postId: post.postId,
          }))
        );
      }
    } catch (err) {
      this._logger.error(
        `Could not link the posts to caption ${captionId}: ${
          (err as Error).message
        }`
      );
    }
  }

  // The phone used the caption (its transcript went into a video or a post): commits the credits held for it. A
  // hold the nightly reconciliation gave back is reserved again at today's price first. Answers where the credits
  // stand afterwards, null for another workspace's or a deleted caption. It never throws: a caption whose credits
  // cannot be committed now stays HELD (the answer says so) and a publish goes on; only a caption held, or
  // given back, is touched, so a repeat changes nothing.
  async useCaption(
    orgId: string,
    captionId: string
  ): Promise<AiCaptionCreditState | null> {
    try {
      const caption = await this.owned(orgId, captionId);
      if (!caption || caption.deletedAt) {
        return null;
      }
      const state = caption.creditState as AiCaptionCreditState;
      if (state !== 'HELD' && state !== 'RELEASED') {
        return state;
      }
      try {
        await this.settle(caption, true);
      } catch (err) {
        if (!(err instanceof HttpException && err.getStatus() === 409)) {
          throw err;
        }
        await this.holdCredits(caption);
        await this.settle(caption, true);
      }
      await this._aiCaptionsRepository.updateCaption(orgId, caption.id, {
        creditState: 'COMMITTED',
      });
      return 'COMMITTED';
    } catch (err) {
      this._logger.error(
        `Could not commit the credits of caption ${captionId}: ${
          (err as Error).message
        }`
      );
      return 'HELD';
    }
  }

  // The phone threw the recording away without using the caption: gives the held credits back. Answers where the
  // credits stand afterwards, null for another workspace's caption (a deleted one is still released). Never throws;
  // a caption that is not held is left as it is.
  releaseCaption(orgId: string, captionId: string) {
    return this.giveBack(orgId, captionId, 'RELEASED');
  }

  // An AI edit that reuses the caption's transcript took it over: gives the held credits back and marks the caption
  // INCLUDED, so the transcript is paid once, in the edit. Never throws.
  async includeInEdit(orgId: string, captionId: string) {
    await this.giveBack(orgId, captionId, 'INCLUDED');
  }

  // The first activity: transcribes the audio and keeps the transcript. The audio is deleted from storage once it
  // is transcribed. Repeating it after the transcript is kept only deletes the audio again. A job that already
  // ended is not reopened, and a caption deleted meanwhile never gets its transcript back (the job stops and
  // `failCaption` gives the credits back).
  async transcribeCaption(captionId: string) {
    const caption = await this.job(captionId);
    if (FINAL_STATUSES.includes(caption.status as AiCaptionStatus)) {
      return;
    }
    if (caption.transcript === null) {
      if (caption.deletedAt) {
        throw new AiCaptionsStop(FAILED_TEXT);
      }
      const audio = await this._aiCaptionsRepository.audioUpload(
        caption.organizationId,
        caption.audioUploadId
      );
      if (!audio) {
        throw new AiCaptionsStop(AUDIO_FAILED_TEXT);
      }
      await this._aiCaptionsRepository.updateCaption(
        caption.organizationId,
        caption.id,
        { status: 'TRANSCRIBING' }
      );
      const transcription = await this.transcribeAudio(audio.objectKey);
      const kept = await this._aiCaptionsRepository.saveTranscript(
        caption.organizationId,
        caption.id,
        {
          transcript: transcription.text,
          segments: transcription.segments as unknown as Prisma.InputJsonValue,
          language: transcription.language ?? null,
        }
      );
      if (!kept) {
        throw new AiCaptionsStop(FAILED_TEXT);
      }
    }
    await this.removeAudio(caption);
  }

  // The second activity: writes the text of every channel from the transcript. A transcript of fewer than
  // MIN_SPOKEN_WORDS words ends the job as NO_SPEECH and gives the credits back (`noSpeech`: the workflow stops).
  // Repeating it writes the same set again in one write.
  async generateCaption(captionId: string): Promise<{ noSpeech: boolean }> {
    const caption = await this.job(captionId);
    if (FINAL_STATUSES.includes(caption.status as AiCaptionStatus)) {
      return { noSpeech: caption.status === 'NO_SPEECH' };
    }
    if (caption.transcript === null) {
      throw new AiCaptionsStop(FAILED_TEXT);
    }

    const transcript = caption.transcript.trim();
    if (spokenWords(transcript) < MIN_SPOKEN_WORDS) {
      // the credits first: a repeat of this step must find the job unfinished
      await this.settle(caption, false);
      await this._aiCaptionsRepository.updateCaption(
        caption.organizationId,
        caption.id,
        { status: 'NO_SPEECH', error: NO_SPEECH_TEXT }
      );
      await this.removeAudio(caption);
      return { noSpeech: true };
    }

    await this._aiCaptionsRepository.updateCaption(
      caption.organizationId,
      caption.id,
      { status: 'GENERATING' }
    );
    const { channels, targets } = await this.plan(caption);
    const written = await this._aiCaptionsGenerator.generate(
      caption.organizationId,
      {
        transcript,
        language: caption.language ?? undefined,
        userText: caption.userText?.trim() || undefined,
        targets,
      }
    );
    await this._aiCaptionsRepository.replaceOutputs(
      caption.id,
      written.flatMap((output) => this.outputRows(output, channels))
    );
    return { noSpeech: false };
  }

  // The third activity: marks the job READY. The credits stay held (HELD) until the phone uses the caption or throws
  // it away; nothing happens to a job that ended without text. Repeating it changes nothing.
  async finishCaption(captionId: string) {
    const caption = await this.job(captionId);
    if (caption.status === 'NO_SPEECH' || caption.status === 'FAILED') {
      return;
    }
    if (caption.status !== 'READY') {
      await this._aiCaptionsRepository.updateCaption(
        caption.organizationId,
        caption.id,
        { status: 'READY', error: null, creditState: 'HELD' }
      );
    }
    // a second chance for an audio that could not be deleted after the transcription
    await this.removeAudio(caption);
  }

  // The failure path of the workflow: ends a job that has not ended. The credits are given back unless the texts
  // were already saved: then the caption is READY and they stay held. `error` is a text written for the
  // customer (an AiCaptionsStop's); without one the stored error is a generic one.
  async failCaption(captionId: string, error?: string) {
    const caption = await this._aiCaptionsRepository.getCaptionById(captionId);
    if (!caption) {
      return;
    }
    if (!FINAL_STATUSES.includes(caption.status as AiCaptionStatus)) {
      const written =
        (await this._aiCaptionsRepository.countOutputs(caption.id)) > 0;
      // the credits first: a repeat of this step must find the job unfinished
      if (!written) {
        await this.settle(caption, false);
      }
      await this._aiCaptionsRepository.updateCaption(
        caption.organizationId,
        caption.id,
        written
          ? { status: 'READY', error: null, creditState: 'HELD' }
          : { status: 'FAILED', error: error || FAILED_TEXT }
      );
    }
    await this.removeAudio(caption);
  }

  // The workspace's caption by id, a deleted one included; null when it is not the workspace's.
  private async owned(orgId: string, id: string) {
    const caption = await this._aiCaptionsRepository.getCaptionById(id);
    return caption && caption.organizationId === orgId ? caption : null;
  }

  // Gives the credits held for a caption back and records why (`to`). Only a HELD caption is touched; answers where
  // the credits stand afterwards, null for another workspace's caption. A failure is only logged: the nightly
  // reconciliation releases a hold that stays.
  private async giveBack(
    orgId: string,
    captionId: string,
    to: 'RELEASED' | 'INCLUDED'
  ): Promise<AiCaptionCreditState | null> {
    try {
      const caption = await this.owned(orgId, captionId);
      if (!caption) {
        return null;
      }
      if (caption.creditState !== 'HELD') {
        return caption.creditState as AiCaptionCreditState;
      }
      await this.settle(caption, false);
      await this._aiCaptionsRepository.updateCaption(orgId, caption.id, {
        creditState: to,
      });
      return to;
    } catch (err) {
      this._logger.error(
        `Could not give back the credits of caption ${captionId}: ${
          (err as Error).message
        }`
      );
      return 'HELD';
    }
  }

  // Holds the credits of a caption's whole minutes (none under a minute). Safe to repeat: the key is the caption's.
  private async holdCredits(caption: {
    id: string;
    organizationId: string;
    userId: string | null;
    audioSeconds: number | null;
  }) {
    const minutes = captionMinutes(caption.audioSeconds ?? 0);
    if (minutes > 0) {
      await this._aiChargingService.reserve({
        organizationId: caption.organizationId,
        userId: caption.userId ?? undefined,
        kind: 'captions',
        quantity: minutes,
        idempotencyKey: creditsKey(caption.id),
        metadata: { route: 'ai-captions' },
      });
    }
  }

  // 503 AI_CAPTIONS_NOT_CONFIGURED when the transcriber's key or OpenAI's is missing.
  private requireConfigured() {
    if (
      !this._transcription.isConfigured() ||
      !process.env.OPENAI_API_KEY?.trim()
    ) {
      throw new AiCaptionsNotConfigured();
    }
  }

  // Where a caption stands, as the phone and the web page both read it.
  private head(caption: StoredCaption) {
    return {
      id: caption.id,
      status: caption.status as AiCaptionStatus,
      ...(caption.error ? { error: caption.error } : {}),
      ...(caption.language ? { language: caption.language } : {}),
    };
  }

  // The texts of a caption: written once it is READY, none before.
  private texts(caption: StoredCaption) {
    return caption.status === 'READY' ? caption.outputs : [];
  }

  // One written text as the phone reads it.
  private textView(output: StoredCaption['outputs'][number]) {
    return {
      integrationId: output.integrationId,
      provider: output.providerIdentifier,
      kind: output.kind as CaptionKind,
      ...(output.title ? { title: output.title } : {}),
      text: output.text,
    };
  }

  // 404 CAPTION_NOT_FOUND.
  private notFound() {
    return new AiCaptionsException(404, 'CAPTION_NOT_FOUND', 'Caption not found');
  }

  // The caption a job step works on; a missing one is a reason retrying can't change.
  private async job(captionId: string) {
    const caption = await this._aiCaptionsRepository.getCaptionById(captionId);
    if (!caption) {
      throw new AiCaptionsStop('Caption not found');
    }
    return caption;
  }

  // The answer for a caption that exists already: where it stands now and what it held. The price is today's. A
  // deleted caption is gone for good (its transcript is dropped and its audio is deleted): its audio names no
  // caption the phone could read. A job that stopped moving is ended first (`expire`), so the phone reads FAILED
  // and publishes as today instead of waiting on it.
  private async repeated(
    orgId: string,
    caption: {
      id: string;
      status: string;
      audioSeconds: number | null;
      updatedAt: Date;
      deletedAt: Date | null;
    }
  ): Promise<AiCaptionCreated> {
    if (caption.deletedAt) {
      throw this.notFound();
    }
    const status = this.isStale(caption)
      ? (await this.expire(caption.id)) ?? caption.status
      : caption.status;
    const minutes = captionMinutes(caption.audioSeconds ?? 0);
    const released = ['FAILED', 'NO_SPEECH'].includes(status);
    return {
      id: caption.id,
      status: status as AiCaptionStatus,
      cost: released ? 0 : await this.costOf(orgId, minutes),
      minutes,
    };
  }

  // The workspace's live caption with its texts, as the repository gives it, after a job that stopped moving has
  // been ended (`expire`); null when it is not the workspace's or is deleted.
  private async live(orgId: string, id: string) {
    const caption = await this._aiCaptionsRepository.getCaption(orgId, id);
    if (caption && this.isStale(caption)) {
      await this.expire(id);
      return this._aiCaptionsRepository.getCaption(orgId, id);
    }
    return caption;
  }

  // The moment before which a job in progress that has not changed is dead.
  private staleBefore() {
    return dayjs().subtract(STALE_HOURS, 'hour');
  }

  // Whether the job is in progress and has not changed for STALE_HOURS (`updatedAt` moves with every change).
  private isStale(caption: { status: string; updatedAt: Date }) {
    return (
      !FINAL_STATUSES.includes(caption.status as AiCaptionStatus) &&
      dayjs(caption.updatedAt).isBefore(this.staleBefore())
    );
  }

  // Ends a job that stopped moving, on the read that finds it (as clipping does; no scheduled job): FAILED with a
  // text of ours, the credits given back, the audio deleted. When texts were already written it is READY and the
  // credits stay held (the rule of `failCaption`). The job is taken
  // by one write guarded on "still in progress and still not changed since the cutoff": a workflow that moved it
  // meanwhile keeps it, and only the call that took it settles, so reads racing each other settle once. A workflow
  // that wakes up late finds the job ended, and its steps leave an ended job alone. A hold that cannot be released
  // here is released by the nightly credits reconciliation. Answers the status the caption has afterwards
  // (undefined when it is gone).
  private async expire(id: string) {
    const caption = await this._aiCaptionsRepository.getCaptionById(id);
    // it moved on since the caller read it
    if (!caption || !this.isStale(caption)) {
      return caption?.status;
    }
    const written = (await this._aiCaptionsRepository.countOutputs(id)) > 0;
    const next = written
      ? { status: 'READY', error: null, creditState: 'HELD' }
      : { status: 'FAILED', error: FAILED_TEXT };
    const taken = await this._aiCaptionsRepository.closeStale(
      caption.organizationId,
      id,
      this.staleBefore().toDate(),
      next
    );
    if (!taken) {
      return (await this._aiCaptionsRepository.getCaptionById(id))?.status;
    }
    this._logger.warn(
      `Caption ${id} stopped moving in ${caption.status}: ended as ${next.status}`
    );
    try {
      if (!written) {
        await this.settle(caption, false);
      }
    } catch (err) {
      this._logger.error(
        `Could not settle the credits of caption ${id}: ${(err as Error).message}`
      );
    }
    await this.removeAudio(caption);
    return next.status;
  }

  // The credits the whole minutes cost this workspace; 0 under a minute.
  private async costOf(orgId: string, minutes: number) {
    return minutes > 0
      ? (
          await this._aiChargingService.estimate(orgId, {
            kind: 'captions',
            quantity: minutes,
          })
        ).amount
      : 0;
  }

  // The seconds of speech in the stored audio, from its WAV header. Audio the transcriber cannot take is 400
  // AUDIO_NOT_SUPPORTED, in words that never carry the transcriber's own.
  private async audioSeconds(key: string) {
    try {
      return await this._transcription.audioSeconds(key);
    } catch (err) {
      if (err instanceof MuseTranscribeError) {
        this._logger.warn(`Audio refused: ${err.message}`);
        throw new AiCaptionsException(
          400,
          'AUDIO_NOT_SUPPORTED',
          'The audio must be a mono 16-bit WAV at 16 or 24 kHz'
        );
      }
      throw err;
    }
  }

  // The workspace's live channels among the ids, each once (none for no ids: the job then makes the transcript and
  // subtitles only); 404 CHANNEL_NOT_FOUND for an id that is not one.
  private async liveChannels(orgId: string, ids: string[]) {
    const wanted = [...new Set(ids)];
    if (!wanted.length) {
      return [];
    }
    const live = await this._integrationService.getIntegrationsList(orgId);
    return wanted.map((id) => {
      const channel = live.find((i) => i.id === id);
      if (!channel) {
        throw new AiCaptionsException(
          404,
          'CHANNEL_NOT_FOUND',
          'Channel not found'
        );
      }
      return channel;
    });
  }

  // Transcribes the stored audio. What the transcriber refuses for good, or a missing key, stops the job with
  // a text of ours; anything else is thrown as it came so the activity is retried.
  private async transcribeAudio(key: string) {
    try {
      return await this._transcription.transcribe(key);
    } catch (err) {
      if (err instanceof AiCaptionsNotConfigured) {
        throw new AiCaptionsStop(FAILED_TEXT);
      }
      if (err instanceof MuseTranscribeError && !err.retryable) {
        this._logger.warn(`Transcription refused: ${err.message}`);
        throw new AiCaptionsStop(AUDIO_FAILED_TEXT);
      }
      throw err;
    }
  }

  // The channels of a caption that are still live, each with the kind of post it gets, and the texts to write:
  // one target for every provider and kind, as long as the shortest limit among its channels.
  private async plan(caption: {
    organizationId: string;
    integrationIds: string[];
  }) {
    const live = await this._integrationService.getIntegrationsList(
      caption.organizationId
    );
    const channels: Array<{ id: string; identifier: string; kind: CaptionKind }> =
      [];
    const targets = new Map<string, CaptionTarget>();
    for (const id of caption.integrationIds) {
      const channel = live.find((i) => i.id === id);
      const provider =
        channel &&
        this._integrationManager.getSocialIntegration(
          channel.providerIdentifier
        );
      if (!channel || !provider) {
        continue;
      }
      const identifier = channel.providerIdentifier;
      const kind: CaptionKind = provider.acceptsVideo === false ? 'text' : 'video';
      channels.push({ id, identifier, kind });

      // the limit of the post the recording gets by default (a video post, or the text post of a channel that
      // takes no video)
      const limits = [
        targets.get(`${identifier}:${kind}`)?.maxLength,
        provider.maxLength(parseAdditionalSettings(channel.additionalSettings), {
          ...autoPublishDefaults(identifier),
          ...textPostDefaults(identifier),
        }),
      ].filter((limit): limit is number => !!limit);
      targets.set(`${identifier}:${kind}`, {
        identifier,
        platform: provider.name,
        kind,
        maxLength: limits.length ? Math.min(...limits) : undefined,
      });
    }
    return { channels, targets: [...targets.values()] };
  }

  // The rows of one written text: one for every channel of its provider and kind, the channels sharing the text.
  private outputRows(
    output: GeneratedCaption,
    channels: Array<{ id: string; identifier: string; kind: CaptionKind }>
  ): NewAiCaptionOutput[] {
    return channels
      .filter(
        (channel) =>
          channel.identifier === output.identifier &&
          channel.kind === output.kind
      )
      .map((channel) => ({
        integrationId: channel.id,
        providerIdentifier: output.identifier,
        kind: output.kind,
        title: output.title,
        text: output.text,
        hashtags: output.hashtags,
        promptKey: output.promptKey,
        promptVersion: output.promptVersion,
        promptSource: output.promptSource,
        model: output.model,
      }));
  }

  // `applyToPosts` without its safety net.
  private async apply<T extends CaptionablePost>(
    orgId: string,
    captionId: string,
    posts: T[],
    ctx: ApplyCaptionContext
  ): Promise<T[]> {
    const [caption, live] = await Promise.all([
      this._aiCaptionsRepository.getCaption(orgId, captionId),
      this._integrationService.getIntegrationsList(orgId),
    ]);
    const ready = caption?.status === 'READY' ? caption : null;
    // what the creator typed when the job was made, as HTML
    const typed = ready?.userText?.trim();
    const kept = typed ? captionToHtml(typed) : '';

    const applied: T[] = [];
    for (const post of posts) {
      const channel = live.find((i) => i.id === post?.integration?.id);
      const provider =
        channel &&
        this._integrationManager.getSocialIntegration(channel.providerIdentifier);
      if (!channel || !provider || !post.value?.length) {
        // the shared create-post code answers a channel or a text it cannot use, as before
        applied.push(post);
        continue;
      }
      const identifier = channel.providerIdentifier;
      const textOnly = provider.acceptsVideo === false;
      const first = String(post.value[0].content ?? '');
      const output = ready?.outputs.find((o) => o.integrationId === channel.id);
      // in a manual publish the creator's text follows the caption: as the job kept it, else the post's own text
      const own = ctx.placeholder
        ? ''
        : kept || (postTextLength(identifier, first) ? asHtml(first) : '');
      const content =
        output &&
        captionedContent(
          identifier,
          first,
          output.text,
          own,
          provider.maxLength(
            parseAdditionalSettings(channel.additionalSettings),
            post.settings || {}
          ) || undefined,
          ctx.placeholder
        );

      if (output && content !== undefined) {
        // a title the Set already has is the creator's own
        const keepTitle =
          ctx.placeholder && String(post.settings?.title ?? '').trim();
        applied.push(
          this.withText(post, content, textOnly, keepTitle ? undefined : output.title)
        );
      } else if (!textOnly) {
        applied.push(post);
      } else {
        // no caption text for a channel that takes no video: its post is the creator's own text, or nothing
        const text = ctx.placeholder ? first.split(ctx.placeholder).join('') : first;
        if (postTextLength(identifier, text)) {
          applied.push(this.withText(post, text, true));
        }
      }
    }
    return applied;
  }

  // The post with this first text, its video taken off when the channel takes none, and `title` in its settings.
  private withText<T extends CaptionablePost>(
    post: T,
    content: string,
    textOnly: boolean,
    title?: string | null
  ): T {
    const [first, ...rest] = post.value;
    return {
      ...post,
      ...(title ? { settings: { ...post.settings, title } } : {}),
      value: [{ ...first, content, ...(textOnly ? { image: [] } : {}) }, ...rest],
    } as T;
  }

  // Commits (`ok`) or gives back the credits held for a caption. Under a minute nothing was held. The workspace id
  // always goes with the key.
  private async settle(
    caption: { id: string; organizationId: string; audioSeconds: number | null },
    ok: boolean
  ) {
    const minutes = captionMinutes(caption.audioSeconds ?? 0);
    if (minutes > 0) {
      await this._aiChargingService.finish(
        creditsKey(caption.id),
        ok ? { ok: true, actualUnits: minutes } : { ok: false },
        caption.organizationId
      );
    }
  }

  // Deletes the caption's audio from storage. A failure is only logged: the sweep of old audio is the backstop.
  private async removeAudio(caption: {
    id: string;
    organizationId: string;
    audioUploadId: string;
  }) {
    try {
      const audio = await this._aiCaptionsRepository.audioUpload(
        caption.organizationId,
        caption.audioUploadId
      );
      if (audio) {
        await deleteObject(audio.objectKey);
      }
    } catch (err) {
      this._logger.warn(
        `Could not delete the audio of caption ${caption.id}: ${
          (err as Error).message
        }`
      );
    }
  }
}
