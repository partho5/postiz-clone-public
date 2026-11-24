import { HttpException, Injectable } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { ApplicationFailure, TypedSearchAttributes } from '@temporalio/common';
import { TemporalService } from 'nestjs-temporal-core';
import { ClippingRepository } from '@gitroom/nestjs-libraries/database/prisma/clipping/clipping.repository';
import { ClippingDto } from '@gitroom/nestjs-libraries/dtos/clipping/clipping.dto';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import {
  ClippingTranscript,
  ClippingWord,
  ProcessorFailure,
} from '@gitroom/nestjs-libraries/upload/clipping.processor.interface';
import {
  AiCapReachedException,
  AiChargingService,
} from '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service';
import {
  CreditsService,
  InsufficientCreditsException,
} from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
import { DeepgramService } from '@gitroom/nestjs-libraries/deepgram/deepgram.service';
import { organizationId } from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { truncateForTemporal } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { randomBytes } from 'crypto';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { timer } from '@gitroom/helpers/utils/timer';
import dayjs from 'dayjs';

// A reason retrying can't change (private video, no minutes left, no speech):
// the workflow stops and the message is what the customer reads
export class ClippingStop extends ApplicationFailure {
  constructor(message: string) {
    super(truncateForTemporal(message, 2000), 'clipping_stop', true);
  }
}

// Answer of a job poll. "retry" is a failure the media service marked as
// retryable (or a crashed job), so the workflow submits the job again
export type ClippingJobState = 'pending' | 'retry' | 'done' | 'failed';

// Oxylabs only cuts on whole seconds, so the window is fetched a little wider
// and the clip job makes the exact cut inside it
const WINDOW_PADDING = 2;
const MIN_CLIP_SECONDS = 10;
const MAX_CLIP_SECONDS = 90;
// Longer than this no plan pays for, and the transcript stops fitting one prompt
const MAX_SOURCE_MINUTES = 180;
// Every clipping costs real money before its minutes are charged, so an
// organization runs one at a time and only so many a day
const MAX_RUNNING = 1;
const MAX_STARTS_PER_DAY = 20;
// A workflow that died (terminated, a database outage outliving its retries)
// leaves its record running forever; after this long it is closed and refunded
const STALE_HOURS = 4;
// What the customer reads when the real reason is not theirs to fix. The reason
// itself (a provider's answer, a stack) is only logged
const SOMETHING_WENT_WRONG =
  'Something went wrong while clipping this video, the clipping minutes were given back.';

@Injectable()
export class ClippingService {
  private storage = UploadFactory.createStorage();
  private ingest = UploadFactory.createIngestProcessor();
  private clipper = UploadFactory.createClipProcessor();

  constructor(
    private _clippingRepository: ClippingRepository,
    private _aiChargingService: AiChargingService,
    private _creditsService: CreditsService,
    private _integrationService: IntegrationService,
    private _postsService: PostsService,
    private _mediaService: MediaService,
    private _openAi: OpenaiService,
    private _deepgram: DeepgramService,
    private _temporalService: TemporalService
  ) {}

  // Every intermediate file is a flat key, because removeFile only keeps the
  // last part of a path
  private keys(clippingId: string) {
    return {
      transcript: `clipping-${clippingId}-transcript.json`,
      audio: `clipping-${clippingId}-audio.ogg`,
    };
  }

  private clipKeys(clipId: string) {
    return {
      source: `clip-${clipId}-source.mp4`,
      words: `clip-${clipId}-words.json`,
      output: `clip-${clipId}.mp4`,
      thumbnail: `clip-${clipId}.jpg`,
    };
  }

  private putJson(key: string, value: unknown) {
    return this.storage.writeFile!(
      key,
      JSON.stringify(value),
      'application/json'
    );
  }

  private async getJson<T>(key: string): Promise<T> {
    return JSON.parse(await this.storage.readFile!(key));
  }

  private async removeFiles(keys: string[]) {
    for (const key of keys) {
      try {
        await this.storage.removeFile(key);
      } catch (err) {
        console.error(`Could not remove clipping file ${key}:`, err);
      }
    }
  }

  private failureMessage(failure?: ProcessorFailure | null) {
    switch (failure?.code) {
      case 'SOURCE_UNAVAILABLE':
        return 'This video is private, removed, or restricted by age or region, so it cannot be clipped.';
      case 'UNSUPPORTED_INPUT':
        return 'This link is not a video that can be clipped. Live streams are not supported.';
      default:
        // the message and the stderr tail can carry presigned urls, which are
        // as good as a key to the file for as long as they live
        console.error(
          'Clipping job failed:',
          JSON.stringify(failure)?.replace(/https?:\/\/[^\s"'\\]+/g, '[url]')
        );
        return `The video could not be processed (${
          failure?.code || 'FAILED'
        }).`;
    }
  }

  // The media service only fetches from YouTube; anything else would cost a job
  // to be told so
  private isYoutubeUrl(url: string) {
    try {
      const { protocol, hostname } = new URL(url);
      return (
        ['http:', 'https:'].includes(protocol) &&
        /(^|\.)(youtube\.com|youtu\.be)$/i.test(hostname)
      );
    } catch (err) {
      return false;
    }
  }

  // The idempotency key of the credits held for a clipping: its id, so a retried poll holds them once.
  private creditsKey(clippingId: string) {
    return `ai:clip:${clippingId}`;
  }

  // Source minutes the workspace can still pay for (its credits and, on the free plan, what is left
  // of the monthly AI cap), at most MAX_SOURCE_MINUTES, with the numbers that decide it.
  private async clipRoom(organizationId: string) {
    const [{ available }, { unitCost, cap }] = await Promise.all([
      this._creditsService.balance(organizationId),
      this._aiChargingService.estimate(organizationId, { kind: 'clip' }),
    ]);
    const capLeft = cap ? cap.limit - cap.used : Infinity;
    const minutes =
      unitCost === 0
        ? MAX_SOURCE_MINUTES
        : Math.min(
            MAX_SOURCE_MINUTES,
            Math.floor(Math.min(available, capLeft) / unitCost)
          );
    return { minutes, unitCost, available, cap };
  }

  private isStale(clipping: { status: string; createdAt: Date }) {
    return (
      !['completed', 'failed'].includes(clipping.status) &&
      dayjs(clipping.createdAt).isBefore(dayjs().subtract(STALE_HOURS, 'hour'))
    );
  }

  async startClipping(org: Organization, body: ClippingDto) {
    if (
      !this.ingest ||
      !this.clipper ||
      !this.storage.signDownloadUrl ||
      !this.storage.signUploadUrl
    ) {
      throw new HttpException('Clipping is not available', 503);
    }

    if (!this.isYoutubeUrl(body.url)) {
      throw new HttpException('Only YouTube videos can be clipped', 400);
    }

    // Refused with 402 before anything is started when not even one source minute can be paid for
    const room = await this.clipRoom(org.id);
    if (room.minutes <= 0) {
      if (room.cap && room.cap.limit - room.cap.used < room.unitCost) {
        throw new AiCapReachedException(room.cap.limit, room.cap.used);
      }
      throw new InsufficientCreditsException(room.unitCost, room.available);
    }

    const integrations = body.integrations || [];
    for (const integration of integrations) {
      if (
        !(await this._integrationService.getIntegrationById(
          org.id,
          integration
        ))
      ) {
        throw new HttpException(`Channel ${integration} not found`, 400);
      }
    }

    const client = this._temporalService.client.getRawClient();
    if (!client) {
      throw new HttpException('Clipping is not available', 503);
    }

    // two starts at the same moment would both see nothing running
    if (!(await ioRedis.set(`clippingStart:${org.id}`, '1', 'EX', 15, 'NX'))) {
      throw new HttpException('Another clipping is being started', 429);
    }

    try {
      return await this.createClipping(org.id, body, integrations, client);
    } finally {
      await ioRedis.del(`clippingStart:${org.id}`);
    }
  }

  private async createClipping(
    org: string,
    body: ClippingDto,
    integrations: string[],
    client: NonNullable<ReturnType<TemporalService['client']['getRawClient']>>
  ) {
    const running = await this._clippingRepository.getRunningClippings(org);
    for (const clipping of running.filter((p) => this.isStale(p))) {
      await this.failClipping(clipping.id, 'The clipping never finished', true);
    }

    if (running.filter((p) => !this.isStale(p)).length >= MAX_RUNNING) {
      throw new HttpException(
        'A clipping is already running, wait for it to finish',
        429
      );
    }

    if (
      (await this._clippingRepository.countClippingsSince(
        org,
        dayjs().subtract(1, 'day').toDate()
      )) >= MAX_STARTS_PER_DAY
    ) {
      throw new HttpException(
        'Too many clippings were started today, try again tomorrow',
        429
      );
    }

    const clipping = await this._clippingRepository.createClipping(
      org,
      body.url,
      body.clips || 5,
      body.fit || 'blur',
      integrations
    );

    try {
      await client.workflow.start('clippingWorkflow', {
        workflowId: `clipping_${clipping.id}`,
        taskQueue: 'main',
        args: [{ clippingId: clipping.id }],
        typedSearchAttributes: new TypedSearchAttributes([
          {
            key: organizationId,
            value: org,
          },
        ]),
      });
    } catch (err) {
      // no workflow means nothing will ever flip the status
      await this._clippingRepository.updateClipping(org, clipping.id, {
        status: 'failed',
        error: 'Could not start clipping',
      });
      throw new HttpException('Clipping is not available', 503);
    }

    return { id: clipping.id };
  }

  async getClipping(org: string, id: string) {
    const clipping = await this._clippingRepository.getClipping(org, id);
    if (!clipping) {
      throw new HttpException('Clipping not found', 404);
    }

    if (this.isStale(clipping)) {
      await this.failClipping(id, 'The clipping never finished', true);
      return (await this._clippingRepository.getClipping(org, id))!;
    }

    return clipping;
  }

  // A chat client can't wait between two status calls, so the waiting happens
  // here: the answer is held until something changed (the step, a finished
  // clip) or the time is up. It stays far below the 100 seconds a proxy in
  // front of the MCP allows a request
  async waitForClipping(org: string, id: string, seconds: number) {
    const progress = (clipping: Awaited<ReturnType<typeof this.getClipping>>) =>
      clipping.status +
      clipping.clips.filter((clip) => clip.status !== 'pending').length;

    const first = await this.getClipping(org, id);
    let current = first;
    for (
      let waited = 0;
      waited < seconds &&
      !['completed', 'failed'].includes(current.status) &&
      progress(current) === progress(first);
      waited += 3
    ) {
      await timer(3000);
      current = await this.getClipping(org, id);
    }

    return current;
  }

  // The MCP widget runs in the host's sandboxed iframe (a foreign origin without
  // our cookies), so it reads the status with a short-lived ticket that only
  // opens this one clipping
  async createWidgetTicket(org: string, id: string) {
    await this.getClipping(org, id);
    const ticket = randomBytes(32).toString('hex');
    await ioRedis.set(
      `clippingTicket:${ticket}`,
      JSON.stringify({ org, id }),
      'EX',
      600
    );
    return ticket;
  }

  // What the widget polls. Several widgets can watch one clipping (a reopened
  // conversation mounts a new one), and each would tell the conversation that
  // the clips are ready: "report" is true for exactly one of them, and only for
  // one that saw the clipping running
  async getWidgetProgress(org: string, id: string, sawRunning: boolean) {
    const clipping = await this._clippingRepository.getClippingProgress(
      org,
      id
    );
    if (!clipping) {
      throw new HttpException('Clipping not found', 404);
    }

    const report =
      sawRunning &&
      ['completed', 'failed'].includes(clipping.status) &&
      !!(await ioRedis.set(
        `clippingReported:${id}`,
        '1',
        'EX',
        24 * 3600,
        'NX'
      ));

    return { ...clipping, report };
  }

  async getWidgetTicket(ticket: string) {
    return JSON.parse(
      (await ioRedis.get(`clippingTicket:${ticket}`)) || 'null'
    ) as { org: string; id: string } | null;
  }

  getClippings(org: string, page: number) {
    return this._clippingRepository.getClippings(org, page);
  }

  // One job for the whole video: the captions when the video has them, the
  // audio only when it does not, so most videos are analysed without a download.
  // The remaining minutes are the duration limit, so a video that does not fit
  // is refused before anything is paid for
  async submitAnalyse(clippingId: string) {
    const clipping = await this._clippingRepository.getClippingById(clippingId);
    if (!clipping) {
      throw new ClippingStop('Clipping not found');
    }

    const { minutes } = await this.clipRoom(clipping.organizationId);
    if (minutes <= 0) {
      throw new ClippingStop(
        'There are not enough credits left on this account to clip a video.'
      );
    }

    // the first answer had no captions that can be trusted (see checkAnalyse),
    // so this time only the audio is asked for
    const audioOnly = clipping.status === 'transcribing';
    const keys = this.keys(clippingId);
    return this.ingest!.submit({
      version: 1,
      type: 'ingest',
      reference: clippingId,
      source: { url: clipping.url, via: 'oxylabs' },
      ...(audioOnly
        ? {}
        : {
            transcript: {
              url: await this.storage.signUploadUrl!(
                keys.transcript,
                'application/json'
              ),
              languages: ['en'],
            },
          }),
      audio: {
        url: await this.storage.signUploadUrl!(keys.audio, 'audio/ogg'),
        unless_transcript: !audioOnly,
      },
      limits: { max_duration_seconds: minutes * 60 },
    });
  }

  // A video that can't be analysed stops the whole clipping, so this throws
  // where the clip polls answer "failed". The minutes are charged here, as soon
  // as the real duration is known and before any media is paid for;
  // "transcribe" says the video had no captions and only the audio was stored
  async checkAnalyse(
    clippingId: string,
    jobId: string
  ): Promise<{ state: ClippingJobState; transcribe?: boolean }> {
    const clipping = await this._clippingRepository.getClippingById(clippingId);
    if (!clipping) {
      throw new ClippingStop('Clipping not found');
    }

    const job = await this.ingest!.status(jobId);
    if (job.status === 'pending') {
      return { state: 'pending' };
    }

    if (job.status === 'failed') {
      return { state: 'retry' };
    }

    const { result } = job;
    if (result?.status === 'failed') {
      if (result.failure?.retryable) {
        return { state: 'retry' };
      }

      if (result.failure?.code === 'DURATION_TOO_LONG') {
        throw new ClippingStop(
          `This video is ${Math.ceil(
            (result.source?.duration_seconds || 0) / 60
          )} minutes long. It has to fit the credits left on this account, and ${MAX_SOURCE_MINUTES} minutes at most.`
        );
      }

      throw new ClippingStop(this.failureMessage(result.failure));
    }

    const duration = result?.source?.duration_seconds;
    if (result?.status !== 'completed' || !duration) {
      console.error('Unexpected analyse result:', JSON.stringify(result));
      throw new ClippingStop(SOMETHING_WENT_WRONG);
    }

    if (!result.transcript && !result.audio) {
      throw new ClippingStop('This video has no captions and no audio.');
    }

    // Only YouTube's own captions are in the language that is spoken. An
    // uploaded track can be a translation (English subtitles on a Spanish talk)
    // and nothing in the answer tells the two apart, so the job is submitted
    // again for the audio and the transcriber finds the language itself
    if (result.transcript && result.transcript.origin !== 'auto_generated') {
      await this._clippingRepository.updateClipping(
        clipping.organizationId,
        clippingId,
        { status: 'transcribing' }
      );
      return { state: 'retry' };
    }

    // The credits are held as soon as the real duration is known and before any media is paid for;
    // the clipping id is the key, so a retried poll holds them once, and two clippings racing each
    // other are both counted under the account lock before either is let through
    const minutes = Math.ceil(duration / 60);
    let credits: string;
    try {
      credits = (
        await this._aiChargingService.reserve({
          organizationId: clipping.organizationId,
          kind: 'clip',
          quantity: minutes,
          idempotencyKey: this.creditsKey(clippingId),
          metadata: { route: 'clipping' },
        })
      ).id;
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 402) {
        throw new ClippingStop(
          `This video is ${minutes} minutes long. ${err.message}`
        );
      }
      throw err;
    }

    await this._clippingRepository.updateClipping(
      clipping.organizationId,
      clippingId,
      {
        title: result.source?.title || clipping.url,
        ...(result.source?.thumbnail_url
          ? { thumbnail: result.source.thumbnail_url }
          : {}),
        // rounded up, the window of the last clip must reach the real end
        duration: Math.ceil(duration),
        creditsId: credits,
      }
    );

    return { state: 'done', transcribe: !result.transcript };
  }

  // The video has no captions: the transcriber fetches the audio itself and the
  // answer is stored in the shape of the captions file
  async transcribe(clippingId: string) {
    const clipping = await this._clippingRepository.getClippingById(clippingId);
    if (!clipping) {
      throw new ClippingStop('Clipping not found');
    }

    await this._clippingRepository.updateClipping(
      clipping.organizationId,
      clippingId,
      { status: 'transcribing' }
    );

    const keys = this.keys(clippingId);
    const transcript = await this._deepgram.transcribeUrl(
      await this.storage.signDownloadUrl!(keys.audio)
    );
    await this.putJson(keys.transcript, transcript);
  }

  // Returns the ids of the clips to render. A retry after the clips were
  // stored returns the same ones instead of asking the model again
  async pickClips(clippingId: string) {
    const clipping = await this._clippingRepository.getClippingById(clippingId);
    if (!clipping) {
      throw new ClippingStop('Clipping not found');
    }

    if (clipping.clips.length) {
      return clipping.clips.map((clip) => clip.id);
    }

    await this._clippingRepository.updateClipping(
      clipping.organizationId,
      clippingId,
      { status: 'picking' }
    );

    const { segments, language } = await this.getJson<ClippingTranscript>(
      this.keys(clippingId).transcript
    );
    if (!segments?.length) {
      throw new ClippingStop('No speech was found in this video.');
    }

    const picked = await this._openAi.pickClips(
      clipping.title || '',
      language,
      segments,
      clipping.maxClips
    );

    const clips = picked
      .filter(
        (clip) =>
          Number.isInteger(clip.from) &&
          Number.isInteger(clip.to) &&
          clip.from >= 0 &&
          clip.to < segments.length &&
          clip.from <= clip.to
      )
      // the model does not always keep to the length it was given: a clip that
      // runs over ends on the last line that still fits instead of being lost
      .map((clip) => {
        let to = clip.to;
        while (
          to > clip.from &&
          segments[to].end - segments[clip.from].start > MAX_CLIP_SECONDS
        ) {
          to--;
        }

        return {
          title: clip.title,
          content: clip.content,
          start: segments[clip.from].start,
          end: segments[to].end,
        };
      })
      .filter(
        (clip) =>
          clip.end - clip.start >= MIN_CLIP_SECONDS &&
          clip.end - clip.start <= MAX_CLIP_SECONDS
      )
      .reduce(
        (all, clip) =>
          all.some((p) => clip.start < p.end && p.start < clip.end)
            ? all
            : [...all, clip],
        [] as { title: string; content: string; start: number; end: number }[]
      )
      .slice(0, clipping.maxClips);

    if (!clips.length) {
      throw new ClippingStop('No part of this video works as a short clip.');
    }

    const created = await this._clippingRepository.createClips(
      clippingId,
      clips
    );
    await this._clippingRepository.updateClipping(
      clipping.organizationId,
      clippingId,
      { status: 'rendering' }
    );

    return created.map((clip) => clip.id);
  }

  // Only the window of the clip is downloaded, never the whole video
  async submitClipFetch(clipId: string) {
    const clip = await this._clippingRepository.getClipById(clipId);
    if (!clip) {
      throw new ClippingStop('Clip not found');
    }

    const end = Math.ceil(clip.end) + WINDOW_PADDING;
    return this.ingest!.submit({
      version: 1,
      type: 'ingest',
      reference: clipId,
      source: {
        url: clip.clipping.url,
        via: 'oxylabs',
        // a crop keeps about a third of the width, so it needs the taller rendition to
        // stay sharp; the whole picture scaled down does not
        max_height: clip.clipping.fit === 'crop' ? 1080 : 720,
        start_seconds: Math.max(0, Math.floor(clip.start) - WINDOW_PADDING),
        end_seconds: clip.clipping.duration
          ? Math.min(clip.clipping.duration, end)
          : end,
      },
      video: {
        url: await this.storage.signUploadUrl!(
          this.clipKeys(clipId).source,
          'video/mp4'
        ),
      },
    });
  }

  // A clip that can't be fetched is recorded as failed and never throws, the
  // other clips of the video go on
  async checkClipFetch(
    clipId: string,
    jobId: string
  ): Promise<{ state: ClippingJobState }> {
    const clip = await this._clippingRepository.getClipById(clipId);
    if (!clip) {
      return { state: 'failed' };
    }

    const job = await this.ingest!.status(jobId);
    if (job.status === 'pending') {
      return { state: 'pending' };
    }

    if (job.status === 'failed') {
      return { state: 'retry' };
    }

    const { result } = job;
    if (result?.status === 'failed' && result.failure?.retryable) {
      return { state: 'retry' };
    }

    if (result?.status !== 'completed' || !result.video) {
      if (!result?.failure) {
        console.error('Unexpected fetch result:', JSON.stringify(result));
      }
      await this.failClip(
        clipId,
        result?.failure
          ? this.failureMessage(result.failure)
          : 'The clip could not be downloaded',
        true
      );
      return { state: 'failed' };
    }

    // every time of the fetched file is relative to the start of the window
    await this._clippingRepository.updateClip(clipId, {
      trimStart:
        result.source?.trim?.start_seconds ??
        Math.max(0, Math.floor(clip.start) - WINDOW_PADDING),
    });
    return { state: 'done' };
  }

  // The words of the captions on the timeline of the fetched window. Captions
  // that only time whole lines can't highlight words, so the short window is
  // transcribed instead
  async captionClip(clipId: string) {
    const clip = await this._clippingRepository.getClipById(clipId);
    if (!clip) {
      throw new ClippingStop('Clip not found');
    }

    const keys = this.clipKeys(clipId);
    const trimStart = clip.trimStart || 0;
    const transcript = await this.getJson<ClippingTranscript>(
      this.keys(clip.clippingId).transcript
    );

    const words: ClippingWord[] = transcript.word_level
      ? transcript.words
          .filter((word) => word.end > clip.start && word.start < clip.end)
          .map((word) => ({
            text: word.text,
            start: Math.max(0, word.start - trimStart),
            end: Math.max(0, word.end - trimStart),
          }))
      : (
          await this._deepgram.transcribeUrl(
            await this.storage.signDownloadUrl!(keys.source)
          )
        ).words;

    await this.putJson(keys.words, words);
  }

  async submitClipRender(clipId: string) {
    const clip = await this._clippingRepository.getClipById(clipId);
    if (!clip) {
      throw new ClippingStop('Clip not found');
    }

    const keys = this.clipKeys(clipId);
    const trimStart = clip.trimStart || 0;
    const words = await this.getJson<ClippingWord[]>(keys.words);

    return this.clipper!.submit({
      version: 1,
      type: 'clip',
      reference: clipId,
      source: { url: await this.storage.signDownloadUrl!(keys.source) },
      clips: [
        {
          reference: clipId,
          start_seconds: Math.max(0, clip.start - trimStart),
          end_seconds: clip.end - trimStart,
          output: {
            url: await this.storage.signUploadUrl!(keys.output, 'video/mp4'),
          },
          thumbnail: {
            url: await this.storage.signUploadUrl!(
              keys.thumbnail,
              'image/jpeg'
            ),
            timestamp_seconds: 0,
          },
        },
      ],
      // without face tracking a centre crop can cut the speaker out, the whole
      // picture over a blurred copy of itself never does, so blur is the default
      frame: {
        width: 1080,
        height: 1920,
        fit: clip.clipping.fit === 'crop' ? 'crop' : 'blur',
      },
      ...(words.length ? { captions: { words } } : {}),
    });
  }

  async checkClipRender(
    clipId: string,
    jobId: string
  ): Promise<{ state: ClippingJobState }> {
    const clip = await this._clippingRepository.getClipById(clipId);
    if (!clip) {
      return { state: 'failed' };
    }

    // a retried poll after the media was saved must not save it twice
    if (clip.status === 'completed') {
      return { state: 'done' };
    }

    const job = await this.clipper!.status(jobId);
    if (job.status === 'pending') {
      return { state: 'pending' };
    }

    if (job.status === 'failed') {
      return { state: 'retry' };
    }

    const rendered = job.result?.clips?.[0];
    const failure = rendered?.failure || job.result?.failure;
    if (rendered?.status !== 'completed' && failure?.retryable) {
      return { state: 'retry' };
    }

    if (rendered?.status !== 'completed') {
      if (!failure) {
        console.error('Unexpected render result:', JSON.stringify(job.result));
      }
      await this.failClip(
        clipId,
        failure
          ? this.failureMessage(failure)
          : 'The clip could not be rendered',
        true
      );
      return { state: 'failed' };
    }

    const keys = this.clipKeys(clipId);
    const org = clip.clipping.organizationId;
    const path = this.storage.publicUrl!(keys.output);
    const thumbnail = rendered.thumbnail
      ? this.storage.publicUrl!(keys.thumbnail)
      : undefined;

    // the media id is stored before anything else can fail, so a retried poll
    // finishes the same media instead of saving the file a second time
    const mediaId =
      clip.mediaId ||
      (
        await this._mediaService.saveFile(
          org,
          keys.output,
          path,
          `${clip.title}.mp4`
        )
      ).id;
    if (!clip.mediaId) {
      await this._clippingRepository.updateClip(clipId, { mediaId });
    }

    if (thumbnail) {
      await this._mediaService.saveMediaInformation(org, {
        id: mediaId,
        alt: clip.title,
        thumbnail,
        thumbnailTimestamp: 0,
      });
    }

    await this._clippingRepository.updateClip(clipId, {
      status: 'completed',
      error: null,
      path,
      ...(thumbnail ? { thumbnail } : {}),
    });

    await this.removeFiles([keys.source, keys.words]);
    return { state: 'done' };
  }

  // "customer" says the reason was written for the customer; anything else (a
  // provider's answer, a timeout, a stack) is logged and replaced
  async failClip(clipId: string, error: string, customer = false) {
    const clip = await this._clippingRepository.getClipById(clipId);
    // the first reason is the specific one (what the media service answered)
    if (!clip || clip.status !== 'pending') {
      return;
    }

    if (!customer) {
      console.error(`Clip ${clipId} failed:`, error);
    }

    await this.removeFiles(Object.values(this.clipKeys(clipId)));
    return this._clippingRepository.updateClip(clipId, {
      status: 'failed',
      error: customer ? error.slice(0, 4000) : 'The clip could not be rendered',
    });
  }

  // A clip that did not make it can still have files behind it: its workflow
  // died before failClip, or the render uploaded and the media was never saved
  private async removeUnfinishedClipFiles(
    clips: { id: string; status: string }[]
  ) {
    for (const clip of clips.filter((p) => p.status !== 'completed')) {
      await this.removeFiles(Object.values(this.clipKeys(clip.id)));
    }
  }

  // Every rendered clip becomes a draft on the next free slots of the chosen
  // channels; nothing is scheduled without the customer looking at it
  async createDrafts(clippingId: string) {
    const clipping = await this._clippingRepository.getClippingById(clippingId);
    if (!clipping) {
      return;
    }

    const integrations = (
      await Promise.all(
        (JSON.parse(clipping.integrations) as string[]).map((id) =>
          this._integrationService.getIntegrationById(
            clipping.organizationId,
            id
          )
        )
      )
    ).filter((f) => f && !f.deletedAt && !f.disabled);

    if (!integrations.length) {
      return;
    }

    for (const clip of clipping.clips) {
      if (clip.status !== 'completed' || clip.draftedAt || !clip.path) {
        continue;
      }

      const nextTime = await this._postsService.findFreeDateTime(
        clipping.organizationId
      );

      // Claimed before any draft exists and never given back: a retry, or an
      // attempt that timed out and is still running, skips the clip. Giving the
      // claim back after a failure would draft again the channels that already
      // got theirs, and a missing draft costs less than a double one: the clip
      // is in the media library either way
      if (!(await this._clippingRepository.claimClipDraft(clip.id))) {
        continue;
      }

      // one channel at a time, so a channel that fails does not take the rest along
      for (const integration of integrations) {
        try {
          await this._postsService.createPost(
            clipping.organizationId,
            {
              date: nextTime + 'Z',
              order: makeId(10),
              shortLink: false,
              type: 'draft',
              tags: [],
              posts: [
                {
                  settings: {
                    __type: integration!.providerIdentifier as any,
                  },
                  group: makeId(10),
                  integration: { id: integration!.id },
                  value: [
                    {
                      id: makeId(10),
                      delay: 0,
                      content: clip.content,
                      image: [
                        {
                          id: clip.mediaId || makeId(10),
                          path: clip.path!,
                          ...(clip.thumbnail
                            ? { thumbnail: clip.thumbnail }
                            : {}),
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            'UNKNOWN'
          );
        } catch (err) {
          console.error(
            `Could not draft clip ${clip.id} on channel ${integration!.id}:`,
            err
          );
        }
      }
    }
  }

  async finishClipping(clippingId: string) {
    const clipping = await this._clippingRepository.getClippingById(clippingId);
    if (!clipping) {
      return;
    }

    if (!clipping.clips.some((clip) => clip.status === 'completed')) {
      return this.failClipping(clippingId, 'No clip could be rendered', true);
    }

    await this._clippingRepository.failUnfinishedClips(
      clippingId,
      'The clip could not be rendered'
    );

    const keys = this.keys(clippingId);
    await this.removeFiles([keys.transcript, keys.audio]);
    await this.removeUnfinishedClipFiles(clipping.clips);
    // A clip was rendered: the customer got what the credits were held for
    await this._aiChargingService.finish(
      this.creditsKey(clippingId),
      { ok: true },
      clipping.organizationId
    );
    return this._clippingRepository.updateClipping(
      clipping.organizationId,
      clippingId,
      { status: 'completed', error: null }
    );
  }

  // The minutes are given back only when the customer got nothing for them
  async failClipping(clippingId: string, error: string, customer = false) {
    const clipping = await this._clippingRepository.getClippingById(clippingId);
    if (!clipping) {
      return;
    }

    if (!customer) {
      console.error(`Clipping ${clippingId} failed:`, error);
    }

    const keys = this.keys(clippingId);
    await this.removeFiles([keys.transcript, keys.audio]);
    await this.removeUnfinishedClipFiles(clipping.clips);

    await this._clippingRepository.failUnfinishedClips(
      clippingId,
      'The clip could not be rendered'
    );

    const rendered = clipping.clips.some((clip) => clip.status === 'completed');
    // the credits are held under the id of the clipping, so they are found even when the
    // poll that held them died before it could store creditsId; a clip was rendered: the
    // customer got what they were held for, none was: they are given back
    await this._aiChargingService.finish(
      this.creditsKey(clippingId),
      rendered ? { ok: true } : { ok: false },
      clipping.organizationId
    );

    return this._clippingRepository.updateClipping(
      clipping.organizationId,
      clippingId,
      {
        status: rendered ? 'completed' : 'failed',
        error: customer
          ? error.slice(0, 4000)
          : rendered
          ? 'Something went wrong after the clips were made.'
          : SOMETHING_WENT_WRONG,
        ...(rendered ? {} : { creditsId: null }),
      }
    );
  }
}
