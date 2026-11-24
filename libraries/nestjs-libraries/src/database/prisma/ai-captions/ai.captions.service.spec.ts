// ai.video-captions (AC6): the caption job service. Needs no network, no database and no Temporal: the storage of
// the jobs is an in-memory stand-in, and the credits, the channels, the transcriber, the writer of the captions and
// the workflow engine are stubs. Covers create (what is reserved and when, the minutes read from the audio and not
// from the request, a repeat, SKIPPED, the refusals, a start that fails), the three steps of the workflow and its
// failure path (credits committed or given back exactly once, the audio deleted on every ending), the targets the
// writer gets, what the phone reads and what the web page reads (the list, the detail with the posts made, delete).
import { ApplicationFailure } from '@temporalio/common';
import { HttpException } from '@nestjs/common';
import { AiCaptionsService } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service';
import { MuseTranscribeError } from '@gitroom/nestjs-libraries/muse/muse.transcription.service';
import { AiCaptionsNotConfigured } from '@gitroom/nestjs-libraries/muse/transcription.provider';
import { organizationId as organizationKey } from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';

const mockDeleteObject = jest.fn();

jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  R2: { send: jest.fn() },
  R2_BUCKET: 'test-bucket',
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.repository',
  () => ({ AiCaptionsRepository: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.generator',
  () => ({ AiCaptionsGenerator: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service',
  () => ({ AiChargingService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/credits/credits.service',
  () => ({ CreditsService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.service',
  () => ({ PublishChargingService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));

const ORG = 'org-1';
const USER = 'user-1';
const AUDIO = 'audio-1';
const AUDIO_KEY = 'audio-1.wav';

// What one minute of captions costs, and what publishing to one channel costs.
const PRICE = 1;
const PUBLISH = 3;

// Twenty spoken words, and fewer than MIN_SPOKEN_WORDS.
const SPEECH = Array.from({ length: 20 }, () => 'hello').join(' ');
const SHORT = 'just two';

const row = (id: string, providerIdentifier: string, extra = {}) => ({
  id,
  providerIdentifier,
  name: id,
  picture: `${id}.png`,
  additionalSettings: '[]',
  ...extra,
});

// Two X channels (one with a longer limit), YouTube and a channel whose provider takes no video.
const INTEGRATIONS = [
  row('int-x1', 'x'),
  row('int-x2', 'x', {
    additionalSettings: JSON.stringify([{ title: 'Premium', value: true }]),
  }),
  row('int-yt', 'youtube'),
  row('int-gmb', 'gmb'),
];

const PROVIDERS: Record<string, any> = {
  x: { name: 'X', maxLength: (extra: unknown[]) => (extra.length ? 4000 : 280) },
  youtube: { name: 'YouTube', maxLength: () => 5000 },
  gmb: { name: 'Google Business', maxLength: () => 1500, acceptsVideo: false },
};

// A text as the writer returns it.
const written = (identifier: string, kind: 'video' | 'text', extra = {}) => ({
  identifier,
  kind,
  text: `${identifier} ${kind} text`,
  html: `<p>${identifier} ${kind} text</p>`,
  hashtags: ['tag'],
  promptKey: `captions.${kind}.${identifier}`,
  promptVersion: 1,
  promptSource: 'default',
  model: 'gpt-5-nano',
  ...extra,
});

// The storage of the jobs, in memory, with the behaviour the service relies on (a unique audio upload, a deleted
// caption hidden from reads, outputs replaced in one go, `updatedAt` moving with every write to a caption).
class FakeRepository {
  captions: any[] = [];
  outputs: any[] = [];
  uploads: any[] = [
    {
      id: AUDIO,
      organizationId: ORG,
      objectKey: AUDIO_KEY,
      status: 'completed',
      purpose: 'transcript_audio',
    },
  ];
  private count = 0;

  audioUpload = async (organizationId: string, id: string) =>
    this.uploads.find((u) => u.id === id && u.organizationId === organizationId) ||
    null;

  findByAudioUpload = async (organizationId: string, audioUploadId: string) =>
    this.captions.find(
      (c) => c.organizationId === organizationId && c.audioUploadId === audioUploadId
    ) || null;

  createCaption = async (data: any) => {
    if (this.captions.some((c) => c.audioUploadId === data.audioUploadId)) {
      return null;
    }
    const caption = {
      id: `cap-${++this.count}`,
      status: 'PENDING',
      error: null,
      transcript: null,
      segments: null,
      language: null,
      deletedAt: null,
      creditState: 'SETTLED',
      createdAt: new Date('2026-10-21T10:00:00Z'),
      updatedAt: new Date(),
      title: null,
      userText: null,
      userId: null,
      ...data,
    };
    this.captions.push(caption);
    return caption;
  };

  getCaptionById = async (id: string) =>
    this.captions.find((c) => c.id === id) || null;

  getCaption = async (organizationId: string, id: string) => {
    const caption = this.captions.find(
      (c) => c.id === id && c.organizationId === organizationId && !c.deletedAt
    );
    return caption
      ? { ...caption, outputs: this.outputs.filter((o) => o.captionId === id) }
      : null;
  };

  listCaptions = async (organizationId: string) => ({
    items: this.captions.filter(
      (c) => c.organizationId === organizationId && !c.deletedAt
    ),
    pages: 1,
  });

  updateCaption = async (_organizationId: string, id: string, data: any) =>
    Object.assign(this.captions.find((c) => c.id === id), data, {
      updatedAt: new Date(),
    });

  saveTranscript = async (_organizationId: string, id: string, data: any) => {
    const caption = this.captions.find((c) => c.id === id && !c.deletedAt);
    if (caption) {
      Object.assign(caption, data, { updatedAt: new Date() });
    }
    return !!caption;
  };

  // The guarded write: only a job still in progress that has not changed since `before` is ended.
  closeStale = async (
    organizationId: string,
    id: string,
    before: Date,
    data: any
  ) => {
    const caption = this.captions.find(
      (c) =>
        c.id === id &&
        c.organizationId === organizationId &&
        !['READY', 'NO_SPEECH', 'FAILED'].includes(c.status) &&
        c.updatedAt < before
    );
    if (caption) {
      Object.assign(caption, data, { updatedAt: new Date() });
    }
    return !!caption;
  };

  deleteCaption = async (organizationId: string, id: string) => {
    this.captions = this.captions.filter(
      (c) => !(c.id === id && c.organizationId === organizationId)
    );
  };

  softDeleteCaption = async (organizationId: string, id: string) => {
    const caption = this.captions.find(
      (c) => c.id === id && c.organizationId === organizationId && !c.deletedAt
    );
    if (caption) {
      Object.assign(caption, { deletedAt: new Date(), transcript: null });
    }
    return !!caption;
  };

  replaceOutputs = async (captionId: string, outputs: any[]) => {
    this.outputs = [
      ...this.outputs.filter((o) => o.captionId !== captionId),
      ...outputs.map((o) => ({ ...o, captionId })),
    ];
  };

  countOutputs = async (captionId: string) =>
    this.outputs.filter((o) => o.captionId === captionId).length;

  // The posts of every workspace; a live one of the workspace is what the page can read
  posts: any[] = [];

  postStates = jest.fn(async (organizationId: string, ids: string[]) =>
    this.posts
      .filter((p) => p.organizationId === organizationId && ids.includes(p.id) && !p.deletedAt)
      .map(({ id, state, publishDate }) => ({ id, state, publishDate }))
  );
}

// The service over stand-ins. `seconds` is what the audio's header says; `available` the credits to spend.
const build = (options: { seconds?: number; available?: number } = {}) => {
  const repo = new FakeRepository();
  const charging = {
    reserve: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    finish: jest.fn().mockResolvedValue(undefined),
    estimate: jest.fn(async (_org: string, request: { quantity: number }) => ({
      amount: request.quantity * PRICE,
    })),
  };
  const credits = {
    balance: jest
      .fn()
      .mockResolvedValue({ available: options.available ?? 1000, reserved: 0 }),
  };
  const publish = {
    preview: jest.fn(async (_org: string, request: { integrationIds: string[] }) => ({
      amount: request.integrationIds.length * PUBLISH,
    })),
  };
  const integrations = {
    getIntegrationsList: jest.fn().mockResolvedValue(INTEGRATIONS),
  };
  const manager = {
    getSocialIntegration: jest.fn((identifier: string) => PROVIDERS[identifier]),
  };
  const transcription = {
    isConfigured: jest.fn().mockReturnValue(true),
    audioSeconds: jest.fn().mockResolvedValue(options.seconds ?? 150),
    transcribe: jest.fn().mockResolvedValue({
      text: SPEECH,
      segments: [{ startMs: 0, endMs: 5000, text: SPEECH }],
      seconds: options.seconds ?? 150,
    }),
  };
  const generator = {
    generate: jest
      .fn()
      .mockResolvedValue([
        written('x', 'video'),
        written('youtube', 'video', { title: 'A title' }),
        written('gmb', 'text'),
      ]),
  };
  const start = jest.fn().mockResolvedValue({});
  const temporal = { client: { getRawClient: () => ({ workflow: { start } }) } };
  const service = new AiCaptionsService(
    repo as any,
    charging as any,
    credits as any,
    publish as any,
    integrations as any,
    manager as any,
    transcription as any,
    generator as any,
    temporal as any
  );
  return {
    service,
    repo,
    charging,
    credits,
    publish,
    integrations,
    transcription,
    generator,
    start,
  };
};

type Harness = ReturnType<typeof build>;

const IDS = ['int-yt', 'int-x1'];

// A create for the audio, with the channels the controller would have worked out.
const create = (
  h: Harness,
  body: Record<string, unknown> = {},
  ids: string[] = IDS
) =>
  h.service.create(
    ORG,
    USER,
    { audioUploadId: AUDIO, mode: 'auto', ...body } as any,
    ids
  );

// The three steps of the workflow, in order, as it runs them.
const runJob = async (h: Harness, captionId: string) => {
  await h.service.transcribeCaption(captionId);
  const { noSpeech } = await h.service.generateCaption(captionId);
  if (!noSpeech) {
    await h.service.finishCaption(captionId);
  }
};

// The error a call rejects with, or undefined when it resolves.
const failure = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (err) {
    return err as any;
  }
  return undefined;
};

// The stable code of an HttpException of the caption routes.
const codeOf = (err?: HttpException) => (err?.getResponse() as any)?.code;

describe('ai.video-captions: AiCaptionsService', () => {
  const savedOpenAiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
    mockDeleteObject.mockReset();
    mockDeleteObject.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (savedOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = savedOpenAiKey;
    }
  });

  describe('create', () => {
    it('holds the credits once at the whole minutes and starts the workflow', async () => {
      const h = build({ seconds: 150 });

      const created = await create(h);

      expect(created).toEqual({
        id: 'cap-1',
        status: 'PENDING',
        cost: 2 * PRICE,
        minutes: 2,
      });
      expect(h.charging.reserve).toHaveBeenCalledTimes(1);
      expect(h.charging.reserve).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          userId: USER,
          kind: 'captions',
          quantity: 2,
          idempotencyKey: 'ai:captions:cap-1',
        })
      );
      expect(h.start).toHaveBeenCalledTimes(1);
      const [name, options] = h.start.mock.calls[0];
      expect(name).toBe('aiCaptionsWorkflow');
      expect(options).toMatchObject({
        workflowId: 'ai_captions_cap-1',
        taskQueue: 'main',
        args: [{ captionId: 'cap-1' }],
      });
      // the workspace id is searchable on the workflow
      expect(options.typedSearchAttributes.get(organizationKey)).toBe(ORG);
      expect(h.repo.captions[0]).toMatchObject({
        organizationId: ORG,
        audioUploadId: AUDIO,
        mode: 'auto',
        integrationIds: IDS,
        audioSeconds: 150,
      });
    });

    it('costs nothing under a minute: nothing is held and the job still starts', async () => {
      const h = build({ seconds: 59.9 });

      const created = await create(h);

      expect(created).toMatchObject({ status: 'PENDING', cost: 0, minutes: 0 });
      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.charging.estimate).not.toHaveBeenCalled();
      expect(h.start).toHaveBeenCalledTimes(1);

      // and nothing is committed when it finishes
      await runJob(h, 'cap-1');
      expect(h.repo.captions[0].status).toBe('READY');
      expect(h.charging.finish).not.toHaveBeenCalled();
    });

    it('reads the minutes from the audio, not from the request', async () => {
      const h = build({ seconds: 150 });

      await create(h, { minutes: 50, seconds: 3000, audioSeconds: 3000 });

      expect(h.transcription.audioSeconds).toHaveBeenCalledWith(AUDIO_KEY);
      expect(h.charging.reserve).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 2 })
      );
    });

    it('answers a repeat with the same caption and holds nothing again', async () => {
      const h = build({ seconds: 150 });
      const first = await create(h);
      await h.service.transcribeCaption('cap-1');

      const again = await create(h);

      expect(again).toEqual({
        id: (first as any).id,
        status: 'TRANSCRIBING',
        cost: 2 * PRICE,
        minutes: 2,
      });
      expect(h.charging.reserve).toHaveBeenCalledTimes(1);
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(h.repo.captions).toHaveLength(1);
    });

    it('answers a repeat even when the sweep has expired the audio', async () => {
      const h = build();
      await create(h);
      h.repo.uploads[0].status = 'expired';

      const again = await create(h);

      expect(again).toMatchObject({ id: 'cap-1' });
      expect(h.charging.reserve).toHaveBeenCalledTimes(1);
    });

    it('answers a repeat of a caption that ended without text with a cost of 0', async () => {
      const h = build();
      await create(h);
      await h.service.failCaption('cap-1');

      expect(await create(h)).toMatchObject({
        id: 'cap-1',
        status: 'FAILED',
        cost: 0,
      });
    });

    it("answers 404 CAPTION_NOT_FOUND for the audio of a caption that was deleted, and holds nothing again", async () => {
      const h = build();
      await create(h);
      await h.service.softDelete(ORG, 'cap-1');
      h.charging.reserve.mockClear();

      const err = await failure(create(h));

      expect(err.getStatus()).toBe(404);
      expect(codeOf(err)).toBe('CAPTION_NOT_FOUND');
      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(h.repo.captions).toHaveLength(1);
    });

    it('answers a create that lost a race to the same audio with the winner', async () => {
      const h = build();
      let looked = 0;
      // the first look finds nothing, as when the other create has not stored its row yet
      const find = h.repo.findByAudioUpload;
      h.repo.findByAudioUpload = async (org: string, id: string) =>
        looked++ === 0 ? null : find(org, id);
      await h.repo.createCaption({
        organizationId: ORG,
        audioUploadId: AUDIO,
        audioSeconds: 150,
        integrationIds: IDS,
      });

      const created = await create(h);

      expect(created).toMatchObject({ id: 'cap-1' });
      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.start).not.toHaveBeenCalled();
    });

    it('answers SKIPPED, and holds nothing, when it lost a race to a create whose credits could not be held', async () => {
      const h = build();
      // the other create stored its row first (this one's insert is refused), then removed it when its hold got 402:
      // the row is gone by the time this one looks for the winner
      h.repo.createCaption = async () => null;

      const answer = await create(h);

      expect(answer).toEqual({ status: 'SKIPPED', reason: 'CREDITS' });
      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.start).not.toHaveBeenCalled();
      expect(h.repo.captions).toHaveLength(0);
    });

    it('answers 404 when the winner of a race was deleted meanwhile', async () => {
      const h = build();
      let looked = 0;
      const find = h.repo.findByAudioUpload;
      h.repo.findByAudioUpload = async (org: string, id: string) =>
        looked++ === 0 ? null : find(org, id);
      await h.repo.createCaption({
        organizationId: ORG,
        audioUploadId: AUDIO,
        audioSeconds: 150,
        integrationIds: IDS,
      });
      await h.service.softDelete(ORG, 'cap-1');

      const err = await failure(create(h));

      expect(codeOf(err)).toBe('CAPTION_NOT_FOUND');
      expect(h.charging.reserve).not.toHaveBeenCalled();
    });

    it('answers SKIPPED and holds nothing when the captions and the publish do not both fit', async () => {
      // 2 minutes + 2 channels = 2 + 6 = 8 credits
      const fits = build({ available: 8 });
      expect(await create(fits)).toMatchObject({ status: 'PENDING' });

      const h = build({ available: 7 });
      expect(await create(h)).toEqual({ status: 'SKIPPED', reason: 'CREDITS' });
      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.start).not.toHaveBeenCalled();
      expect(h.repo.captions).toHaveLength(0);
      expect(h.publish.preview).toHaveBeenCalledWith(ORG, {
        integrationIds: IDS,
      });
    });

    it('answers SKIPPED when the credits went elsewhere before they could be held', async () => {
      const h = build();
      h.charging.reserve.mockRejectedValue(new HttpException('Insufficient', 402));

      expect(await create(h)).toEqual({ status: 'SKIPPED', reason: 'CREDITS' });
      // no caption is left behind, so the audio may ask again
      expect(h.repo.captions).toHaveLength(0);
      expect(h.start).not.toHaveBeenCalled();
    });

    it("refuses another workspace's audio and an upload that is not a caption audio with 404", async () => {
      const foreign = build();
      foreign.repo.uploads[0].organizationId = 'org-2';
      const err = await failure(create(foreign));
      expect(err.getStatus()).toBe(404);
      expect(codeOf(err)).toBe('AUDIO_NOT_FOUND');
      expect(foreign.charging.reserve).not.toHaveBeenCalled();

      const media = build();
      media.repo.uploads[0].purpose = 'media';
      expect(codeOf(await failure(create(media)))).toBe('AUDIO_NOT_FOUND');

      const missing = build();
      expect(
        codeOf(await failure(create(missing, { audioUploadId: 'nope' })))
      ).toBe('AUDIO_NOT_FOUND');
    });

    it('refuses an audio that is not complete with 409', async () => {
      const h = build();
      h.repo.uploads[0].status = 'pending';

      const err = await failure(create(h));

      expect(err.getStatus()).toBe(409);
      expect(codeOf(err)).toBe('AUDIO_NOT_COMPLETE');
      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.repo.captions).toHaveLength(0);
    });

    it('answers 503 when the transcriber or OpenAI has no key', async () => {
      const noMuse = build();
      noMuse.transcription.isConfigured.mockReturnValue(false);
      const err = await failure(create(noMuse));
      expect(err).toBeInstanceOf(AiCaptionsNotConfigured);
      expect(err.getStatus()).toBe(503);
      expect(codeOf(err)).toBe('AI_CAPTIONS_NOT_CONFIGURED');
      expect(noMuse.charging.reserve).not.toHaveBeenCalled();

      delete process.env.OPENAI_API_KEY;
      const noOpenAi = build();
      expect(codeOf(await failure(create(noOpenAi)))).toBe(
        'AI_CAPTIONS_NOT_CONFIGURED'
      );
      expect(noOpenAi.charging.reserve).not.toHaveBeenCalled();
    });

    it('refuses an audio the transcriber cannot take with 400 and no provider text', async () => {
      const h = build();
      h.transcription.audioSeconds.mockRejectedValue(
        new MuseTranscribeError('Muse said: secret body', 400, false)
      );

      const err = await failure(create(h));

      expect(err.getStatus()).toBe(400);
      expect(codeOf(err)).toBe('AUDIO_NOT_SUPPORTED');
      expect(JSON.stringify(err.getResponse())).not.toContain('secret body');
      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.repo.captions).toHaveLength(0);
    });

    it('refuses an audio well over 60 minutes with 400, holding nothing, and takes a cut a few seconds past it', async () => {
      const long = build({ seconds: 3611 });
      const err = await failure(create(long));
      expect(err.getStatus()).toBe(400);
      expect(codeOf(err)).toBe('AUDIO_TOO_LONG');
      expect(long.charging.reserve).not.toHaveBeenCalled();
      expect(long.repo.captions).toHaveLength(0);

      const exact = build({ seconds: 3600 });
      expect(await create(exact)).toMatchObject({ minutes: 60 });

      // the phone's cut at 60 minutes can run a little over; the charge stays 60 minutes
      const cut = build({ seconds: 3603.4 });
      expect(await create(cut)).toMatchObject({ minutes: 60, cost: 60 * PRICE });
      expect(cut.charging.reserve).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 60 })
      );
    });

    it('refuses a channel that is not a live channel of the workspace, and an empty list', async () => {
      const h = build();
      const err = await failure(create(h, {}, ['int-yt', 'ghost']));
      expect(err.getStatus()).toBe(404);
      expect(codeOf(err)).toBe('CHANNEL_NOT_FOUND');
      expect(h.charging.reserve).not.toHaveBeenCalled();

      expect(codeOf(await failure(create(h, {}, [])))).toBe('NO_CHANNELS');
    });

    it('counts a channel named twice once', async () => {
      const h = build();

      await create(h, {}, ['int-yt', 'int-yt', 'int-x1']);

      expect(h.publish.preview).toHaveBeenCalledWith(ORG, {
        integrationIds: ['int-yt', 'int-x1'],
      });
      expect(h.repo.captions[0].integrationIds).toEqual(['int-yt', 'int-x1']);
    });

    it('gives the credits back, fails the caption and deletes the audio when the workflow cannot start', async () => {
      const h = build({ seconds: 150 });
      h.start.mockRejectedValue(new Error('temporal is down'));

      const err = await failure(create(h));

      expect(err.getStatus()).toBe(503);
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:captions:cap-1',
        { ok: false },
        ORG
      );
      expect(h.repo.captions[0].status).toBe('FAILED');
      expect(h.repo.captions[0].error).not.toContain('temporal');
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);
    });

    it('answers 503 before holding anything when there is no workflow client', async () => {
      const h = build();
      (h.service as any)._temporalService = {
        client: { getRawClient: () => null },
      };

      expect((await failure(create(h))).getStatus()).toBe(503);
      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.repo.captions).toHaveLength(0);
    });
  });

  describe('the workflow steps', () => {
    it('transcribes and writes, and keeps the credits held until the caption is used', async () => {
      const h = build({ seconds: 150 });
      await create(h);

      await runJob(h, 'cap-1');

      const caption = h.repo.captions[0];
      expect(caption.status).toBe('READY');
      expect(caption.transcript).toBe(SPEECH);
      expect(caption.segments).toEqual([
        { startMs: 0, endMs: 5000, text: SPEECH },
      ]);
      expect(caption.language).toBeNull();
      // held once at create, neither committed nor given back
      expect(h.charging.reserve).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(caption.creditState).toBe('HELD');
      // the audio is gone once transcribed
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);
    });

    it('deletes the audio after a transcription and does not transcribe twice on a retry', async () => {
      const h = build();
      await create(h);

      await h.service.transcribeCaption('cap-1');
      await h.service.transcribeCaption('cap-1');

      expect(h.transcription.transcribe).toHaveBeenCalledTimes(1);
      expect(h.transcription.transcribe).toHaveBeenCalledWith(AUDIO_KEY);
      expect(mockDeleteObject).toHaveBeenCalledTimes(2);
    });

    it('does not fail the step when the audio cannot be deleted', async () => {
      const h = build();
      await create(h);
      mockDeleteObject.mockRejectedValue(new Error('r2 is down'));

      await expect(h.service.transcribeCaption('cap-1')).resolves.toBeUndefined();
      expect(h.repo.captions[0].transcript).toBe(SPEECH);
    });

    it('reads the audio by its key whatever the upload row says', async () => {
      const h = build();
      await create(h);
      // the sweep may have marked the row expired while the job waited
      h.repo.uploads[0].status = 'expired';

      await h.service.transcribeCaption('cap-1');

      expect(h.transcription.transcribe).toHaveBeenCalledWith(AUDIO_KEY);
    });

    it('does not reopen a job that already ended', async () => {
      const h = build();
      await create(h);
      await h.service.failCaption('cap-1');

      await h.service.transcribeCaption('cap-1');

      expect(h.transcription.transcribe).not.toHaveBeenCalled();
      expect(h.repo.captions[0].status).toBe('FAILED');
    });

    it('gives a caption deleted while it was transcribed no transcript, and gives the credits back', async () => {
      const h = build({ seconds: 150 });
      await create(h);
      h.transcription.transcribe.mockImplementation(async () => {
        await h.service.softDelete(ORG, 'cap-1');
        return { text: SPEECH, segments: [], seconds: 150 };
      });

      const err = await failure(h.service.transcribeCaption('cap-1'));
      await h.service.failCaption('cap-1', err.message);

      expect(err.type).toBe('ai_captions_stop');
      expect(err.nonRetryable).toBe(true);
      expect(h.repo.captions[0].transcript).toBeNull();
      expect(h.repo.captions[0].status).toBe('FAILED');
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:captions:cap-1',
        { ok: false },
        ORG
      );
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);
    });

    it('does not transcribe a caption deleted before its job started', async () => {
      const h = build();
      await create(h);
      await h.service.softDelete(ORG, 'cap-1');

      const err = await failure(h.service.transcribeCaption('cap-1'));

      expect(err.type).toBe('ai_captions_stop');
      expect(h.transcription.transcribe).not.toHaveBeenCalled();
    });

    it('stops for good, in words of its own, on audio the transcriber refuses', async () => {
      const h = build();
      await create(h);
      h.transcription.transcribe.mockRejectedValue(
        new MuseTranscribeError('Muse answered 400: raw body', 400, false)
      );

      const err = await failure(h.service.transcribeCaption('cap-1'));

      expect(err).toBeInstanceOf(ApplicationFailure);
      expect(err.type).toBe('ai_captions_stop');
      expect(err.nonRetryable).toBe(true);
      expect(err.message).not.toContain('raw body');
      expect(mockDeleteObject).not.toHaveBeenCalled();
    });

    it('stops for good when the transcriber loses its key', async () => {
      const h = build();
      await create(h);
      h.transcription.transcribe.mockRejectedValue(new AiCaptionsNotConfigured());

      const err = await failure(h.service.transcribeCaption('cap-1'));

      expect(err.type).toBe('ai_captions_stop');
      expect(err.nonRetryable).toBe(true);
    });

    it('lets the step be retried on a failure that may pass', async () => {
      const h = build();
      await create(h);
      const outage = new MuseTranscribeError('Muse is unreachable', 0, true);
      h.transcription.transcribe.mockRejectedValue(outage);

      const err = await failure(h.service.transcribeCaption('cap-1'));

      expect(err).toBe(outage);
      expect(err).not.toBeInstanceOf(ApplicationFailure);
    });

    it('ends as NO_SPEECH, gives the credits back and deletes the audio when few words were spoken', async () => {
      const h = build({ seconds: 150 });
      await create(h);
      h.transcription.transcribe.mockResolvedValue({
        text: SHORT,
        segments: [],
        seconds: 150,
      });

      await h.service.transcribeCaption('cap-1');
      mockDeleteObject.mockClear();
      const answer = await h.service.generateCaption('cap-1');
      await h.service.finishCaption('cap-1');

      expect(answer).toEqual({ noSpeech: true });
      expect(h.repo.captions[0].status).toBe('NO_SPEECH');
      expect(h.repo.captions[0].error).toBeTruthy();
      expect(h.generator.generate).not.toHaveBeenCalled();
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:captions:cap-1',
        { ok: false },
        ORG
      );
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);
    });

    it('counts the words of a language written without spaces', async () => {
      const h = build();
      await create(h);
      h.transcription.transcribe.mockResolvedValue({
        text: '今日は天気がとても良いので公園に散歩に行って友達と一緒に昼ご飯を食べました',
        segments: [],
        seconds: 150,
      });

      await h.service.transcribeCaption('cap-1');

      expect(await h.service.generateCaption('cap-1')).toEqual({
        noSpeech: false,
      });
    });

    it('writes one text for every provider and kind, as long as the shortest limit among its channels', async () => {
      const h = build();
      await create(h, { userText: '  my own words  ' }, [
        'int-x2',
        'int-x1',
        'int-yt',
        'int-gmb',
      ]);
      await h.service.transcribeCaption('cap-1');

      await h.service.generateCaption('cap-1');

      expect(h.generator.generate).toHaveBeenCalledTimes(1);
      expect(h.generator.generate).toHaveBeenCalledWith(ORG, {
        transcript: SPEECH,
        language: undefined,
        userText: 'my own words',
        targets: [
          { identifier: 'x', platform: 'X', kind: 'video', maxLength: 280 },
          {
            identifier: 'youtube',
            platform: 'YouTube',
            kind: 'video',
            maxLength: 5000,
          },
          {
            identifier: 'gmb',
            platform: 'Google Business',
            kind: 'text',
            maxLength: 1500,
          },
        ],
      });
      // the two X channels share the text; the channel that takes no video gets a text post
      expect(
        h.repo.outputs.map((o) => [o.integrationId, o.kind, o.text])
      ).toEqual([
        ['int-x2', 'video', 'x video text'],
        ['int-x1', 'video', 'x video text'],
        ['int-yt', 'video', 'youtube video text'],
        ['int-gmb', 'text', 'gmb text text'],
      ]);
      expect(h.repo.outputs[2]).toMatchObject({
        providerIdentifier: 'youtube',
        title: 'A title',
        hashtags: ['tag'],
        promptKey: 'captions.video.youtube',
        promptVersion: 1,
        promptSource: 'default',
        model: 'gpt-5-nano',
      });
    });

    it('leaves out the typed text when it is only blanks, and a channel deleted meanwhile', async () => {
      const h = build();
      await create(h, { userText: '   ' }, ['int-yt', 'int-x1']);
      await h.service.transcribeCaption('cap-1');
      h.integrations.getIntegrationsList.mockResolvedValue(
        INTEGRATIONS.filter((i) => i.id !== 'int-x1')
      );

      await h.service.generateCaption('cap-1');

      const input = h.generator.generate.mock.calls[0][1];
      expect(input.userText).toBeUndefined();
      expect(input.targets.map((t: any) => t.identifier)).toEqual(['youtube']);
    });

    it('writes the same set when it runs again', async () => {
      const h = build();
      await create(h, {}, ['int-x2', 'int-x1', 'int-yt', 'int-gmb']);
      await h.service.transcribeCaption('cap-1');

      await h.service.generateCaption('cap-1');
      await h.service.generateCaption('cap-1');

      expect(h.repo.outputs).toHaveLength(4);
    });

    it('does nothing in the last step for a job that ended without text', async () => {
      const h = build();
      await create(h);
      await h.service.failCaption('cap-1');
      h.charging.finish.mockClear();

      await h.service.finishCaption('cap-1');

      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(h.repo.captions[0].status).toBe('FAILED');
    });
  });

  describe('the failure path', () => {
    it('gives the credits back once, fails the caption and deletes the audio', async () => {
      const h = build({ seconds: 150 });
      await create(h);

      await h.service.failCaption('cap-1');
      await h.service.failCaption('cap-1');

      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:captions:cap-1',
        { ok: false },
        ORG
      );
      expect(h.repo.captions[0].status).toBe('FAILED');
      expect(h.repo.captions[0].error).toBeTruthy();
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);
    });

    it('stores the text of a stop for the customer', async () => {
      const h = build();
      await create(h);

      await h.service.failCaption('cap-1', 'The audio could not be read.');

      expect(h.repo.captions[0].error).toBe('The audio could not be read.');
    });

    it('keeps the credits held instead when the texts were already written', async () => {
      const h = build({ seconds: 150 });
      await create(h);
      await h.service.transcribeCaption('cap-1');
      await h.service.generateCaption('cap-1');

      await h.service.failCaption('cap-1');

      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(h.repo.captions[0].status).toBe('READY');
      expect(h.repo.captions[0].creditState).toBe('HELD');
    });

    it('settles nothing for a recording under a minute, and nothing for an unknown caption', async () => {
      const h = build({ seconds: 30 });
      await create(h);

      await h.service.failCaption('cap-1');
      await h.service.failCaption('nope');

      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(h.repo.captions[0].status).toBe('FAILED');
    });

    it('does not undo a caption that is already READY', async () => {
      const h = build();
      await create(h);
      await runJob(h, 'cap-1');
      h.charging.finish.mockClear();

      await h.service.failCaption('cap-1');

      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(h.repo.captions[0].status).toBe('READY');
    });
  });

  describe('a job that stopped moving (F1)', () => {
    const HOUR = 3600 * 1000;

    // The caption as if nothing had changed it for this many hours.
    const idle = (h: Harness, hours: number) => {
      h.repo.captions[0].updatedAt = new Date(Date.now() - hours * HOUR);
    };

    it('ends a stale PENDING job as FAILED on a read, gives the credits back once and deletes the audio', async () => {
      const h = build({ seconds: 150 });
      await create(h);
      idle(h, 4);

      const view = await h.service.get(ORG, 'cap-1');

      expect(view).toEqual({
        id: 'cap-1',
        status: 'FAILED',
        error: expect.any(String),
        outputs: [],
      });
      // a text of ours, never a provider's
      expect(view.error).not.toMatch(/temporal|muse|openai/i);
      expect(h.repo.captions[0].status).toBe('FAILED');
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:captions:cap-1',
        { ok: false },
        ORG
      );
      expect(mockDeleteObject).toHaveBeenCalledTimes(1);
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);

      // it is final now: the next read changes nothing
      expect((await h.service.get(ORG, 'cap-1')).status).toBe('FAILED');
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(mockDeleteObject).toHaveBeenCalledTimes(1);
    });

    it('ends a job stuck in any step of the workflow', async () => {
      for (const status of ['TRANSCRIBING', 'GENERATING']) {
        const h = build({ seconds: 150 });
        await create(h);
        h.repo.captions[0].status = status;
        idle(h, 5);

        expect((await h.service.get(ORG, 'cap-1')).status).toBe('FAILED');
        expect(h.charging.finish).toHaveBeenCalledWith(
          'ai:captions:cap-1',
          { ok: false },
          ORG
        );
      }
    });

    it('calls no finish for a recording under a minute, which held nothing, and still deletes the audio', async () => {
      const h = build({ seconds: 30 });
      await create(h);
      idle(h, 4);

      expect((await h.service.get(ORG, 'cap-1')).status).toBe('FAILED');

      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);
    });

    it('keeps the credits of a job whose texts were already written: it is READY and held, not given back', async () => {
      const h = build({ seconds: 150 });
      await create(h, {}, ['int-yt', 'int-gmb']);
      await h.service.transcribeCaption('cap-1');
      await h.service.generateCaption('cap-1');
      // the workflow died before the last step
      expect(h.repo.captions[0].status).toBe('GENERATING');
      h.charging.finish.mockClear();
      idle(h, 4);

      const view = await h.service.get(ORG, 'cap-1');

      expect(view.status).toBe('READY');
      expect(view.outputs).toHaveLength(2);
      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(h.repo.captions[0].creditState).toBe('HELD');
    });

    it('leaves a job in progress that moved within the last hours alone', async () => {
      const h = build({ seconds: 150 });
      await create(h);
      const closed = jest.spyOn(h.repo, 'closeStale');
      idle(h, 2);

      expect((await h.service.get(ORG, 'cap-1')).status).toBe('PENDING');

      expect(closed).not.toHaveBeenCalled();
      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(mockDeleteObject).not.toHaveBeenCalled();
      expect(h.repo.captions[0].status).toBe('PENDING');
    });

    it('counts the hours from the last change, not from the creation', async () => {
      const h = build({ seconds: 150 });
      await create(h);
      // created long ago, but the workflow changed it a moment ago
      h.repo.captions[0].createdAt = new Date(Date.now() - 48 * HOUR);
      await h.service.transcribeCaption('cap-1');

      expect((await h.service.get(ORG, 'cap-1')).status).toBe('TRANSCRIBING');
      expect(h.charging.finish).not.toHaveBeenCalled();
    });

    it('never changes a job that ended, however long ago', async () => {
      const ready = build({ seconds: 150 });
      await create(ready);
      await runJob(ready, 'cap-1');
      const failed = build({ seconds: 150 });
      await create(failed);
      await failed.service.failCaption('cap-1');
      const silent = build({ seconds: 150 });
      await create(silent);
      silent.transcription.transcribe.mockResolvedValue({
        text: SHORT,
        segments: [],
        seconds: 150,
      });
      await silent.service.transcribeCaption('cap-1');
      await silent.service.generateCaption('cap-1');

      for (const [h, status] of [
        [ready, 'READY'],
        [failed, 'FAILED'],
        [silent, 'NO_SPEECH'],
      ] as const) {
        h.charging.finish.mockClear();
        mockDeleteObject.mockClear();
        const closed = jest.spyOn(h.repo, 'closeStale');
        idle(h, 72);

        expect((await h.service.get(ORG, 'cap-1')).status).toBe(status);
        expect((await h.service.list(ORG, 1)).items[0].status).toBe(status);

        expect(closed).not.toHaveBeenCalled();
        expect(h.charging.finish).not.toHaveBeenCalled();
        expect(mockDeleteObject).not.toHaveBeenCalled();
        expect(h.repo.captions[0].status).toBe(status);
      }
    });

    it('settles once when two reads find the same dead job', async () => {
      const h = build({ seconds: 150 });
      await create(h);
      idle(h, 4);

      const [one, two] = await Promise.all([
        h.service.get(ORG, 'cap-1'),
        h.service.get(ORG, 'cap-1'),
      ]);

      expect(one.status).toBe('FAILED');
      expect(two.status).toBe('FAILED');
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(mockDeleteObject).toHaveBeenCalledTimes(1);
    });

    it('leaves a job to the workflow that moved it between the read and the write', async () => {
      const h = build({ seconds: 150 });
      await create(h);
      idle(h, 4);
      // the workflow wakes up after the service decided and before its write
      const closeStale = h.repo.closeStale;
      h.repo.closeStale = async (...args: [string, string, Date, any]) => {
        Object.assign(h.repo.captions[0], {
          status: 'TRANSCRIBING',
          updatedAt: new Date(),
        });
        return closeStale(...args);
      };

      const view = await h.service.get(ORG, 'cap-1');

      expect(view.status).toBe('TRANSCRIBING');
      expect(h.repo.captions[0].status).toBe('TRANSCRIBING');
      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(mockDeleteObject).not.toHaveBeenCalled();
    });

    it('lets a workflow that wakes up late find the job ended', async () => {
      const h = build({ seconds: 150 });
      await create(h);
      idle(h, 4);
      await h.service.get(ORG, 'cap-1');
      h.charging.finish.mockClear();

      await runJob(h, 'cap-1');

      expect(h.repo.captions[0].status).toBe('FAILED');
      expect(h.transcription.transcribe).not.toHaveBeenCalled();
      expect(h.generator.generate).not.toHaveBeenCalled();
      expect(h.charging.finish).not.toHaveBeenCalled();
    });

    it('still ends the job when the credits cannot be given back now, and leaves them to the nightly reconciliation', async () => {
      const h = build({ seconds: 150 });
      await create(h);
      h.charging.finish.mockRejectedValue(new Error('database is down'));
      idle(h, 4);

      const view = await h.service.get(ORG, 'cap-1');

      expect(view.status).toBe('FAILED');
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);
    });

    it('ends a dead job found by a repeated create and answers it as the contract says: the same caption, FAILED, cost 0', async () => {
      const h = build({ seconds: 150 });
      const first = await create(h);
      idle(h, 4);

      const again = await create(h);

      expect(again).toEqual({
        id: (first as any).id,
        status: 'FAILED',
        cost: 0,
        minutes: 2,
      });
      // nothing is held or started again, and what was held is given back once
      expect(h.charging.reserve).toHaveBeenCalledTimes(1);
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(h.repo.captions).toHaveLength(1);
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:captions:cap-1',
        { ok: false },
        ORG
      );
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);

      // and a third create answers the same, still holding nothing
      expect(await create(h)).toEqual(again);
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
    });

    it('answers a repeated create of a job that moved recently as it is', async () => {
      const h = build({ seconds: 150 });
      await create(h);
      idle(h, 2);

      expect(await create(h)).toMatchObject({ status: 'PENDING', cost: 2 * PRICE });
      expect(h.charging.finish).not.toHaveBeenCalled();
    });

    it('ends a dead job on the detail the web page reads and on its list', async () => {
      const detailed = build({ seconds: 150 });
      await create(detailed);
      idle(detailed, 4);

      expect(await detailed.service.detail(ORG, 'cap-1')).toMatchObject({
        status: 'FAILED',
        error: expect.any(String),
        outputs: [],
      });
      expect(detailed.charging.finish).toHaveBeenCalledTimes(1);

      const listed = build({ seconds: 150 });
      await create(listed, { title: 'My video' });
      idle(listed, 4);

      const { items } = await listed.service.list(ORG, 1);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id: 'cap-1', status: 'FAILED' });
      expect(items[0]).not.toHaveProperty('updatedAt');
      expect(listed.charging.finish).toHaveBeenCalledTimes(1);
      expect(listed.repo.captions[0].status).toBe('FAILED');
    });

    it("does not end another workspace's dead job on a read of the wrong workspace", async () => {
      const h = build({ seconds: 150 });
      await create(h);
      idle(h, 4);

      expect((await failure(h.service.get('org-2', 'cap-1'))).getStatus()).toBe(404);
      expect((await h.service.list('org-2', 1)).items).toEqual([]);

      expect(h.repo.captions[0].status).toBe('PENDING');
      expect(h.charging.finish).not.toHaveBeenCalled();
    });
  });

  describe('what the phone and the page read', () => {
    it('gives the texts and subtitles of a READY caption, and no transcript', async () => {
      const h = build();
      await create(h, {}, ['int-yt', 'int-gmb']);
      await runJob(h, 'cap-1');

      const view: any = await h.service.get(ORG, 'cap-1');

      expect(view).toEqual({
        id: 'cap-1',
        status: 'READY',
        subtitles: {
          words: [],
          segments: [{ startMs: 0, endMs: 5000, text: SPEECH }],
        },
        outputs: [
          {
            integrationId: 'int-yt',
            provider: 'youtube',
            kind: 'video',
            title: 'A title',
            text: 'youtube video text',
          },
          {
            integrationId: 'int-gmb',
            provider: 'gmb',
            kind: 'text',
            text: 'gmb text text',
          },
        ],
      });
      expect(view).not.toHaveProperty('transcript');
    });

    it('gives subtitle timing data and words when caption is READY with word-level segments', async () => {
      const h = build();
      await create(h);
      h.transcription.transcribe.mockResolvedValueOnce({
        text: 'hello world',
        language: 'eng',
        segments: [
          {
            startMs: 0,
            endMs: 2000,
            text: 'hello world',
            words: [
              { text: 'hello', startMs: 0, endMs: 900, type: 'word' },
              { text: 'world', startMs: 1000, endMs: 2000, type: 'word' },
            ],
          },
        ],
        seconds: 150,
      });
      await runJob(h, 'cap-1');

      const view = await h.service.get(ORG, 'cap-1');
      expect(view.status).toBe('READY');
      expect(view.subtitles).toEqual({
        language: 'eng',
        words: [
          { text: 'hello', startMs: 0, endMs: 900, type: 'word' },
          { text: 'world', startMs: 1000, endMs: 2000, type: 'word' },
        ],
        segments: [
          {
            startMs: 0,
            endMs: 2000,
            text: 'hello world',
            words: [
              { text: 'hello', startMs: 0, endMs: 900, type: 'word' },
              { text: 'world', startMs: 1000, endMs: 2000, type: 'word' },
            ],
          },
        ],
      });
    });

    it('gives no texts before the caption is READY, and the error of a failed one', async () => {
      const h = build();
      await create(h);
      expect(await h.service.get(ORG, 'cap-1')).toEqual({
        id: 'cap-1',
        status: 'PENDING',
        outputs: [],
      });

      await h.service.failCaption('cap-1', 'It failed.');
      expect(await h.service.get(ORG, 'cap-1')).toEqual({
        id: 'cap-1',
        status: 'FAILED',
        error: 'It failed.',
        outputs: [],
      });
    });

    it("never reads another workspace's caption or a deleted one", async () => {
      const h = build();
      await create(h);

      const foreign = await failure(h.service.get('org-2', 'cap-1'));
      expect(foreign.getStatus()).toBe(404);
      expect(codeOf(foreign)).toBe('CAPTION_NOT_FOUND');

      await h.service.softDelete(ORG, 'cap-1');
      expect((await failure(h.service.get(ORG, 'cap-1'))).getStatus()).toBe(404);
    });

    it("deletes only the workspace's own caption", async () => {
      const h = build();
      await create(h);

      expect((await failure(h.service.softDelete('org-2', 'cap-1'))).getStatus()).toBe(404);
      expect(h.repo.captions[0].deletedAt).toBeNull();

      await h.service.softDelete(ORG, 'cap-1');
      expect(h.repo.captions[0].deletedAt).toBeInstanceOf(Date);
      expect((await failure(h.service.softDelete(ORG, 'cap-1'))).getStatus()).toBe(404);
    });

    it('lists the captions with the channels that are still live', async () => {
      const h = build();
      await create(h, { title: 'My video' }, ['int-yt', 'int-x1']);
      h.integrations.getIntegrationsList.mockResolvedValue(
        INTEGRATIONS.filter((i) => i.id !== 'int-x1')
      );

      const { items, pages } = await h.service.list(ORG, 1);

      expect(pages).toBe(1);
      expect(items).toEqual([
        {
          id: 'cap-1',
          createdAt: new Date('2026-10-21T10:00:00Z'),
          title: 'My video',
          status: 'PENDING',
          channels: [
            { integrationId: 'int-yt', provider: 'youtube', picture: 'int-yt.png' },
          ],
        },
      ]);
      expect((await h.service.list('org-2', 1)).items).toEqual([]);
    });
  });

  describe('what the web page reads', () => {
    const FUTURE = new Date('2026-12-01T09:00:00Z');
    const PAST = new Date('2026-10-01T09:00:00Z');

    // A READY caption of the workspace with a text for YouTube and one for the text-only channel.
    const ready = async (h: Harness) => {
      await create(h, { title: 'My video' }, ['int-yt', 'int-gmb']);
      await runJob(h, 'cap-1');
    };

    it('gives the transcript, the recording name, the date and every text with the post made from it', async () => {
      const h = build();
      await ready(h);
      h.repo.outputs[0].postId = 'post-1';
      h.repo.outputs[0].postGroup = 'group-1';
      h.repo.posts.push({ id: 'post-1', organizationId: ORG, state: 'QUEUE', publishDate: FUTURE });

      const detail = await h.service.detail(ORG, 'cap-1');

      expect(detail).toEqual({
        id: 'cap-1',
        status: 'READY',
        title: 'My video',
        createdAt: new Date('2026-10-21T10:00:00Z'),
        transcript: SPEECH,
        segments: [{ startMs: 0, endMs: 5000, text: SPEECH }],
        outputs: [
          {
            integrationId: 'int-yt',
            provider: 'youtube',
            kind: 'video',
            title: 'A title',
            text: 'youtube video text',
            postId: 'post-1',
            postGroup: 'group-1',
            postState: 'QUEUE',
            publishDate: FUTURE,
          },
          {
            integrationId: 'int-gmb',
            provider: 'gmb',
            kind: 'text',
            text: 'gmb text text',
          },
        ],
      });
      expect(h.repo.postStates).toHaveBeenCalledWith(ORG, ['post-1']);
    });

    it('says where each post stands, and gives no state for a post that was deleted', async () => {
      const h = build();
      await ready(h);
      Object.assign(h.repo.outputs[0], { postId: 'post-1', postGroup: 'group-1' });
      Object.assign(h.repo.outputs[1], { postId: 'post-2', postGroup: 'group-2' });
      h.repo.posts.push(
        { id: 'post-1', organizationId: ORG, state: 'PUBLISHED', publishDate: PAST },
        { id: 'post-2', organizationId: ORG, state: 'QUEUE', publishDate: FUTURE, deletedAt: new Date() }
      );

      const { outputs } = await h.service.detail(ORG, 'cap-1');

      expect(outputs[0]).toMatchObject({ postState: 'PUBLISHED', publishDate: PAST });
      expect(outputs[1]).toMatchObject({ postId: 'post-2', postGroup: 'group-2' });
      expect(outputs[1]).not.toHaveProperty('postState');
      expect(outputs[1]).not.toHaveProperty('publishDate');
    });

    it("never gives the state of a post that is not the workspace's", async () => {
      const h = build();
      await ready(h);
      Object.assign(h.repo.outputs[0], { postId: 'post-1', postGroup: 'group-1' });
      h.repo.posts.push({ id: 'post-1', organizationId: 'org-2', state: 'QUEUE', publishDate: FUTURE });

      const { outputs } = await h.service.detail(ORG, 'cap-1');

      expect(outputs[0]).not.toHaveProperty('postState');
      expect(h.repo.postStates).toHaveBeenCalledWith(ORG, ['post-1']);
    });

    it('looks up no post when no text was made into one', async () => {
      const h = build();
      await ready(h);

      await h.service.detail(ORG, 'cap-1');

      expect(h.repo.postStates).not.toHaveBeenCalled();
    });

    it('gives the transcript and no texts before the caption is READY, and the error of a failed one', async () => {
      const h = build();
      await create(h);
      await h.service.transcribeCaption('cap-1');

      expect(await h.service.detail(ORG, 'cap-1')).toEqual({
        id: 'cap-1',
        status: 'TRANSCRIBING',
        createdAt: new Date('2026-10-21T10:00:00Z'),
        transcript: SPEECH,
        segments: [{ startMs: 0, endMs: 5000, text: SPEECH }],
        outputs: [],
      });

      await h.service.failCaption('cap-1', 'It failed.');
      expect(await h.service.detail(ORG, 'cap-1')).toMatchObject({
        status: 'FAILED',
        error: 'It failed.',
        outputs: [],
      });
    });

    it("never gives another workspace's caption or a deleted one", async () => {
      const h = build();
      await ready(h);

      const foreign = await failure(h.service.detail('org-2', 'cap-1'));
      expect(foreign.getStatus()).toBe(404);
      expect(codeOf(foreign)).toBe('CAPTION_NOT_FOUND');
      expect(await failure(h.service.detail(ORG, 'nope'))).toBeDefined();

      await h.service.softDelete(ORG, 'cap-1');
      const deleted = await failure(h.service.detail(ORG, 'cap-1'));
      expect(deleted.getStatus()).toBe(404);
      expect(codeOf(deleted)).toBe('CAPTION_NOT_FOUND');
    });

    it("lists only the workspace's own captions", async () => {
      const h = build();
      await create(h, { title: 'Mine' });
      h.repo.uploads.push({
        id: 'audio-2',
        organizationId: 'org-2',
        objectKey: 'audio-2.wav',
        status: 'completed',
        purpose: 'transcript_audio',
      });
      await h.service.create('org-2', USER, { audioUploadId: 'audio-2', mode: 'auto', title: 'Theirs' } as any, IDS);

      expect((await h.service.list(ORG, 1)).items.map((i) => i.title)).toEqual(['Mine']);
      expect((await h.service.list('org-2', 1)).items.map((i) => i.title)).toEqual(['Theirs']);
    });

    it('hides a deleted caption, its transcript and its texts from the list and the detail', async () => {
      const h = build();
      await ready(h);
      expect((await h.service.list(ORG, 1)).items).toHaveLength(1);

      await h.service.softDelete(ORG, 'cap-1');

      expect((await h.service.list(ORG, 1)).items).toEqual([]);
      expect((await failure(h.service.detail(ORG, 'cap-1'))).getStatus()).toBe(404);
      expect((await failure(h.service.get(ORG, 'cap-1'))).getStatus()).toBe(404);
      // the words of the recording are dropped, not just hidden
      expect(h.repo.captions[0].transcript).toBeNull();
    });
  });

  describe('the credits of a READY caption: used, thrown away or included in an edit', () => {
    // A READY caption of 150 seconds (2 minutes held), as the workflow leaves it.
    const held = async (options: { seconds?: number } = {}) => {
      const h = build({ seconds: options.seconds ?? 150 });
      await create(h);
      await runJob(h, 'cap-1');
      h.charging.reserve.mockClear();
      h.charging.finish.mockClear();
      return h;
    };

    it('commits the held minutes once when the caption is used, and a repeat changes nothing', async () => {
      const h = await held();

      expect(await h.service.useCaption(ORG, 'cap-1')).toBe('COMMITTED');
      expect(await h.service.useCaption(ORG, 'cap-1')).toBe('COMMITTED');

      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:captions:cap-1',
        { ok: true, actualUnits: 2 },
        ORG
      );
      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.repo.captions[0].creditState).toBe('COMMITTED');
    });

    it('reserves again at today\'s price when the reconciliation gave the hold back, then commits', async () => {
      const h = await held();
      h.charging.finish.mockRejectedValueOnce(
        new HttpException('Reservation ai:captions:cap-1 was already released', 409)
      );

      expect(await h.service.useCaption(ORG, 'cap-1')).toBe('COMMITTED');

      expect(h.charging.reserve).toHaveBeenCalledTimes(1);
      expect(h.charging.reserve).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          kind: 'captions',
          quantity: 2,
          idempotencyKey: 'ai:captions:cap-1',
        })
      );
      expect(h.charging.finish).toHaveBeenCalledTimes(2);
      expect(h.repo.captions[0].creditState).toBe('COMMITTED');
    });

    it('never throws: credits that cannot be committed leave the caption held, and the answer says so', async () => {
      const h = await held();
      h.charging.finish.mockRejectedValue(new Error('database is down'));

      expect(await h.service.useCaption(ORG, 'cap-1')).toBe('HELD');
      expect(h.repo.captions[0].creditState).toBe('HELD');

      h.charging.finish.mockRejectedValue(
        new HttpException('Reservation was already released', 409)
      );
      h.charging.reserve.mockRejectedValue(new HttpException('Not enough credits', 402));

      expect(await h.service.useCaption(ORG, 'cap-1')).toBe('HELD');
      expect(h.repo.captions[0].creditState).toBe('HELD');
    });

    it('uses a recording under a minute without touching the credits', async () => {
      const h = await held({ seconds: 30 });

      expect(await h.service.useCaption(ORG, 'cap-1')).toBe('COMMITTED');

      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(h.charging.reserve).not.toHaveBeenCalled();
    });

    it('gives the held minutes back once when the recording is thrown away', async () => {
      const h = await held();

      expect(await h.service.releaseCaption(ORG, 'cap-1')).toBe('RELEASED');
      expect(await h.service.releaseCaption(ORG, 'cap-1')).toBe('RELEASED');

      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:captions:cap-1',
        { ok: false },
        ORG
      );
      expect(h.repo.captions[0].creditState).toBe('RELEASED');
    });

    it('does not give back credits that were already committed', async () => {
      const h = await held();
      await h.service.useCaption(ORG, 'cap-1');
      h.charging.finish.mockClear();

      expect(await h.service.releaseCaption(ORG, 'cap-1')).toBe('COMMITTED');

      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(h.repo.captions[0].creditState).toBe('COMMITTED');
    });

    it('still releases the hold of a caption deleted from the web page, but never uses it', async () => {
      const h = await held();
      await h.service.softDelete(ORG, 'cap-1');

      expect(await h.service.useCaption(ORG, 'cap-1')).toBeNull();
      expect(h.charging.finish).not.toHaveBeenCalled();

      expect(await h.service.releaseCaption(ORG, 'cap-1')).toBe('RELEASED');
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:captions:cap-1',
        { ok: false },
        ORG
      );
    });

    it("answers null and touches nothing for another workspace's or an unknown caption", async () => {
      const h = await held();

      expect(await h.service.useCaption('org-2', 'cap-1')).toBeNull();
      expect(await h.service.releaseCaption('org-2', 'cap-1')).toBeNull();
      expect(await h.service.useCaption(ORG, 'nope')).toBeNull();
      expect(await h.service.releaseCaption(ORG, 'nope')).toBeNull();

      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(h.repo.captions[0].creditState).toBe('HELD');
    });

    it('leaves a caption that never finished alone', async () => {
      const h = build();
      await create(h);
      h.charging.finish.mockClear();

      expect(await h.service.useCaption(ORG, 'cap-1')).toBe('SETTLED');
      expect(await h.service.releaseCaption(ORG, 'cap-1')).toBe('SETTLED');

      expect(h.charging.finish).not.toHaveBeenCalled();
    });

    it('gives the held minutes back and marks the caption INCLUDED when an AI edit reuses it', async () => {
      const h = await held();

      await h.service.includeInEdit(ORG, 'cap-1');
      await h.service.includeInEdit(ORG, 'cap-1');

      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:captions:cap-1',
        { ok: false },
        ORG
      );
      expect(h.repo.captions[0].creditState).toBe('INCLUDED');
      // and a later use commits nothing: the edit paid for the transcript
      expect(await h.service.useCaption(ORG, 'cap-1')).toBe('INCLUDED');
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
    });

    it('does not mark a caption INCLUDED whose credits were already committed', async () => {
      const h = await held();
      await h.service.useCaption(ORG, 'cap-1');
      h.charging.finish.mockClear();

      await h.service.includeInEdit(ORG, 'cap-1');

      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(h.repo.captions[0].creditState).toBe('COMMITTED');
    });

    it('never throws when the credits cannot be given back: the nightly reconciliation does it', async () => {
      const h = await held();
      h.charging.finish.mockRejectedValue(new Error('database is down'));

      expect(await h.service.releaseCaption(ORG, 'cap-1')).toBe('HELD');
      await expect(h.service.includeInEdit(ORG, 'cap-1')).resolves.toBeUndefined();

      expect(h.repo.captions[0].creditState).toBe('HELD');
    });
  });
});
