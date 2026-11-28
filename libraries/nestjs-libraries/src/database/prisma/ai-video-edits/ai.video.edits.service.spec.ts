// ai.video-editing (T2.2): the AI edit job service. Needs no network, no database and no Temporal: the storage of the
// jobs is an in-memory stand-in, and the credits, the transcriber and the workflow engine are stubs; the planner
// core is the real one. Covers create (what is held and when, a repeat, 402, too long, a start that fails, a failed
// job tried again), the Basic happy path through every step of the workflow, a recording without speech, a caption's
// words reused, and what the phone reads.
import { HttpException, Logger } from '@nestjs/common';
import { Context } from '@temporalio/activity';
import { createHash } from 'crypto';
import { EditAssetsService } from '@gitroom/nestjs-libraries/ai-video-edit/assets/edit.assets.service';
import { AiVideoEditsService } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edits.service';
import { editBlocks } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/edit.blocks';
import { LEVEL_RULES } from '@gitroom/nestjs-libraries/ai-video-edit/contract/edit.contract';
import {
  GOLDEN_FIXTURES,
  goldenRequest,
} from '@gitroom/nestjs-libraries/ai-video-edit/core/fixtures/edit.golden.fixtures';
import { AiCaptionsNotConfigured } from '@gitroom/nestjs-libraries/muse/transcription.provider';
import { organizationId as organizationKey } from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { directorEditLlm, writerEditLlm } from '@gitroom/nestjs-libraries/ai-video-edit/edit.llm';
import { EDIT_DIRECTOR_PROMPT } from '@gitroom/nestjs-libraries/ai-video-edit/edit.director.prompt';

const mockDeleteObject = jest.fn();
const mockReadObject = jest.fn();

jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  R2: { send: jest.fn() },
  R2_BUCKET: 'test-bucket',
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
  readObject: (...args: unknown[]) => mockReadObject(...args),
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edits.repository',
  () => ({ AiVideoEditsRepository: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service',
  () => ({ AiChargingService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service',
  () => ({ AiCaptionsService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.service',
  () => ({ TraceService: class {} })
);
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const USER = 'user-1';
const SESSION = '2f1d1c9e-6f0a-4c55-9a39-0d3c6f1f8a11';
const AUDIO = 'audio-1';
const AUDIO_KEY = 'audio-1.wav';
const PROXY = 'proxy-1';
const CAPTION = 'cap-1';

// Credits per started 3-minute block at each level (pricing.config.ts).
const PRICE: Record<string, number> = { basic: 1, standard: 2, heavy: 3 };

// The English tutorial fixture: its words as the transcriber returns them, and the phone's request for it.
const FIXTURE = GOLDEN_FIXTURES[0];
const REQUEST = goldenRequest(FIXTURE);

// The storage of the jobs, in memory, with the behaviour the service relies on (one job per recording and level, a
// deleted edit hidden from reads, `updatedAt` moving with every write to an edit).
class FakeRepository {
  edits: any[] = [];
  uploads: any[] = [
    {
      id: AUDIO,
      organizationId: ORG,
      objectKey: AUDIO_KEY,
      status: 'completed',
      purpose: 'transcript_audio',
    },
    {
      id: PROXY,
      organizationId: ORG,
      objectKey: 'proxy-1.mp4',
      status: 'completed',
      purpose: 'edit_proxy',
    },
  ];
  captions: any[] = [];
  private count = 0;

  upload = async (organizationId: string, id: string) =>
    this.uploads.find((u) => u.id === id && u.organizationId === organizationId) ||
    null;

  caption = async (organizationId: string, id: string) =>
    this.captions.find(
      (c) => c.id === id && c.organizationId === organizationId && !c.deletedAt
    ) || null;

  findBySession = async (organizationId: string, sessionId: string, level: string) =>
    this.edits.find(
      (e) =>
        e.organizationId === organizationId &&
        e.sessionId === sessionId &&
        e.level === level
    ) || null;

  createEdit = async (data: any) => {
    if (
      this.edits.some(
        (e) =>
          e.organizationId === data.organizationId &&
          e.sessionId === data.sessionId &&
          e.level === data.level
      )
    ) {
      return null;
    }
    const edit = {
      id: `edit-${++this.count}`,
      status: 'PENDING',
      error: null,
      aiCaptionId: null,
      audioUploadId: null,
      words: null,
      scores: null,
      texts: null,
      moments: null,
      plan: null,
      assets: null,
      log: null,
      language: null,
      deletedAt: null,
      userId: null,
      createdAt: new Date('2026-11-17T10:00:00Z'),
      updatedAt: new Date(),
      ...data,
    };
    this.edits.push(edit);
    return edit;
  };

  getEditById = async (id: string) => this.edits.find((e) => e.id === id) || null;

  getEdit = async (organizationId: string, id: string) =>
    this.edits.find(
      (e) => e.id === id && e.organizationId === organizationId && !e.deletedAt
    ) || null;

  updateEdit = async (_organizationId: string, id: string, data: any) =>
    Object.assign(this.edits.find((e) => e.id === id), data, {
      updatedAt: new Date(),
    });

  saveWords = async (_organizationId: string, id: string, data: any) => {
    const edit = this.edits.find((e) => e.id === id && !e.deletedAt);
    if (edit) {
      Object.assign(edit, data, { updatedAt: new Date() });
    }
    return !!edit;
  };

  // The guarded write: only a job still in progress that has not changed since `before` is ended.
  closeStale = async (organizationId: string, id: string, before: Date, data: any) => {
    const edit = this.edits.find(
      (e) =>
        e.id === id &&
        e.organizationId === organizationId &&
        !['READY', 'NO_SPEECH', 'FAILED'].includes(e.status) &&
        e.updatedAt < before
    );
    if (edit) {
      Object.assign(edit, data, { updatedAt: new Date() });
    }
    return !!edit;
  };

  deleteEdit = async (organizationId: string, id: string) => {
    this.edits = this.edits.filter(
      (e) => !(e.id === id && e.organizationId === organizationId)
    );
  };
}

// The service over stand-ins. `seconds` is what the audio's header says; `words` what the transcriber hears.
const build = (
  options: {
    seconds?: number;
    words?: typeof FIXTURE.words;
    // the trace service stand-in (L2); by default a stub that records nothing
    trace?: { record: jest.Mock };
  } = {}
) => {
  const repo = new FakeRepository();
  const charging = {
    reserve: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    finish: jest.fn().mockResolvedValue(undefined),
    estimate: jest.fn(
      async (_org: string, request: { editLevel: string; quantity: number }) => ({
        amount: editBlocks(request.quantity) * PRICE[request.editLevel],
      })
    ),
  };
  const words = options.words ?? FIXTURE.words;
  const transcription = {
    isConfigured: jest.fn().mockReturnValue(true),
    audioSeconds: jest.fn().mockResolvedValue(options.seconds ?? 150),
    transcribe: jest.fn().mockResolvedValue({
      text: words.map((w) => w.text).join(' '),
      language: 'eng',
      segments: [{ startMs: 0, endMs: 5000, text: '', words }],
      words,
      seconds: options.seconds ?? 150,
    }),
  };
  // Clef-omni: not configured unless a test turns it on; `ask` answers nothing by default
  const clef = {
    isConfigured: jest.fn().mockReturnValue(false),
    ask: jest.fn().mockResolvedValue({}),
  };
  // The writer and the director: down unless a test makes them answer; the brand: a workspace with a colour and no profile
  const editLlm = {
    writeEditTexts: jest.fn().mockResolvedValue(null),
    directEdit: jest.fn().mockResolvedValue(null),
    isConfigured: jest.fn().mockReturnValue(true) };
  const brands = {
    get: jest.fn().mockResolvedValue({
      color: '#1E88E5',
      profile: { schemaVersion: 1 },
    }),
  };
  // The assets: the real resolver over an IconScout that is not configured (so no icon is searched) and a cache
  // nobody reads; the sounds come from AI_EDIT_SOUNDS_BASE_URL, which a test sets
  const iconscout = {
    isConfigured: jest.fn().mockReturnValue(false),
    search: jest.fn().mockResolvedValue([]),
    download: jest.fn(),
  };
  const assets = new EditAssetsService(
    { find: jest.fn().mockResolvedValue(null), create: jest.fn() } as any,
    iconscout as any,
    { pickEditIcons: jest.fn().mockResolvedValue(null), isConfigured: jest.fn().mockReturnValue(true) } as any
  );
  // The caption service: only the hand-over of a reused caption's credits is asked of it
  const captions = { includeInEdit: jest.fn().mockResolvedValue(undefined) };
  const start = jest.fn().mockResolvedValue({});
  const trace = options.trace ?? { record: jest.fn().mockResolvedValue(undefined) };
  const temporal = { client: { getRawClient: () => ({ workflow: { start } }) } };
  const service = new AiVideoEditsService(
    repo as any,
    charging as any,
    transcription as any,
    temporal as any,
    clef as any,
    editLlm as any,
    brands as any,
    assets as any,
    captions as any,
    trace as any
  );
  return {
    trace,
    service,
    captions,
    repo,
    charging,
    transcription,
    start,
    clef,
    editLlm,
    brands,
    assets,
    iconscout,
  };
};

type Harness = ReturnType<typeof build>;

// A create for the recording from its uploaded audio, at Basic unless the body says otherwise.
const create = (h: Harness, body: Record<string, unknown> = {}) =>
  h.service.create(ORG, USER, {
    sessionId: SESSION,
    level: 'basic',
    audioUploadId: AUDIO,
    request: REQUEST,
    ...body,
  } as any);

// The steps of the workflow, in order, as it runs them.
const runJob = async (h: Harness, editId: string) => {
  const { noSpeech } = await h.service.transcribeEdit(editId);
  if (noSpeech) {
    return;
  }
  await h.service.perceiveEdit(editId);
  await h.service.writeEdit(editId);
  await h.service.planEdit(editId);
  await h.service.finishEdit(editId);
};

// A Heavy job of the fixture with its words kept, ready for the writer.
const heavy = async (h: Harness, request: unknown = REQUEST) => {
  await create(h, { level: 'heavy', proxyUploadIds: [PROXY], request });
  await h.service.transcribeEdit('edit-1');
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

// The stable code of an HttpException of the edit routes.
const codeOf = (err?: HttpException) => (err?.getResponse() as any)?.code;

describe('ai.video-editing: AiVideoEditsService', () => {
  const savedMax = process.env.AI_EDIT_MAX_SECONDS;

  beforeEach(() => {
    delete process.env.AI_EDIT_MAX_SECONDS;
    mockDeleteObject.mockReset();
    mockDeleteObject.mockResolvedValue(undefined);
    mockReadObject.mockReset();
    mockReadObject.mockResolvedValue(Buffer.from('piece'));
  });

  afterAll(() => {
    if (savedMax === undefined) {
      delete process.env.AI_EDIT_MAX_SECONDS;
    } else {
      process.env.AI_EDIT_MAX_SECONDS = savedMax;
    }
  });

  describe('create', () => {
    it('holds the credits once for the started 3-minute blocks of the audio and starts the workflow', async () => {
      const h = build({ seconds: 200 });

      const created = await create(h);

      // 200 s is two started blocks of Basic
      expect(created).toEqual({ id: 'edit-1', status: 'PENDING', cost: 2 });
      expect(h.charging.reserve).toHaveBeenCalledTimes(1);
      expect(h.charging.reserve).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          userId: USER,
          kind: 'edit',
          editLevel: 'basic',
          quantity: 200,
          idempotencyKey: 'ai:edit:edit-1',
        })
      );
      expect(h.transcription.audioSeconds).toHaveBeenCalledWith(AUDIO_KEY);
      expect(h.start).toHaveBeenCalledTimes(1);
      const [name, options] = h.start.mock.calls[0];
      expect(name).toBe('aiVideoEditWorkflowV101');
      expect(options).toMatchObject({
        workflowId: 'ai_video_edit_edit-1',
        taskQueue: 'main',
        args: [{ editId: 'edit-1' }],
      });
      // the workspace id is searchable on the workflow
      expect(options.typedSearchAttributes.get(organizationKey)).toBe(ORG);
      expect(h.repo.edits[0]).toMatchObject({
        organizationId: ORG,
        sessionId: SESSION,
        level: 'basic',
        audioUploadId: AUDIO,
        proxyUploadIds: [],
        sourceSeconds: 200,
        cost: 2,
      });
    });

    it('charges the length the request plans for when it is longer than the audio', async () => {
      const h = build({ seconds: 10 });

      await create(h, {
        request: { ...REQUEST, video: { ...REQUEST.video, duration_ms: 190500 } },
      });

      expect(h.charging.reserve).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 191 })
      );
    });

    it('answers a repeat with the same job and holds nothing again', async () => {
      const h = build();
      await create(h);
      await h.service.transcribeEdit('edit-1');

      const again = await create(h);

      expect(again).toEqual({ id: 'edit-1', status: 'TRANSCRIBING', cost: 1 });
      expect(h.charging.reserve).toHaveBeenCalledTimes(1);
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(h.repo.edits).toHaveLength(1);
    });

    it('makes a separate job for another level of the same recording', async () => {
      const h = build();
      await create(h);

      const standard = await create(h, { level: 'standard', proxyUploadIds: [PROXY] });

      expect(standard).toEqual({ id: 'edit-2', status: 'PENDING', cost: 2 });
      expect(h.repo.edits[1].proxyUploadIds).toEqual([PROXY]);
      expect(h.charging.reserve).toHaveBeenCalledTimes(2);
    });

    it('keeps no job and holds nothing when the credits do not fit (402 as it came)', async () => {
      const h = build();
      h.charging.reserve.mockRejectedValue(
        new HttpException(
          { statusCode: 402, code: 'INSUFFICIENT_CREDITS', message: 'short' },
          402
        )
      );

      const err = await failure(create(h));

      expect(err.getStatus()).toBe(402);
      expect(codeOf(err)).toBe('INSUFFICIENT_CREDITS');
      expect(h.repo.edits).toHaveLength(0);
      expect(h.charging.finish).not.toHaveBeenCalled();
      expect(h.start).not.toHaveBeenCalled();

      // the recording may ask again once the credits are there
      h.charging.reserve.mockResolvedValue({ id: 'ledger-2' });
      expect(await create(h)).toMatchObject({ status: 'PENDING' });
    });

    it('refuses audio longer than AI_EDIT_MAX_SECONDS with 400 VIDEO_TOO_LONG, holding nothing', async () => {
      const h = build({ seconds: 601 });

      const err = await failure(create(h));

      expect(err.getStatus()).toBe(400);
      expect(codeOf(err)).toBe('VIDEO_TOO_LONG');
      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.repo.edits).toHaveLength(0);
    });

    it('refuses a request longer than the limit even when the audio is short', async () => {
      const h = build({ seconds: 30 });
      process.env.AI_EDIT_MAX_SECONDS = '120';

      const err = await failure(
        create(h, {
          request: { ...REQUEST, video: { ...REQUEST.video, duration_ms: 121500 } },
        })
      );

      expect(codeOf(err)).toBe('VIDEO_TOO_LONG');
      expect(h.charging.reserve).not.toHaveBeenCalled();
    });

    it('refuses a Heavy edit with 503 before holding anything when the writer has no key', async () => {
      const h = build();
      h.editLlm.isConfigured.mockReturnValue(false);

      const err = await failure(create(h, { level: 'heavy', proxyUploadIds: [PROXY] }));

      expect(err.getStatus()).toBe(503);
      expect(codeOf(err)).toBe('AI_EDIT_NOT_CONFIGURED');
      expect(h.charging.reserve).not.toHaveBeenCalled();
      expect(h.start).not.toHaveBeenCalled();
    });

    it('starts a Basic edit without any decision key, since Basic makes no decision call', async () => {
      const h = build();
      h.editLlm.isConfigured.mockReturnValue(false);

      const created = await create(h);

      expect(created).toEqual(expect.objectContaining({ id: 'edit-1', status: 'PENDING' }));
      expect(h.start).toHaveBeenCalledTimes(1);
    });

    it('gives the credits back, ends the job FAILED and deletes the audio when the workflow cannot start', async () => {
      const h = build();
      h.start.mockRejectedValue(new Error('temporal down'));

      const err = await failure(create(h));

      expect(err.getStatus()).toBe(503);
      expect(codeOf(err)).toBe('AI_EDIT_NOT_CONFIGURED');
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:edit:edit-1',
        { ok: false },
        ORG
      );
      expect(h.repo.edits[0]).toMatchObject({ status: 'FAILED' });
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);
    });

    it('replaces a FAILED job with a new one when the recording asks again', async () => {
      const h = build();
      h.start.mockRejectedValueOnce(new Error('temporal down'));
      await failure(create(h));

      const again = await create(h);

      expect(again).toEqual({ id: 'edit-2', status: 'PENDING', cost: 1 });
      expect(h.repo.edits.map((e) => e.id)).toEqual(['edit-2']);
      expect(h.charging.reserve).toHaveBeenLastCalledWith(
        expect.objectContaining({ idempotencyKey: 'ai:edit:edit-2' })
      );
    });

    it('refuses another workspace\'s audio, an unfinished proxy and a caption that is not READY', async () => {
      const h = build();
      h.repo.uploads[0].organizationId = OTHER_ORG;
      expect(codeOf(await failure(create(h)))).toBe('AUDIO_NOT_FOUND');

      h.repo.uploads[0].organizationId = ORG;
      h.repo.uploads[1].status = 'pending';
      expect(
        codeOf(
          await failure(
            create(h, { level: 'standard', proxyUploadIds: [PROXY] })
          )
        )
      ).toBe('UPLOAD_NOT_COMPLETE');

      h.repo.captions.push({
        id: CAPTION,
        organizationId: ORG,
        status: 'GENERATING',
        audioSeconds: 100,
        segments: null,
        language: null,
      });
      expect(
        codeOf(
          await failure(
            create(h, { audioUploadId: undefined, aiCaptionId: CAPTION })
          )
        )
      ).toBe('CAPTION_NOT_FOUND');
      expect(h.charging.reserve).not.toHaveBeenCalled();
    });
  });

  describe('the Basic workflow', () => {
    it('transcribes, plans a valid Basic plan, commits the credits once and deletes the audio', async () => {
      const h = build();
      await create(h);

      await runJob(h, 'edit-1');

      const edit = h.repo.edits[0];
      expect(edit.status).toBe('READY');
      expect(edit.language).toBe('eng');
      expect(h.transcription.transcribe).toHaveBeenCalledWith(AUDIO_KEY);
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:edit:edit-1',
        { ok: true },
        ORG
      );
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);

      const plan = edit.plan;
      expect(plan).toMatchObject({
        contract_version: 2,
        session_id: SESSION,
        level: 'basic',
        palette: { mode: 'multi' },
      });
      const features = plan.items.filter(
        (i: any) => i.layer !== 'transition' && i.layer !== 'caption'
      );
      expect(features.length).toBeGreaterThan(0);
      expect(features.length).toBeLessThanOrEqual(LEVEL_RULES.basic.max_feature_effects);
      expect(plan.items.some((i: any) => i.layer === 'icon' || i.sound)).toBe(false);
      // the validator's log holds rule numbers and codes only
      expect(edit.log).toEqual({ warnings: [], rejections: [] });

      // the phone reads the plan
      const view = await h.service.get(ORG, 'edit-1');
      expect(view).toEqual({
        id: 'edit-1',
        status: 'READY',
        cost: 1,
        plan,
        assets: [],
      });
    });

    it('reads the words of a READY caption instead of transcribing', async () => {
      const h = build();
      h.repo.captions.push({
        id: CAPTION,
        organizationId: ORG,
        status: 'READY',
        audioSeconds: 100,
        segments: [{ startMs: 0, endMs: 5000, text: '', words: FIXTURE.words }],
        language: 'eng',
      });

      await create(h, { audioUploadId: undefined, aiCaptionId: CAPTION });
      await runJob(h, 'edit-1');

      expect(h.transcription.audioSeconds).not.toHaveBeenCalled();
      expect(h.transcription.transcribe).not.toHaveBeenCalled();
      expect(h.repo.edits[0]).toMatchObject({ status: 'READY', sourceSeconds: 100 });
      expect(h.repo.edits[0].words).toHaveLength(
        FIXTURE.words.filter((w) => w.type === 'word').length
      );
      // the caption's held credits are handed to the edit, once the plan is made
      expect(h.captions.includeInEdit).toHaveBeenCalledTimes(1);
      expect(h.captions.includeInEdit).toHaveBeenCalledWith(ORG, CAPTION);
    });

    it('leaves the credits of a caption alone for an edit made from its own audio', async () => {
      const h = build();
      await create(h);

      await runJob(h, 'edit-1');

      expect(h.repo.edits[0].status).toBe('READY');
      expect(h.captions.includeInEdit).not.toHaveBeenCalled();
    });

    it('ends a recording without speech as NO_SPEECH and gives the credits back', async () => {
      const h = build({ words: FIXTURE.words.slice(0, 2) });
      await create(h);

      await runJob(h, 'edit-1');

      const edit = h.repo.edits[0];
      expect(edit.status).toBe('NO_SPEECH');
      expect(edit.plan).toBeNull();
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith(
        'ai:edit:edit-1',
        { ok: false },
        ORG
      );
      expect(mockDeleteObject).toHaveBeenCalledWith(AUDIO_KEY);
      expect(await h.service.get(ORG, 'edit-1')).toMatchObject({
        status: 'NO_SPEECH',
        cost: 0,
      });

      // a repeat of the step changes nothing
      expect(await h.service.transcribeEdit('edit-1')).toEqual({ noSpeech: true });
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
    });

    it('fails a job without a plan: credits given back once, a text of ours kept', async () => {
      const h = build();
      await create(h);

      await h.service.failEdit('edit-1', 'The audio of this recording could not be transcribed.');
      await h.service.failEdit('edit-1');

      expect(h.repo.edits[0]).toMatchObject({
        status: 'FAILED',
        error: 'The audio of this recording could not be transcribed.',
      });
      expect(h.charging.finish).toHaveBeenCalledTimes(1);
      expect(h.charging.finish).toHaveBeenCalledWith('ai:edit:edit-1', { ok: false }, ORG);
    });
  });

  describe('perception (Standard)', () => {
    // A Standard job of the fixture with one proxy piece, its words kept.
    const standard = async (h: Harness) => {
      h.clef.isConfigured.mockReturnValue(true);
      await create(h, { level: 'standard', proxyUploadIds: [PROXY] });
      await h.service.transcribeEdit('edit-1');
    };

    it('keeps the scores Clef-omni answered, plans with them and deletes the proxy', async () => {
      const h = build();
      await standard(h);
      h.clef.ask.mockImplementation(async (_video: Buffer, questions: { id: string }[]) =>
        Object.fromEntries(
          questions.map((q) => [
            q.id,
            q.id === 'mood' ? 'excited' : q.id === 'energy' ? 'high' : q.id.startsWith('fam_') ? 'text' : 0.9,
          ])
        )
      );

      await h.service.perceiveEdit('edit-1');
      await h.service.planEdit('edit-1');
      await h.service.finishEdit('edit-1');

      const edit = h.repo.edits[0];
      expect(edit.scores).toMatchObject({ mood: 'excited', energy: 1 });
      expect(Object.keys(edit.scores.emphasis).length).toBeGreaterThan(0);
      expect(h.clef.ask.mock.calls[0][0]).toEqual(Buffer.from('piece'));
      expect(mockDeleteObject).toHaveBeenCalledWith('proxy-1.mp4');
      expect(edit.status).toBe('READY');
      expect(edit.plan.items.length).toBeGreaterThan(0);
    });

    it('still plans a valid edit when every Clef-omni call fails (timeout)', async () => {
      const h = build();
      await standard(h);
      h.clef.ask.mockRejectedValue(new Error('The call did not complete (TimeoutError)'));

      await h.service.perceiveEdit('edit-1');
      await h.service.planEdit('edit-1');
      await h.service.finishEdit('edit-1');

      const edit = h.repo.edits[0];
      expect(edit.scores).toBeNull();
      expect(edit.status).toBe('READY');
      expect(edit.plan.items.length).toBeGreaterThan(0);
      expect(mockDeleteObject).toHaveBeenCalledWith('proxy-1.mp4');
    });

    it('asks nothing when the proxy cannot be read, and for Basic or an unconfigured account', async () => {
      const h = build();
      await standard(h);
      mockReadObject.mockRejectedValue(new Error('gone'));
      await h.service.perceiveEdit('edit-1');
      expect(h.clef.ask).not.toHaveBeenCalled();
      expect(h.repo.edits[0].scores).toBeNull();

      const basic = build();
      await create(basic);
      await basic.service.transcribeEdit('edit-1');
      basic.clef.isConfigured.mockReturnValue(true);
      await basic.service.perceiveEdit('edit-1');
      expect(basic.clef.ask).not.toHaveBeenCalled();

      const off = build();
      await create(off, { level: 'standard', proxyUploadIds: [PROXY] });
      await off.service.transcribeEdit('edit-1');
      await off.service.perceiveEdit('edit-1');
      expect(off.clef.ask).not.toHaveBeenCalled();
    });

    it('does not ask again once the scores are kept', async () => {
      const h = build();
      await standard(h);
      h.clef.ask.mockResolvedValue({ mood: 'calm' });
      await h.service.perceiveEdit('edit-1');
      const calls = h.clef.ask.mock.calls.length;

      await h.service.perceiveEdit('edit-1');

      expect(h.clef.ask.mock.calls.length).toBe(calls);
      expect(h.repo.edits[0].scores).toMatchObject({ mood: 'calm' });
    });
  });

  describe('the Heavy writer and the brand', () => {
    // The text of every overlay of the plan
    const texts = (plan: any) =>
      plan.items
        .filter((i: any) => i.component?.type === 'styled_text')
        .map((i: any) => i.component.text);

    it('writes the hook and the phrases with the brand voice and banned words, and plans with them', async () => {
      const h = build();
      h.brands.get.mockResolvedValue({
        color: '#1E88E5',
        profile: { schemaVersion: 1, voice: 'Bold and warm', bannedWords: ['cheap'] },
      });
      await heavy(h);
      h.editLlm.writeEditTexts.mockImplementation(
        async (_option: unknown, messages: { content: string }[]) => {
          const ids = [...messages[1].content.matchAll(/^(h1|s\d+)[ :]/gm)].map((m) => m[1]);
          return {
            slots: ids.map((id) => ({
              id,
              text: id === 'h1' ? 'Stop wasting hours' : 'Save 2 hours',
              icon_query: 'clock',
            })),
          };
        }
      );

      await h.service.writeEdit('edit-1');
      await h.service.planEdit('edit-1');

      const edit = h.repo.edits[0];
      expect(edit.texts.hook).toBe('Stop wasting hours');
      expect(edit.texts.icon_queries.h1).toBe('clock');
      expect(texts(edit.plan)).toContain('Stop wasting hours');
      const [option, messages] = h.editLlm.writeEditTexts.mock.calls[0];
      // the option the environment chain gives (the default is Muse Spark at high effort, see edit.llm.spec)
      expect(option).toEqual(writerEditLlm());
      expect(messages[1].content).toContain('Bold and warm');
      expect(messages[1].content).toContain('cheap');
    });

    it('hands the resolver the written texts per slot, the hook text on the hook slot', async () => {
      const h = build();
      await heavy(h);
      h.editLlm.writeEditTexts.mockImplementation(
        async (_option: unknown, messages: { content: string }[]) => ({
          slots: [...messages[1].content.matchAll(/^(h1|s\d+)[ :]/gm)].map((m) => ({
            id: m[1],
            text: m[1] === 'h1' ? 'Stop wasting hours' : 'Save 2 hours',
            icon_query: 'clock',
          })),
        })
      );
      const resolve = jest.spyOn(h.assets, 'resolve');

      await h.service.writeEdit('edit-1');
      await h.service.planEdit('edit-1');

      const input = resolve.mock.calls[0][0];
      expect(input.texts?.h1).toBe('Stop wasting hours');
      expect(Object.values(input.texts || {})).toContain('Save 2 hours');
      expect(input.queries.h1).toBe('clock');
    });

    it('drops a written text with a banned word, so its slot keeps the keyword echo', async () => {
      const h = build();
      h.brands.get.mockResolvedValue({
        color: '#1E88E5',
        profile: { schemaVersion: 1, bannedWords: ['Cheap'] },
      });
      await heavy(h);
      h.editLlm.writeEditTexts.mockResolvedValue({
        slots: [{ id: 'h1', text: 'Cheap hacks inside', icon_query: null }],
      });

      await h.service.writeEdit('edit-1');
      await h.service.planEdit('edit-1');

      const edit = h.repo.edits[0];
      expect(edit.texts).toBeNull();
      expect(texts(edit.plan).join(' ').toLowerCase()).not.toContain('cheap');
    });

    it('plans without texts when the writer is down (error or refusal) and never fails the job', async () => {
      const h = build();
      await heavy(h);
      h.editLlm.writeEditTexts.mockRejectedValue(new Error('openai down'));

      await h.service.writeEdit('edit-1');
      await h.service.planEdit('edit-1');
      await h.service.finishEdit('edit-1');

      const edit = h.repo.edits[0];
      expect(edit.texts).toBeNull();
      expect(edit.status).toBe('READY');
      expect(edit.plan.items.length).toBeGreaterThan(0);

      h.editLlm.writeEditTexts.mockResolvedValue(null);
      await h.service.writeEdit('edit-1');
      expect(edit.texts).toBeNull();
    });

    it('asks the writer for Heavy only, and not again once the texts are kept', async () => {
      const basic = build();
      await create(basic);
      await basic.service.transcribeEdit('edit-1');
      await basic.service.writeEdit('edit-1');
      expect(basic.editLlm.writeEditTexts).not.toHaveBeenCalled();

      const h = build();
      await heavy(h);
      h.editLlm.writeEditTexts.mockResolvedValue({
        slots: [{ id: 'h1', text: 'Big promise', icon_query: null }],
      });
      await h.service.writeEdit('edit-1');
      await h.service.writeEdit('edit-1');
      expect(h.editLlm.writeEditTexts).toHaveBeenCalledTimes(1);
    });

    it('uses the workspace colour as the single accent for brand text, at every level', async () => {
      const h = build();
      await create(h, { request: { ...REQUEST, text_colors: 'brand' } });

      await runJob(h, 'edit-1');

      const plan = h.repo.edits[0].plan;
      expect(plan.palette).toEqual({ mode: 'brand', colors: ['#1E88E5'] });
      expect(
        plan.items
          .filter((i: any) => i.component?.type === 'styled_text')
          .every((i: any) => i.component.color_slot === 0)
      ).toBe(true);
    });

    it('keeps the multi colour palette for multi, and when the brand cannot be read', async () => {
      const multi = build();
      await create(multi);
      await runJob(multi, 'edit-1');
      expect(multi.repo.edits[0].plan.palette.mode).toBe('multi');

      const down = build();
      down.brands.get.mockRejectedValue(new Error('gone'));
      await create(down, { request: { ...REQUEST, text_colors: 'brand' } });
      await runJob(down, 'edit-1');
      expect(down.repo.edits[0].status).toBe('READY');
      expect(down.repo.edits[0].plan.palette.mode).toBe('multi');
    });
  });

  describe('the director (trust-first edit, TS4)', () => {
    // The tutorial without drawings or slides: its moments are the sentences only.
    const QUIET = { ...REQUEST, activity_map: [] };

    // A Standard job with its words kept, ready for the director.
    const standard = async (h: Harness, request: unknown = QUIET) => {
      await create(h, { level: 'standard', proxyUploadIds: [PROXY], request });
      await h.service.transcribeEdit('edit-1');
    };

    // The trace rows of a step (the decisions of the director are `direct/decision`).
    const rows = (h: Harness, step: string, kind?: string) =>
      h.trace.record.mock.calls
        .map(([, entry]: [string, any]) => entry)
        .filter((r: any) => r.step === step && (!kind || r.kind === kind));

    const skippedWith = (h: Harness) =>
      rows(h, 'direct', 'decision').find((r: any) => r.payload.decision === 'skipped')?.payload.reason_code;

    // The ids of the sentences the director is asked about, read from its message.
    const asked = (h: Harness) =>
      [...h.editLlm.directEdit.mock.calls[0][1][1].content.matchAll(/^(s\d+) \[/gm)].map((m: RegExpMatchArray) => m[1]);

    // The director labels the first sentence a hook and the rest plain, and calls the video lively.
    const answers = (h: Harness, style = 'lively') =>
      h.editLlm.directEdit.mockImplementation(async (_option: unknown, messages: { content: string }[]) => ({
        style,
        labels: [...messages[1].content.matchAll(/^(s\d+) \[/gm)].map((m) => ({
          id: m[1],
          label: m[1] === 's1' ? 'hook' : 'plain',
        })),
      }));

    it('skips with a traced reason, in order: level, not configured, no words', async () => {
      const basic = build();
      await create(basic);
      await basic.service.transcribeEdit('edit-1');
      basic.editLlm.isConfigured.mockReturnValue(false);
      basic.repo.edits[0].words = [];
      await basic.service.directEdit('edit-1');
      expect(skippedWith(basic)).toBe('level_without_director');

      const unconfigured = build();
      await standard(unconfigured);
      unconfigured.editLlm.isConfigured.mockReturnValue(false);
      unconfigured.repo.edits[0].words = [];
      await unconfigured.service.directEdit('edit-1');
      expect(skippedWith(unconfigured)).toBe('director_not_configured');

      const empty = build();
      await standard(empty);
      empty.repo.edits[0].words = [];
      await empty.service.directEdit('edit-1');
      expect(skippedWith(empty)).toBe('no_words');

      for (const h of [basic, unconfigured, empty]) {
        expect(h.editLlm.directEdit).not.toHaveBeenCalled();
        expect(h.repo.edits[0].moments).toBeNull();
      }
      expect(rows(basic, 'direct', 'decision')[0].payload).toEqual({
        decision: 'skipped',
        reason_code: 'level_without_director',
        level: 'basic',
      });
    });

    it('labels the sentences of the source words and keeps the style and the moments', async () => {
      const h = build();
      await standard(h);
      answers(h);

      await h.service.directEdit('edit-1');

      const moments = h.repo.edits[0].moments;
      expect(moments.source).toBe('director');
      expect(moments.style).toBe('lively');
      expect(moments.moments.length).toBeGreaterThan(1);
      expect(asked(h)).toEqual(moments.moments.filter((m: any) => m.kind === 'sentence').map((m: any) => m.id));
      expect(moments.moments[0]).toMatchObject({ id: 's1', kind: 'sentence', label: 'hook', word_from: 0 });
      expect(moments.moments[1]).toMatchObject({ id: 's2', label: 'plain' });
      // sentences cover the kept words, on the source timeline
      const sentences = moments.moments.filter((m: any) => m.kind === 'sentence');
      expect(sentences[0].start_ms).toBe(h.repo.edits[0].words[0].start_ms);
      expect(sentences[sentences.length - 1].word_to).toBe(h.repo.edits[0].words.length - 1);
      const [option, messages] = h.editLlm.directEdit.mock.calls[0];
      expect(option).toEqual(directorEditLlm());
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe(EDIT_DIRECTOR_PROMPT);
      expect(messages[1].role).toBe('user');
    });

    it('builds drawings and chapters on the source timeline, whatever the cuts will be', async () => {
      const h = build();
      const request = {
        ...QUIET,
        activity_map: [
          { id: 'a1', type: 'brush', start_ms: 1000, end_ms: 2000, region: { x: 0.1, y: 0.2, w: 0.2, h: 0.1 }, strength: 1, source: 'event_log' },
        ],
        chapters: [{ start_ms: 3000, kind: 'text', title: 'Synthetic topic', note: 'Synthetic note' }],
      };
      await standard(h, request);
      answers(h, 'calm');

      await h.service.directEdit('edit-1');

      const moments = h.repo.edits[0].moments.moments;
      expect(moments.find((m: any) => m.kind === 'drawing')).toMatchObject({
        id: 'd1',
        start_ms: 1000,
        end_ms: 2000,
        label: 'drawing',
        region: { x: 0.1, y: 0.2, w: 0.2, h: 0.1 },
      });
      expect(moments.find((m: any) => m.kind === 'chapter')).toMatchObject({
        id: 'c1',
        start_ms: 2999,
        end_ms: 3000,
        label: 'chapter',
      });
      // the director reads the topic and the drawing as the request has them
      const data = h.editLlm.directEdit.mock.calls[0][1][1].content;
      expect(data).toContain('Topic 1 at 3.0s: "Synthetic topic" (speaker note: Synthetic note)');
      expect(data).toContain('d1 1.0–2.0s');
    });

    it('keeps no text, title or note in the stored moments or in the trace', async () => {
      const h = build();
      await standard(h, {
        ...QUIET,
        chapters: [{ start_ms: 3000, kind: 'text', title: 'Synthetic topic', note: 'Synthetic note' }],
      });
      answers(h);

      await h.service.directEdit('edit-1');

      const allowed = ['id', 'kind', 'start_ms', 'end_ms', 'word_from', 'word_to', 'region', 'label'];
      const stored = h.repo.edits[0].moments;
      expect(Object.keys(stored).sort()).toEqual(['moments', 'source', 'style']);
      for (const m of stored.moments) {
        expect(Object.keys(m).every((key) => allowed.includes(key))).toBe(true);
      }
      const spoken = FIXTURE.words.map((w) => w.text.replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => w.length > 5);
      const traced = JSON.stringify(rows(h, 'direct'));
      for (const text of [JSON.stringify(stored), traced]) {
        expect(text).not.toMatch(/"(text|title|note)":/);
        expect(text).not.toContain('Synthetic');
        for (const word of spoken) {
          expect(text).not.toContain(word);
        }
      }
    });

    it('traces the decision with the style, the source and the count of each label', async () => {
      const h = build();
      await standard(h);
      answers(h);

      await h.service.directEdit('edit-1');

      const stored = h.repo.edits[0].moments.moments;
      const decision = rows(h, 'direct', 'decision').find((r: any) => r.payload.decision === 'direct');
      expect(decision.payload).toEqual({
        decision: 'direct',
        style: 'lively',
        source: 'director',
        counts: { hook: 1, plain: stored.length - 1 },
      });
      expect(rows(h, 'direct', 'input')[0].payload).toMatchObject({ language: 'eng', drawings: 0, chapters: 0 });
    });

    it('stores { source: "none" } when the director fails or refuses, and the edit still gets its plan', async () => {
      const down = build();
      await standard(down);
      down.editLlm.directEdit.mockRejectedValue(new Error('provider down'));
      await down.service.directEdit('edit-1');
      expect(down.repo.edits[0].moments).toEqual({ source: 'none' });
      expect(rows(down, 'direct', 'decision').find((r: any) => r.payload.decision === 'direct').payload).toMatchObject({
        style: null,
        source: 'none',
        counts: {},
        reason_code: 'director_failed',
      });
      await down.service.perceiveEdit('edit-1');
      await down.service.writeEdit('edit-1');
      await down.service.planEdit('edit-1');
      await down.service.finishEdit('edit-1');
      expect(down.repo.edits[0].status).toBe('READY');
      expect(down.repo.edits[0].plan).toBeTruthy();

      const refused = build();
      await standard(refused);
      refused.editLlm.directEdit.mockResolvedValue(null);
      await refused.service.directEdit('edit-1');
      expect(refused.repo.edits[0].moments).toEqual({ source: 'none' });
      expect(
        rows(refused, 'direct', 'decision').find((r: any) => r.payload.decision === 'direct').payload.reason_code
      ).toBe('no_usable_answer');
    });

    it('logs and traces the failure by its class only, never its message', async () => {
      const h = build();
      await standard(h);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      h.editLlm.directEdit.mockRejectedValue(new Error('prompt with Synthetic words'));

      await h.service.directEdit('edit-1');

      expect(warn.mock.calls.map(([text]) => String(text)).join('\n')).not.toContain('Synthetic');
      expect(JSON.stringify(rows(h, 'direct', 'error'))).not.toContain('Synthetic');
      expect(rows(h, 'direct', 'error')).toHaveLength(1);
      warn.mockRestore();
    });

    it('adds the director call to the usage ledger and the usage rows', async () => {
      const h = build();
      await standard(h);
      h.editLlm.directEdit.mockImplementation(async (_option: unknown, _messages: unknown[], usage?: any[]) => {
        usage?.push({
          model: 'muse-spark-1.3-contributor',
          input_tokens: 900,
          output_tokens: 80,
          estimated: false,
          latency_ms: 150,
          ok: true,
        });
        return { style: 'calm', labels: [{ id: 's1', label: 'hook' }] };
      });

      await h.service.directEdit('edit-1');

      const sentences = h.repo.edits[0].moments.moments.filter((m: any) => m.kind === 'sentence').length;
      const row = rows(h, 'usage', 'metric').find((r: any) => r.payload.step === 'direct');
      expect(row.payload).toMatchObject({
        step: 'direct',
        work: `director labels for ${sentences} sentences`,
        model: 'muse-spark-1.3-contributor',
        input_tokens: 900,
        output_tokens: 80,
        total_tokens: 980,
      });
      expect(h.repo.edits[0].log.usage).toMatchObject({
        calls: 1,
        total_input_tokens: 900,
        by_step: { direct: { calls: 1, input_tokens: 900, output_tokens: 80 } },
      });
    });

    it('still joins the usage of a call that failed', async () => {
      const h = build();
      await standard(h);
      h.editLlm.directEdit.mockImplementation(async (_option: unknown, _messages: unknown[], usage?: any[]) => {
        usage?.push({ model: 'muse-spark-1.3-contributor', input_tokens: 0, output_tokens: 0, estimated: true, latency_ms: 90, ok: false });
        throw new Error('refused');
      });

      await h.service.directEdit('edit-1');

      expect(h.repo.edits[0].moments).toEqual({ source: 'none' });
      expect(h.repo.edits[0].log.usage.by_step.direct.calls).toBe(1);
    });

    it('asks the director once: a repeat of the step, or a job already ended, changes nothing', async () => {
      const h = build();
      await standard(h);
      answers(h);

      await h.service.directEdit('edit-1');
      await h.service.directEdit('edit-1');

      expect(h.editLlm.directEdit).toHaveBeenCalledTimes(1);
      expect(skippedWith(h)).toBe('moments_already_kept');

      const ended = build();
      await standard(ended);
      ended.repo.edits[0].status = 'FAILED';
      await ended.service.directEdit('edit-1');
      expect(ended.editLlm.directEdit).not.toHaveBeenCalled();
      expect(ended.repo.edits[0].moments).toBeNull();
    });
  });

  describe('get and quote', () => {
    it('answers 404 EDIT_NOT_FOUND for another workspace\'s edit', async () => {
      const h = build();
      await create(h);

      const err = await failure(h.service.get(OTHER_ORG, 'edit-1'));

      expect(err.getStatus()).toBe(404);
      expect(codeOf(err)).toBe('EDIT_NOT_FOUND');
    });

    it('ends a job that stopped moving on read and gives its credits back', async () => {
      const h = build();
      await create(h);
      h.repo.edits[0].updatedAt = new Date(Date.now() - 4 * 3600 * 1000);

      const view = await h.service.get(ORG, 'edit-1');

      expect(view).toMatchObject({ status: 'FAILED', cost: 0 });
      expect(h.charging.finish).toHaveBeenCalledWith('ai:edit:edit-1', { ok: false }, ORG);
    });

    it('quotes every level for the length', async () => {
      const h = build();

      expect(await h.service.quote(ORG, 200)).toEqual({ basic: 2, standard: 4, heavy: 6 });
      expect(await h.service.quote(ORG, Number.NaN)).toEqual({ basic: 1, standard: 2, heavy: 3 });
    });
  });

  describe('assets in the plan (T5.1)', () => {
    const savedBase = process.env.AI_EDIT_SOUNDS_BASE_URL;

    afterEach(() => {
      if (savedBase === undefined) {
        delete process.env.AI_EDIT_SOUNDS_BASE_URL;
      } else {
        process.env.AI_EDIT_SOUNDS_BASE_URL = savedBase;
      }
    });

    it('lists the sounds the plan uses, and only those, with their urls', async () => {
      process.env.AI_EDIT_SOUNDS_BASE_URL = 'https://cdn.test/sounds/';
      const h = build();
      await create(h, { level: 'standard' });
      await h.service.transcribeEdit('edit-1');

      await h.service.planEdit('edit-1');

      const edit = h.repo.edits[0];
      const used = new Set(edit.plan.items.filter((i: any) => i.sound).map((i: any) => i.sound.id));
      expect(used.size).toBeGreaterThan(0);
      expect(edit.assets.map((a: any) => a.id).sort()).toEqual(Array.from(used).sort());
      expect(edit.assets.every((a: any) => a.kind === 'sound')).toBe(true);
      expect(edit.assets[0].url).toBe(`https://cdn.test/sounds/${edit.assets[0].id}.wav`);
    });

    it('plans no sounds when the server has no sounds base url, and never for Basic', async () => {
      delete process.env.AI_EDIT_SOUNDS_BASE_URL;
      const standard = build();
      await create(standard, { level: 'standard' });
      await standard.service.transcribeEdit('edit-1');
      await standard.service.planEdit('edit-1');
      expect(standard.repo.edits[0].plan.items.some((i: any) => i.sound)).toBe(false);
      expect(standard.repo.edits[0].assets).toEqual([]);

      process.env.AI_EDIT_SOUNDS_BASE_URL = 'https://cdn.test/sounds';
      const basic = build();
      await create(basic);
      await basic.service.transcribeEdit('edit-1');
      await basic.service.planEdit('edit-1');
      expect(basic.repo.edits[0].assets).toEqual([]);
    });

    it('still plans when the resolver fails', async () => {
      const h = build();
      await create(h, { level: 'standard' });
      await h.service.transcribeEdit('edit-1');
      jest.spyOn(h.assets, 'resolve').mockRejectedValue(new Error('storage down'));

      await h.service.planEdit('edit-1');
      await h.service.finishEdit('edit-1');

      const edit = h.repo.edits[0];
      expect(edit.status).toBe('READY');
      expect(edit.plan.items.length).toBeGreaterThan(0);
      expect(edit.assets).toEqual([]);
    });
  });

  // L2: every step leaves rows in the trace, and a trace that fails is never a reason for a step to fail.
  describe('tracing (L2)', () => {
    // The rows written so far as { editId, ...entry }, narrowed by step and kind.
    const rows = (h: Harness, step?: string, kind?: string) =>
      h.trace.record.mock.calls
        .map(([editId, entry]: [string, any]) => ({ editId, ...entry }))
        .filter((r: any) => (!step || r.step === step) && (!kind || r.kind === kind));

    // A decision row of a step by its decision code.
    const decision = (h: Harness, step: string, code: string) =>
      rows(h, step, 'decision').find((r: any) => r.payload.decision === code);

    it.each([
      ['rejects', () => jest.fn().mockRejectedValue(new Error('db down'))],
      [
        'throws at once',
        () =>
          jest.fn(() => {
            throw new Error('boom');
          }),
      ],
    ])('does not fail any step when the trace service %s', async (_name, record) => {
      const h = build({ trace: { record: record() } });
      expect(await create(h, { level: 'standard', proxyUploadIds: [PROXY] })).toMatchObject({
        status: 'PENDING',
      });
      h.clef.isConfigured.mockReturnValue(true);

      await runJob(h, 'edit-1');

      expect(h.repo.edits[0].status).toBe('READY');
      expect(h.repo.edits[0].plan.items.length).toBeGreaterThan(0);
      expect(h.trace.record).toHaveBeenCalled();

      // the failure path too
      const failed = build({ trace: { record: record() } });
      await create(failed);
      await failed.service.failEdit('edit-1', 'A text of ours');
      expect(failed.repo.edits[0]).toMatchObject({ status: 'FAILED', error: 'A text of ours' });
      expect(failed.charging.finish).toHaveBeenCalledWith('ai:edit:edit-1', { ok: false }, ORG);
    });

    it('stores the chapters as sent and traces them as counts only', async () => {
      const h = build();
      const chapters = [
        { start_ms: 0, kind: 'text', title: 'Synthetic title', note: 'Synthetic note' },
        { start_ms: 4000, kind: 'image' },
      ];

      await h.service.create(
        ORG,
        USER,
        { sessionId: SESSION, level: 'basic', audioUploadId: AUDIO, request: { ...REQUEST, chapters } } as any
      );

      expect(h.repo.edits[0].request.chapters).toEqual(chapters);
      const input = rows(h, 'create', 'input')[0];
      expect(input.payload.request.chapters).toEqual({ count: 2, with_title: 1, with_note: 1 });
      expect(JSON.stringify(rows(h))).not.toContain('Synthetic');
    });

    it('writes the create rows with the edit, session, request and hold ids', async () => {
      const h = build();

      await h.service.create(
        ORG,
        USER,
        { sessionId: SESSION, level: 'basic', audioUploadId: AUDIO, request: REQUEST } as any,
        'req-42'
      );

      const input = rows(h, 'create', 'input')[0];
      expect(input.editId).toBe('edit-1');
      expect(input.payload).toMatchObject({
        editId: 'edit-1',
        sessionId: SESSION,
        requestId: 'req-42',
        level: 'basic',
        audioUploadId: AUDIO,
      });
      expect(input.payload.request).toEqual(REQUEST);
      const output = rows(h, 'create', 'output')[0];
      expect(output.payload).toMatchObject({
        status: 'PENDING',
        cost: h.repo.edits[0].cost,
        holdId: 'ledger-1',
        credit_key_id: 'ai:edit:edit-1',
        workflowId: 'ai_video_edit_edit-1',
        requestId: 'req-42',
      });
      expect(decision(h, 'create', 'new_edit')?.payload).toMatchObject({ caption_reuse: false, uploads_accepted: 1 });
    });

    it('traces a repeat of the same recording as a decision on the job it answers', async () => {
      const h = build();
      await create(h);
      await create(h);

      expect(decision(h, 'create', 'repeat')).toMatchObject({ editId: 'edit-1' });
      expect(h.charging.reserve).toHaveBeenCalledTimes(1);
    });

    it('records the input, output and decisions of a Basic job, each row with the edit and session ids', async () => {
      const h = build();
      await create(h);

      await runJob(h, 'edit-1');

      const transcribe = rows(h, 'transcribe', 'output')[0];
      expect(transcribe.payload).toMatchObject({
        source_kind: 'audio',
        provider: 'muse',
        rawWordCount: FIXTURE.words.length,
        wordCount: h.repo.edits[0].words.length,
        noSpeech: false,
        retries: 0,
      });
      expect(transcribe.payload.words).toHaveLength(h.repo.edits[0].words.length);
      expect(transcribe.durationMs).toBeGreaterThanOrEqual(0);
      expect(decision(h, 'transcribe', 'fresh_transcription')).toBeDefined();
      expect(rows(h, 'transcribe', 'input')[0].payload.audio_key).toBe(AUDIO_KEY);
      expect(decision(h, 'settle', 'commit')?.payload.reason_code).toBe('plan_made');
      expect(rows(h, 'settle', 'output').some((r: any) => r.payload.action_kind === 'commit')).toBe(true);
      expect(rows(h, 'settle', 'output').some((r: any) => r.payload.uploads_deleted === 1)).toBe(true);
      // the activity steps end with a duration
      expect(rows(h, 'perceive', 'decision')[0].payload).toMatchObject({ decision: 'skipped', reason_code: 'level_without_perception' });
      expect(rows(h, 'write', 'decision')[0].payload.reason_code).toBe('level_without_writer');
      for (const row of h.trace.record.mock.calls) {
        expect(row[0]).toBe('edit-1');
        expect(row[1].payload).toMatchObject({ editId: 'edit-1', sessionId: SESSION });
      }
    });

    // L3: the planner's decisions reach the trace as rows, and the core stays out of the way of the job.
    it('writes the planner decisions: the structure, a decision per slot and the validator output', async () => {
      const h = build();
      await create(h);

      await runJob(h, 'edit-1');

      const structure = rows(h, 'structure', 'output')[0];
      expect(structure.payload.counts.slots).toBeGreaterThan(0);
      const slotRows = rows(h, 'assemble', 'decision');
      expect(slotRows).toHaveLength(structure.payload.counts.slots);
      for (const row of slotRows) {
        expect(['kept', 'dropped']).toContain(row.payload.decision);
        expect(typeof row.payload.slot_id).toBe('string');
        expect(typeof row.payload.reason_code).toBe('string');
      }
      expect(rows(h, 'assemble', 'output')[0].payload.slots).toBe(slotRows.length);
      expect(rows(h, 'validate', 'output')[0].payload).toMatchObject({ plan_items: h.repo.edits[0].plan.items.length });
      expect(h.repo.edits[0].status).toBe('READY');
    });

    it('records a caption reused as the source of the words, with the decision and why', async () => {
      const h = build();
      h.repo.captions.push({
        id: CAPTION,
        organizationId: ORG,
        status: 'READY',
        audioSeconds: 100,
        segments: [{ startMs: 0, endMs: 5000, text: '', words: FIXTURE.words }],
        language: 'eng',
      });
      await create(h, { audioUploadId: undefined, aiCaptionId: CAPTION });

      await h.service.transcribeEdit('edit-1');

      expect(rows(h, 'transcribe', 'input')[0].payload).toMatchObject({ source_kind: 'caption', aiCaptionId: CAPTION });
      expect(decision(h, 'transcribe', 'caption_reused')?.payload.reason_code).toBe('edit_names_caption');
      expect(rows(h, 'transcribe', 'output')[0].payload).toMatchObject({ source_kind: 'caption', provider: 'caption', language: 'eng' });
      expect(decision(h, 'create', 'new_edit')?.payload.caption_reuse).toBe(true);
    });

    it('records a recording without speech and the credits given back', async () => {
      const h = build({ words: FIXTURE.words.slice(0, 2) });
      await create(h);

      await runJob(h, 'edit-1');

      expect(decision(h, 'transcribe', 'no_speech')?.payload).toMatchObject({ reason_code: 'too_few_words', wordCount: expect.any(Number) });
      expect(decision(h, 'settle', 'release')?.payload.reason_code).toBe('no_speech');
    });

    it('records each piece Clef-omni was asked about, its raw answers and parsed scores', async () => {
      const h = build();
      h.clef.isConfigured.mockReturnValue(true);
      await create(h, { level: 'standard', proxyUploadIds: [PROXY] });
      await h.service.transcribeEdit('edit-1');
      h.clef.ask.mockImplementation(async (_video: Buffer, questions: { id: string }[]) =>
        Object.fromEntries(questions.map((q) => [q.id, q.id === 'mood' ? 'excited' : q.id === 'energy' ? 'high' : 0.9]))
      );

      await h.service.perceiveEdit('edit-1');

      const input = rows(h, 'perceive', 'input').find((r: any) => r.payload.piece === 0);
      expect(input.payload).toMatchObject({ uploadId: PROXY, bytes: Buffer.from('piece').length, model: 'clef-omni' });
      expect(input.payload.questionsHash).toMatch(/^[0-9a-f]{16}$/);
      const piece = rows(h, 'perceive', 'output').find((r: any) => r.payload.piece === 0);
      expect(piece.ok).toBe(true);
      expect(piece.payload.answers.mood).toBe('excited');
      expect(piece.payload.scores).toMatchObject({ mood: 'excited', energy: 1 });
      expect(rows(h, 'perceive', 'output').some((r: any) => r.payload.scores?.mood === 'excited' && r.payload.piece === undefined)).toBe(true);
    });

    it('records a dropped piece with its reason when every call fails, and the fallback to no scores', async () => {
      const h = build();
      h.clef.isConfigured.mockReturnValue(true);
      await create(h, { level: 'standard', proxyUploadIds: [PROXY] });
      await h.service.transcribeEdit('edit-1');
      h.clef.ask.mockRejectedValue(new Error('timeout'));

      await h.service.perceiveEdit('edit-1');

      expect(decision(h, 'perceive', 'piece_dropped')?.payload).toMatchObject({ piece: 0, reason_code: 'all_calls_failed' });
      expect(rows(h, 'perceive', 'output').find((r: any) => r.payload.piece === 0)?.payload.failedCalls).toBeGreaterThan(0);
      expect(decision(h, 'perceive', 'fallback_no_scores')?.payload.reason_code).toBe('no_piece_answered');
    });

    it('records a piece that cannot be read, and why perception was skipped', async () => {
      const h = build();
      h.clef.isConfigured.mockReturnValue(true);
      await create(h, { level: 'standard', proxyUploadIds: [PROXY] });
      await h.service.transcribeEdit('edit-1');
      mockReadObject.mockRejectedValue(new Error('gone'));

      await h.service.perceiveEdit('edit-1');

      expect(decision(h, 'perceive', 'piece_dropped')?.payload.reason_code).toBe('read_failed');
      expect(rows(h, 'perceive', 'error')).toHaveLength(1);

      const off = build();
      await create(off, { level: 'standard', proxyUploadIds: [PROXY] });
      await off.service.transcribeEdit('edit-1');
      await off.service.perceiveEdit('edit-1');
      expect(decision(off, 'perceive', 'skipped')?.payload.reason_code).toBe('clef_not_configured');
    });

    // the director's moments of the fixture's first seconds, on the source timeline (a claim and a chapter)
    const directed = (h: Harness, style = 'calm') => {
      h.repo.edits[0].moments = {
        style,
        source: 'director',
        moments: [
          { id: 's1', kind: 'sentence', start_ms: 1000, end_ms: 3000, word_from: 0, word_to: 5, label: 'claim' },
          { id: 'c1', kind: 'chapter', start_ms: 5000, end_ms: 5001, label: 'chapter' },
        ],
      };
    };

    it('asks the picks of the director moments in the piece and keeps a valid answer', async () => {
      const h = build();
      h.clef.isConfigured.mockReturnValue(true);
      await create(h, { level: 'standard', proxyUploadIds: [PROXY] });
      await h.service.transcribeEdit('edit-1');
      directed(h);
      h.clef.ask.mockImplementation(async (_video: Buffer, questions: { id: string }[]) =>
        Object.fromEntries(
          questions.map((q) => [q.id, q.id === 'pick_s1' ? 'f_hero' : q.id === 'pick_c1' ? 'tr_made_up' : 'calm'])
        )
      );

      await h.service.perceiveEdit('edit-1');

      const asked: { id: string }[] = h.clef.ask.mock.calls.flatMap((c: any[]) => c[1]);
      expect(asked.map((q) => q.id)).toEqual(expect.arrayContaining(['pick_s1', 'pick_c1']));
      const picks = h.repo.edits[0].scores.picks;
      expect(picks.s1).toBe('f_hero');
      // a foreign answer is ignored, so the chapter gets its rotation fallback, a registry id
      expect(picks.c1).toMatch(/^(f_roll|tr_push|tr_dip_color)$/);
      expect(decision(h, 'perceive', 'pick_fallback')?.payload).toMatchObject({ reason_code: 'pick_not_answered', filled: 1 });
      expect(rows(h, 'perceive', 'input').find((r: any) => r.payload.piece === 0).payload.picks).toBe(2);
    });

    it('asks no picks without a director direction', async () => {
      const h = build();
      h.clef.isConfigured.mockReturnValue(true);
      await create(h, { level: 'standard', proxyUploadIds: [PROXY] });
      await h.service.transcribeEdit('edit-1');
      h.repo.edits[0].moments = { source: 'none' };
      h.clef.ask.mockResolvedValue({ mood: 'calm' });

      await h.service.perceiveEdit('edit-1');

      const asked: { id: string }[] = h.clef.ask.mock.calls.flatMap((c: any[]) => c[1]);
      expect(asked.some((q) => q.id.startsWith('pick_'))).toBe(false);
      expect(h.repo.edits[0].scores.picks).toBeUndefined();
      expect(decision(h, 'perceive', 'pick_fallback')).toBeUndefined();
    });

    it('fills the picks from the rotation when Clef-omni is not configured or every call fails', async () => {
      const off = build();
      await create(off, { level: 'standard', proxyUploadIds: [PROXY] });
      await off.service.transcribeEdit('edit-1');
      directed(off);

      await off.service.perceiveEdit('edit-1');

      expect(off.clef.ask).not.toHaveBeenCalled();
      expect(Object.keys(off.repo.edits[0].scores.picks).sort()).toEqual(['c1', 's1']);
      expect(decision(off, 'perceive', 'pick_fallback')?.payload).toMatchObject({ reason_code: 'clef_not_configured', filled: 2 });

      const down = build();
      down.clef.isConfigured.mockReturnValue(true);
      await create(down, { level: 'standard', proxyUploadIds: [PROXY] });
      await down.service.transcribeEdit('edit-1');
      directed(down);
      down.clef.ask.mockRejectedValue(new Error('timeout'));

      await down.service.perceiveEdit('edit-1');

      expect(Object.keys(down.repo.edits[0].scores.picks).sort()).toEqual(['c1', 's1']);
      expect(decision(down, 'perceive', 'fallback_no_scores')?.payload.reason_code).toBe('no_piece_answered');
      expect(decision(down, 'perceive', 'pick_fallback')?.payload).toMatchObject({ reason_code: 'pick_not_answered' });
    });

    it('records the writer call, its raw answer and each text accepted or rejected with the reason', async () => {
      const h = build();
      h.brands.get.mockResolvedValue({ color: '#1E88E5', profile: { schemaVersion: 1, bannedWords: ['Cheap'] } });
      await heavy(h);
      h.editLlm.writeEditTexts.mockResolvedValue({
        slots: [{ id: 'h1', text: 'Cheap hacks inside', icon_query: null }],
      });

      await h.service.writeEdit('edit-1');

      const input = rows(h, 'write', 'input')[0];
      expect(input.payload.bannedWords).toEqual(['Cheap']);
      expect(input.payload.promptVersion).toMatch(/^[0-9a-f]{12}$/);
      expect(input.payload.slots.map((x: any) => x.slot_id)).toContain('h1');
      const output = rows(h, 'write', 'output')[0];
      expect(output.payload.answer).toEqual({ slots: [{ id: 'h1', text: 'Cheap hacks inside', icon_query: null }] });
      const hook = rows(h, 'write', 'decision').find((r: any) => r.payload.slot_id === 'h1');
      expect(hook.payload).toMatchObject({ decision: 'rejected', reason_code: 'banned_word' });
      expect(decision(h, 'write', 'fallback_no_texts')?.payload.reason_code).toBe('no_usable_text');
    });

    it('records a writer that fails as an error row and the fallback, and still ends the step', async () => {
      const h = build();
      await heavy(h);
      h.editLlm.writeEditTexts.mockRejectedValue(new Error('model down'));

      await h.service.writeEdit('edit-1');

      expect(rows(h, 'write', 'error')[0]).toMatchObject({ ok: false });
      expect(decision(h, 'write', 'fallback_no_texts')?.payload.reason_code).toBe('writer_failed');
      expect(h.repo.edits[0].texts).toBeNull();
    });

    it('records the asset queries, what the resolver chose and what became of each slot', async () => {
      const h = build();
      await create(h, { level: 'standard' });
      await h.service.transcribeEdit('edit-1');
      jest.spyOn(h.assets, 'resolve').mockImplementation(async (_input: any, report?: any[]) => {
        report?.push({ slot_id: 's1', query: 'clock', outcome_code: 'cache_hit', candidates: 3, provider_id: 'p-1', asset_id: 'a-1', object_key: 'k.png' });
        report?.push({ slot_id: 's2', query: 'rocket', outcome_code: 'no_candidates', candidates: 0 });
        return { icons: {}, sounds: [], planAssets: [] };
      });

      await h.service.planEdit('edit-1');

      expect(rows(h, 'assets', 'input')[0].payload).toMatchObject({ level: 'standard' });
      expect(rows(h, 'assets', 'output')[0].ok).toBe(true);
      expect(decision(h, 'assets', 'asset_chosen')?.payload).toMatchObject({ slot_id: 's1', outcome_code: 'cache_hit', provider_id: 'p-1' });
      expect(decision(h, 'assets', 'asset_dropped')?.payload).toMatchObject({ slot_id: 's2', outcome_code: 'no_candidates', effect_code: 'no_icon_for_slot' });
      // TS11: one decision on the plan step says why the video got the icons it got, in counts and codes
      const icons = decision(h, 'plan', 'icons')?.payload;
      expect(icons).toMatchObject({ written_queries: 0, found: 0, placed: 0 });
      expect(icons.misses.no_icon_for_slot ?? 0).toBe(icons.searched);
      expect(JSON.stringify(icons)).not.toContain('clock');
    });

    it('records a resolver that fails, with its effect on the plan', async () => {
      const h = build();
      await create(h, { level: 'standard' });
      await h.service.transcribeEdit('edit-1');
      jest.spyOn(h.assets, 'resolve').mockRejectedValue(new Error('storage down'));

      await h.service.planEdit('edit-1');

      expect(rows(h, 'assets', 'error')).toHaveLength(1);
      expect(decision(h, 'assets', 'fallback_no_assets')?.payload).toMatchObject({
        reason_code: 'resolver_failed',
        effect_code: 'plan_without_icons_and_sounds',
      });
      expect(h.repo.edits[0].plan.items.length).toBeGreaterThan(0);
    });

    it('records a workflow that cannot start: the error, the release and the failure beside the text of ours', async () => {
      const h = build();
      h.start.mockRejectedValue(new Error('temporal down'));

      await failure(create(h));

      expect(rows(h, 'create', 'error')).toHaveLength(1);
      expect(decision(h, 'settle', 'release')?.payload.reason_code).toBe('workflow_not_started');
      expect(rows(h, 'fail', 'error')[0].payload).toMatchObject({
        step: 'create',
        client_error: 'The AI edit could not be started.',
        outcome_code: 'failed',
      });
      expect(h.repo.edits[0].log.failure).toMatchObject({ step: 'create', outcome_code: 'failed' });
    });

    describe('the cause of a failure', () => {
      it('is kept in `log` when a step throws, rethrown as it came, and written beside the text of ours by failEdit', async () => {
        const h = build();
        await create(h);
        const thrown = Object.assign(new Error('provider 500 for secret words'), { code: 'E500' });
        h.transcription.transcribe.mockRejectedValue(thrown);

        const err = await failure(h.service.transcribeEdit('edit-1'));

        expect(err).toBe(thrown);
        expect(h.repo.edits[0].log.cause).toMatchObject({
          step: 'transcribe',
          error_class: 'Error',
          error_code: 'E500',
          retryable: true,
        });
        // codes only: no message in the edit's log
        expect(JSON.stringify(h.repo.edits[0].log)).not.toContain('secret words');
        expect(rows(h, 'transcribe', 'error')[0]).toMatchObject({ ok: false });
        expect(rows(h, 'transcribe', 'error')[0].payload.message).toContain('provider 500');

        await h.service.failEdit('edit-1', 'A text of ours');

        const edit = h.repo.edits[0];
        expect(edit).toMatchObject({ status: 'FAILED', error: 'A text of ours' });
        expect(edit.log.cause).toBeUndefined();
        expect(edit.log.failure).toMatchObject({
          step: 'transcribe',
          error_class: 'Error',
          error_code: 'E500',
          retryable: true,
          client_error: 'A text of ours',
          outcome_code: 'failed',
        });
        const fail = rows(h, 'fail', 'error')[0];
        expect(fail.ok).toBe(false);
        expect(fail.payload).toMatchObject({ step: 'transcribe', error_code: 'E500', client_error: 'A text of ours' });
        expect(decision(h, 'settle', 'release')?.payload.reason_code).toBe('no_plan');
      });

      it('says a failure that stopped for good is not retryable, with its type as the code', async () => {
        const h = build();
        await create(h);
        h.transcription.transcribe.mockRejectedValue(new AiCaptionsNotConfigured());

        await failure(h.service.transcribeEdit('edit-1'));

        expect(h.repo.edits[0].log.cause).toMatchObject({
          step: 'transcribe',
          error_code: 'ai_video_edit_stop',
          retryable: false,
        });
      });

      it('keeps a failure no step caught (a timeout) as not recorded, and the plan that was kept as READY', async () => {
        const h = build();
        await create(h);
        await h.service.failEdit('edit-1');
        expect(h.repo.edits[0].log.failure).toMatchObject({
          error_class: 'not_recorded',
          step: null,
          client_error: 'The AI edit could not be made for this recording.',
          outcome_code: 'failed',
        });

        const planned = build();
        await create(planned);
        await planned.service.transcribeEdit('edit-1');
        await planned.service.planEdit('edit-1');
        await planned.service.failEdit('edit-1');
        const edit = planned.repo.edits[0];
        expect(edit.status).toBe('READY');
        // the plan's own log is kept, the failure is added
        expect(edit.log).toMatchObject({ warnings: expect.any(Array), failure: { outcome_code: 'ready_kept', client_error: null } });
        expect(decision(planned, 'settle', 'commit')?.payload.reason_code).toBe('plan_kept_despite_failure');
      });

      it('is replaced by the log of the plan when a retried step then succeeds', async () => {
        const h = build();
        await create(h);
        h.transcription.transcribe.mockRejectedValueOnce(new Error('blip'));
        await failure(h.service.transcribeEdit('edit-1'));
        expect(h.repo.edits[0].log.cause).toBeDefined();

        await h.service.transcribeEdit('edit-1');
        await h.service.planEdit('edit-1');

        expect(h.repo.edits[0].log).toEqual({ warnings: expect.any(Array), rejections: expect.any(Array) });
      });

      it('is removed as soon as the retried step succeeds, so failEdit never reports it for a later failure', async () => {
        const h = build();
        await create(h);
        h.transcription.transcribe.mockRejectedValueOnce(new Error('blip'));
        await failure(h.service.transcribeEdit('edit-1'));
        expect(h.repo.edits[0].log.cause).toMatchObject({ step: 'transcribe' });

        await h.service.transcribeEdit('edit-1');

        expect(h.repo.edits[0].log?.cause).toBeUndefined();

        // a failure no step caught (a timeout) is then not blamed on the older attempt
        await h.service.failEdit('edit-1');
        expect(h.repo.edits[0].log.failure).toMatchObject({ step: null, error_class: 'not_recorded' });
      });

      it('keeps the other keys of `log` when it is removed', async () => {
        const h = build();
        await create(h);
        await h.service.transcribeEdit('edit-1');
        h.repo.edits[0].log = { warnings: ['w'], cause: { step: 'perceive', error_class: 'Error', error_code: null, retryable: true } };

        await h.service.perceiveEdit('edit-1');

        expect(h.repo.edits[0].log).toEqual({ warnings: ['w'] });
      });
    });

    describe('a trace that hangs', () => {
      afterEach(() => jest.useRealTimers());

      it('delays no step by more than its time limit and fails none', async () => {
        const record = jest.fn().mockResolvedValue(undefined);
        const h = build({ trace: { record } });
        await create(h);
        // from here on every trace write never ends
        record.mockImplementation(() => new Promise(() => undefined));
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        let done = false;
        const run = (async () => {
          await h.service.failEdit('edit-1', 'A text of ours');
          done = true;
        })();

        for (let i = 0; i < 20 && !done; i++) {
          await jest.advanceTimersByTimeAsync(2000);
        }
        await run;

        expect(done).toBe(true);
        expect(h.repo.edits[0]).toMatchObject({ status: 'FAILED', error: 'A text of ours' });
      });
    });
  });

  // L4: the body the phone is served is stored once and traced, its serves are logged, and the plan is checked for the
  // phone before it is delivered.
  describe('delivered snapshot, serve log and client check (L4)', () => {
    const savedBase = process.env.AI_EDIT_SOUNDS_BASE_URL;
    let nowSpy: jest.SpyInstance | undefined;

    afterEach(() => {
      nowSpy?.mockRestore();
      nowSpy = undefined;
      if (savedBase === undefined) {
        delete process.env.AI_EDIT_SOUNDS_BASE_URL;
      } else {
        process.env.AI_EDIT_SOUNDS_BASE_URL = savedBase;
      }
    });

    // The rows written so far as { editId, ...entry }, narrowed by step and kind.
    const rows = (h: Harness, step: string, kind?: string) =>
      h.trace.record.mock.calls
        .map(([editId, entry]: [string, any]) => ({ editId, ...entry }))
        .filter((r: any) => r.step === step && (!kind || r.kind === kind));

    const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

    // A Standard job with the sounds on, planned and finished.
    const standardJob = async (h: Harness) => {
      process.env.AI_EDIT_SOUNDS_BASE_URL = 'https://cdn.test/sounds/';
      await create(h, { level: 'standard' });
      await h.service.transcribeEdit('edit-1');
      await h.service.planEdit('edit-1');
    };

    describe('the delivered snapshot', () => {
      it('stores the READY body once and serves exactly it', async () => {
        const h = build();
        await create(h);

        await runJob(h, 'edit-1');

        const edit = h.repo.edits[0];
        expect(edit.delivered).toEqual({ id: 'edit-1', status: 'READY', cost: 1, plan: edit.plan, assets: [] });
        expect(await h.service.get(ORG, 'edit-1')).toBe(edit.delivered);
      });

      it('serves the stored body even when the plan column changed after it', async () => {
        const h = build();
        await create(h);
        await runJob(h, 'edit-1');
        const body = h.repo.edits[0].delivered;
        h.repo.edits[0].plan = { ...h.repo.edits[0].plan, warnings: ['changed'] };

        expect(await h.service.get(ORG, 'edit-1')).toEqual(body);
      });

      it('builds the same body from the plan and assets for an edit made before it was stored', async () => {
        const h = build();
        await create(h);
        await runJob(h, 'edit-1');
        const stored = await h.service.get(ORG, 'edit-1');
        h.repo.edits[0].delivered = null;

        expect(await h.service.get(ORG, 'edit-1')).toEqual(stored);
      });

      it('traces the delivered body with its hash, size and versions', async () => {
        const h = build();
        await create(h);

        await runJob(h, 'edit-1');

        const [row] = rows(h, 'deliver', 'output');
        const body = h.repo.edits[0].delivered;
        expect(row.payload).toMatchObject({
          sha256: sha(body),
          bytes: Buffer.byteLength(JSON.stringify(body)),
          contract_version: 2,
          plan_version: 1,
          plan_items: body.plan.items.length,
          assets_count: 0,
          delivered: body,
        });
        expect(row.editId).toBe('edit-1');
      });

      it('stores nothing for a job that ended without a plan', async () => {
        const h = build({ words: FIXTURE.words.slice(0, 2) });
        await create(h);

        await runJob(h, 'edit-1');

        expect(h.repo.edits[0].delivered ?? null).toBeNull();
        expect(rows(h, 'deliver')).toHaveLength(0);
      });
    });

    describe('the serve log', () => {
      // The serve rows (metrics), apart from the output row of the snapshot.
      const serves = (h: Harness) => rows(h, 'deliver', 'metric');

      it('logs the first serve with the app version, the hash and the size of the body', async () => {
        const h = build();
        await create(h);
        await runJob(h, 'edit-1');

        const body = await h.service.get(ORG, 'edit-1', '1.4.2');

        expect(serves(h)).toHaveLength(1);
        expect(serves(h)[0].payload).toMatchObject({
          first_serve: true,
          app_version: '1.4.2',
          served_sha256: sha(body),
          bytes: Buffer.byteLength(JSON.stringify(body)),
          editId: 'edit-1',
        });
        expect(serves(h)[0].payload.served_at_ms).toEqual(expect.any(Number));
      });

      it('logs a serve without an app version as null', async () => {
        const h = build();
        await create(h);
        await runJob(h, 'edit-1');

        await h.service.get(ORG, 'edit-1');

        expect(serves(h)[0].payload.app_version).toBeNull();
      });

      it('logs at most one serve a minute per edit, then again', async () => {
        const h = build();
        await create(h);
        await runJob(h, 'edit-1');
        const now = (nowSpy = jest.spyOn(Date, 'now'));
        const start = Date.now();

        now.mockReturnValue(start);
        await h.service.get(ORG, 'edit-1');
        now.mockReturnValue(start + 30_000);
        await h.service.get(ORG, 'edit-1');
        now.mockReturnValue(start + 59_000);
        await h.service.get(ORG, 'edit-1');
        expect(serves(h)).toHaveLength(1);

        now.mockReturnValue(start + 61_000);
        await h.service.get(ORG, 'edit-1');
        expect(serves(h)).toHaveLength(2);
        expect(serves(h)[1].payload.first_serve).toBe(false);
      });

      it('keeps the limit per edit', async () => {
        const h = build();
        await create(h);
        await runJob(h, 'edit-1');
        const second = await h.service.create(ORG, USER, {
          sessionId: '3f1d1c9e-6f0a-4c55-9a39-0d3c6f1f8a12',
          level: 'basic',
          audioUploadId: AUDIO,
          request: REQUEST,
        } as any);
        await runJob(h, second.id);

        await h.service.get(ORG, 'edit-1');
        await h.service.get(ORG, second.id);
        await h.service.get(ORG, 'edit-1');

        expect(serves(h).map((r: any) => r.editId)).toEqual(['edit-1', second.id]);
      });

      it('logs nothing for an edit that is not READY and nothing for another workspace', async () => {
        const h = build();
        await create(h);

        await h.service.get(ORG, 'edit-1');
        await failure(h.service.get(OTHER_ORG, 'edit-1'));

        expect(serves(h)).toHaveLength(0);
      });

      it.each([
        ['rejects', () => jest.fn().mockRejectedValue(new Error('db down'))],
        ['throws at once', () => jest.fn(() => { throw new Error('boom'); })],
      ])('still serves the body when the trace %s', async (_name, record) => {
        const h = build({ trace: { record: record() } });
        await create(h);
        await runJob(h, 'edit-1');

        const body = await h.service.get(ORG, 'edit-1');

        expect(body).toMatchObject({ id: 'edit-1', status: 'READY' });
      });
    });

    describe('the client check', () => {
      it('finds nothing in a Basic plan, writes the summary row and leaves `log` as the planner wrote it', async () => {
        const h = build();
        await create(h);

        await runJob(h, 'edit-1');

        expect(rows(h, 'client_check', 'output')[0].payload).toMatchObject({ findings: 0, errors: 0, warnings: 0, unusable: false });
        expect(rows(h, 'client_check', 'decision')).toHaveLength(0);
        expect(h.repo.edits[0].log).toEqual({ warnings: [], rejections: [] });
      });

      it('checks the plan before the credits are committed', async () => {
        const h = build();
        await create(h);
        await h.service.transcribeEdit('edit-1');
        await h.service.planEdit('edit-1');
        h.trace.record.mockClear();

        await h.service.finishEdit('edit-1');

        const order = h.trace.record.mock.calls.map(([, entry]: [string, any]) => `${entry.step}/${entry.kind}`);
        expect(order.indexOf('client_check/output')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('client_check/output')).toBeLessThan(order.indexOf('settle/output'));
      });

      it('traces an unreachable asset as a finding, keeps it in `log.client_check` and still delivers', async () => {
        const h = build();
        await standardJob(h);
        const probe = jest
          .spyOn(h.assets, 'probe')
          .mockImplementation(async (assets) =>
            assets.map((a) => ({ id: a.id, ok: false, status: 404, reason_code: 'bad_status' as const }))
          );

        await h.service.finishEdit('edit-1');

        const edit = h.repo.edits[0];
        expect(probe).toHaveBeenCalledWith(edit.assets);
        expect(edit.assets.length).toBeGreaterThan(0);
        expect(edit.status).toBe('READY');
        expect(edit.delivered).toMatchObject({ status: 'READY' });
        const lints = rows(h, 'client_check', 'decision').filter((r: any) => r.payload.reason_code === 'asset_unreachable');
        expect(lints.map((r: any) => r.payload.item_id).sort()).toEqual(edit.assets.map((a: any) => a.id).sort());
        expect(rows(h, 'client_check', 'output')[0].payload).toMatchObject({ unusable: false });
        expect(edit.log.client_check).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'asset_unreachable', severity: 'warning' })])
        );
        // the planner's own keys are kept
        expect(edit.log).toMatchObject({ warnings: expect.any(Array), rejections: expect.any(Array) });
      });

      it('delivers when the asset check itself fails', async () => {
        const h = build();
        await standardJob(h);
        jest.spyOn(h.assets, 'probe').mockRejectedValue(new Error('network down'));

        await h.service.finishEdit('edit-1');

        expect(h.repo.edits[0].status).toBe('READY');
        expect(h.repo.edits[0].delivered).toBeDefined();
      });

      it('keeps the words of the plan out of the findings', async () => {
        const h = build();
        await standardJob(h);
        jest.spyOn(h.assets, 'probe').mockResolvedValue([]);
        const item = h.repo.edits[0].plan.items.find((i: any) => i.component?.type === 'styled_text');
        expect(item).toBeDefined();
        item.component.text = 'ZZQX UNIQUE MARKER TEXT HERE';
        item.component.style_preset = 'label_pill';

        await h.service.finishEdit('edit-1');

        const log = h.repo.edits[0].log.client_check;
        expect(log).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'text_may_wrap', item_id: item.id })]));
        expect(JSON.stringify([rows(h, 'client_check'), log])).not.toContain('ZZQX');
      });

      describe('a plan the phone cannot draw (an unknown look)', () => {
        const saved = process.env.AI_EDIT_CLIENT_CHECK_BLOCK;
        afterEach(() => {
          if (saved === undefined) {
            delete process.env.AI_EDIT_CLIENT_CHECK_BLOCK;
          } else {
            process.env.AI_EDIT_CLIENT_CHECK_BLOCK = saved;
          }
        });

        const unusablePlan = async () => {
          const h = build();
          await create(h);
          await h.service.transcribeEdit('edit-1');
          await h.service.planEdit('edit-1');
          jest.spyOn(h.assets, 'probe').mockResolvedValue([]);
          const item = h.repo.edits[0].plan.items.find((i: any) => i.component?.type === 'styled_text');
          expect(item).toBeDefined();
          item.component.style_preset = 'neon';
          return { h, item };
        };

        it.each([[undefined], [''], ['0'], ['true']])(
          'delivers it and keeps the finding when AI_EDIT_CLIENT_CHECK_BLOCK is %p (the default)',
          async (value) => {
            if (value === undefined) {
              delete process.env.AI_EDIT_CLIENT_CHECK_BLOCK;
            } else {
              process.env.AI_EDIT_CLIENT_CHECK_BLOCK = value;
            }
            const { h, item } = await unusablePlan();

            await h.service.finishEdit('edit-1');

            const edit = h.repo.edits[0];
            expect(edit.status).toBe('READY');
            expect(edit.delivered).toMatchObject({ status: 'READY' });
            expect(h.charging.finish).toHaveBeenCalledWith('ai:edit:edit-1', { ok: true }, ORG);
            expect(edit.log.client_check).toEqual(
              expect.arrayContaining([expect.objectContaining({ code: 'unknown_style', item_id: item.id, severity: 'error' })])
            );
            expect(edit.log.failure).toBeUndefined();
            expect(rows(h, 'client_check', 'output')[0].payload).toMatchObject({ unusable: true, blocking: false });
            expect(rows(h, 'fail', 'error')).toHaveLength(0);
            expect(await h.service.get(ORG, 'edit-1')).toMatchObject({ id: 'edit-1', status: 'READY' });
          }
        );

        it('does not deliver it when AI_EDIT_CLIENT_CHECK_BLOCK=1: credits back, FAILED, findings kept', async () => {
          process.env.AI_EDIT_CLIENT_CHECK_BLOCK = '1';
          const { h, item } = await unusablePlan();

          await h.service.finishEdit('edit-1');

          const edit = h.repo.edits[0];
          expect(edit.status).toBe('FAILED');
          expect(edit.error).toBe('The AI edit could not be made for this recording.');
          expect(edit.delivered ?? null).toBeNull();
          expect(h.charging.finish).toHaveBeenCalledTimes(1);
          expect(h.charging.finish).toHaveBeenCalledWith('ai:edit:edit-1', { ok: false }, ORG);
          expect(edit.log.client_check).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: 'unknown_style', item_id: item.id, severity: 'error' })])
          );
          expect(edit.log.failure).toMatchObject({ step: 'client_check', error_code: 'unknown_style', outcome_code: 'failed' });
          expect(rows(h, 'client_check', 'output')[0].payload).toMatchObject({ unusable: true, blocking: true });
          expect(rows(h, 'fail', 'error')).toHaveLength(1);
          expect(await h.service.get(ORG, 'edit-1')).toEqual({
            id: 'edit-1',
            status: 'FAILED',
            error: 'The AI edit could not be made for this recording.',
            cost: 0,
          });
        });
      });
    });
  });
  // L7: the LLM usage ledger. Each call is a `usage/metric` row and the calls add up in `log.usage`; a provider stand-in
  // reports its usage through the array the service hands it, as the real clients do.
  describe('the LLM usage ledger (L7)', () => {
    const rows = (h: Harness, step: string, kind?: string) =>
      h.trace.record.mock.calls
        .map(([editId, entry]: [string, any]) => ({ editId, ...entry }))
        .filter((r: any) => r.step === step && (!kind || r.kind === kind));

    // What a stand-in call used.
    const used = (model: string, input: number, output: number, extra: Record<string, unknown> = {}) => ({
      model,
      input_tokens: input,
      output_tokens: output,
      estimated: false,
      latency_ms: 120,
      ok: true,
      ...extra,
    });

    // A Heavy job whose providers all report usage, up to the plan.
    const heavyWithUsage = async (h: Harness) => {
      (h.transcription as any).model = 'scribe_v2';
      h.clef.isConfigured.mockReturnValue(true);
      h.clef.ask.mockImplementation(async (_video: Buffer, _questions: unknown[], usage?: unknown[]) => {
        usage?.push(used('@cf/cloudflare/clef-omni', 400, 20, { estimated: true }));
        return {};
      });
      h.editLlm.writeEditTexts.mockImplementation(
        async (_option: unknown, _messages: unknown[], usage?: unknown[]) => {
          usage?.push(used('gpt-5.1', 1200, 300, { cached_tokens: 100 }));
          return { slots: [{ id: 'h1', text: 'Stop wasting hours', icon_query: null }] };
        }
      );
      jest.spyOn(h.assets, 'resolve').mockImplementation(async (_input: unknown, _report?: unknown, usage?: any) => {
        usage?.push(used('gpt-5.1', 600, 40, { work: 'icon pick for 2 slots' }));
        return { icons: {}, sounds: [], planAssets: [] };
      });
      await create(h, { level: 'heavy', proxyUploadIds: [PROXY] });
      await h.service.transcribeEdit('edit-1');
      await h.service.perceiveEdit('edit-1');
      await h.service.writeEdit('edit-1');
      await h.service.planEdit('edit-1');
    };

    afterEach(() => jest.restoreAllMocks());

    it('records one usage row per call with the step, the work, the model, the tokens and the attempt', async () => {
      const h = build();

      await heavyWithUsage(h);

      const write = rows(h, 'usage', 'metric').find((r: any) => r.payload.step === 'write');
      const asked = rows(h, 'write', 'input')[0].payload.slots.length;
      expect(write.ok).toBe(true);
      expect(write.payload).toMatchObject({
        editId: 'edit-1',
        sessionId: SESSION,
        step: 'write',
        work: `writer texts for ${asked} slots`,
        model: 'gpt-5.1',
        input_tokens: 1200,
        output_tokens: 300,
        total_tokens: 1500,
        cached_tokens: 100,
        estimated: false,
        latency_ms: 120,
        ok: true,
      });
      const speech = rows(h, 'usage', 'metric').find((r: any) => r.payload.step === 'transcribe');
      expect(speech.payload).toMatchObject({ model: 'scribe_v2', work: 'speech to text 150 s', audio_seconds: 150, ok: true });
      expect(speech.payload.input_tokens).toBeUndefined();
      const pick = rows(h, 'usage', 'metric').find((r: any) => r.payload.step === 'assets');
      expect(pick.payload).toMatchObject({ work: 'icon pick for 2 slots', total_tokens: 640 });
      const piece = rows(h, 'usage', 'metric').find((r: any) => r.payload.step === 'perceive');
      expect(piece.payload).toMatchObject({ work: 'perception of slot piece 0', estimated: true, model: '@cf/cloudflare/clef-omni' });
    });

    it('adds the calls up in log.usage by step and by model, and the plan keeps it', async () => {
      const h = build();

      await heavyWithUsage(h);

      const clefCalls = h.clef.ask.mock.calls.length;
      expect(clefCalls).toBeGreaterThan(0);
      const log = h.repo.edits[0].log;
      expect(log.warnings).toEqual(expect.any(Array));
      expect(log.rejections).toEqual(expect.any(Array));
      expect(log.usage).toEqual({
        calls: clefCalls + 3,
        total_input_tokens: 400 * clefCalls + 1200 + 600,
        total_output_tokens: 20 * clefCalls + 300 + 40,
        total_audio_seconds: 150,
        estimated_calls: clefCalls,
        by_step: {
          transcribe: { calls: 1, input_tokens: 0, output_tokens: 0, audio_seconds: 150 },
          perceive: { calls: clefCalls, input_tokens: 400 * clefCalls, output_tokens: 20 * clefCalls },
          write: { calls: 1, input_tokens: 1200, output_tokens: 300 },
          assets: { calls: 1, input_tokens: 600, output_tokens: 40 },
        },
        by_model: {
          scribe_v2: { calls: 1, input_tokens: 0, output_tokens: 0, audio_seconds: 150 },
          '@cf/cloudflare/clef-omni': { calls: clefCalls, input_tokens: 400 * clefCalls, output_tokens: 20 * clefCalls },
          'gpt-5.1': { calls: 2, input_tokens: 1800, output_tokens: 340 },
        },
      });
    });

    it('writes the usage/output summary and one structured log line when the job is finished', async () => {
      const h = build();
      const line = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await heavyWithUsage(h);

      await h.service.finishEdit('edit-1');

      const summary = rows(h, 'usage', 'output');
      expect(summary).toHaveLength(1);
      expect(summary[0].payload).toMatchObject({
        editId: 'edit-1',
        sessionId: SESSION,
        calls: h.repo.edits[0].log.usage.calls,
        total_input_tokens: h.repo.edits[0].log.usage.total_input_tokens,
        by_step: { write: { calls: 1, input_tokens: 1200, output_tokens: 300 } },
      });
      const logged = line.mock.calls.map(([text]) => String(text)).filter((text) => text.startsWith('ai_edit_usage '));
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0].slice('ai_edit_usage '.length))).toMatchObject({
        editId: 'edit-1',
        sessionId: SESSION,
        calls: h.repo.edits[0].log.usage.calls,
        by_model: { 'gpt-5.1': { calls: 2 } },
      });
      expect(h.repo.edits[0].status).toBe('READY');
      expect(h.repo.edits[0].log.usage).toBeDefined();
    });

    it('sums the ledger up once when the last step is repeated', async () => {
      const h = build();
      const line = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await heavyWithUsage(h);

      await h.service.finishEdit('edit-1');
      const calls = h.repo.edits[0].log.usage.calls;
      await h.service.finishEdit('edit-1');

      expect(rows(h, 'usage', 'output')).toHaveLength(1);
      expect(line.mock.calls.filter(([text]) => String(text).startsWith('ai_edit_usage '))).toHaveLength(1);
      expect(h.repo.edits[0].log.usage.calls).toBe(calls);
    });

    it('keeps the ledger when the job fails, and sums it up once', async () => {
      const h = build();
      (h.transcription as any).model = 'scribe_v2';
      await create(h);
      await h.service.transcribeEdit('edit-1');

      await h.service.failEdit('edit-1', 'A text of ours');

      expect(h.repo.edits[0].log.usage).toMatchObject({ calls: 1, total_audio_seconds: 150 });
      expect(h.repo.edits[0].log.failure).toBeDefined();
      expect(rows(h, 'usage', 'output')).toHaveLength(1);
    });

    it('adds nothing to a job that made no LLM call: the log stays as the planner wrote it', async () => {
      const h = build();
      await create(h);

      await runJob(h, 'edit-1');

      expect(rows(h, 'usage')).toHaveLength(0);
      expect(h.repo.edits[0].log).toEqual({ warnings: [], rejections: [] });
    });

    it('marks a call without provider usage as estimated', async () => {
      const h = build();
      await heavyWithUsage(h);

      const estimated = rows(h, 'usage', 'metric').filter((r: any) => r.payload.estimated);
      expect(estimated.length).toBe(h.clef.ask.mock.calls.length);
      expect(h.repo.edits[0].log.usage.estimated_calls).toBe(estimated.length);
      expect(rows(h, 'usage', 'metric').find((r: any) => r.payload.step === 'write').payload.estimated).toBe(false);
    });

    it('records a failed call and its retry as a row each, with the activity attempt', async () => {
      const h = build();
      (h.transcription as any).model = 'scribe_v2';
      let attempt = 1;
      jest.spyOn(Context, 'current').mockImplementation(
        () => ({ info: { attempt, workflowExecution: { workflowId: 'wf-1', runId: 'run-1' } } }) as any
      );
      await create(h);
      h.transcription.transcribe.mockRejectedValueOnce(new Error('blip'));
      await failure(h.service.transcribeEdit('edit-1'));
      attempt = 2;

      await h.service.transcribeEdit('edit-1');

      const speech = rows(h, 'usage', 'metric');
      expect(speech.map((r: any) => [r.payload.attempt, r.ok, r.payload.work])).toEqual([
        [1, false, 'speech to text attempt'],
        [2, true, 'speech to text 150 s'],
      ]);
      expect(h.repo.edits[0].log.usage.by_step.transcribe).toEqual({ calls: 2, input_tokens: 0, output_tokens: 0, audio_seconds: 150 });
    });

    it('ledgers a failed provider call (a writer that throws) and still falls back to no texts', async () => {
      const h = build();
      await heavy(h);
      h.editLlm.writeEditTexts.mockImplementation(
        async (_option: unknown, _messages: unknown[], usage?: unknown[]) => {
          usage?.push(used('gpt-5.1', 900, 0, { ok: false, estimated: true }));
          throw new Error('provider 500');
        }
      );

      await h.service.writeEdit('edit-1');

      const row = rows(h, 'usage', 'metric')[0];
      expect(row).toMatchObject({ ok: false });
      expect(row.payload).toMatchObject({ step: 'write', input_tokens: 900, estimated: true, ok: false });
      expect(h.repo.edits[0].log.usage.by_step.write).toEqual({ calls: 1, input_tokens: 900, output_tokens: 0 });
      expect(h.repo.edits[0].texts).toBeNull();
    });

    it.each([
      ['the usage rows cannot be written', (h: Harness) => h.trace.record.mockRejectedValue(new Error('db down'))],
      [
        'the ledger cannot be kept in the job',
        (h: Harness) => {
          const update = h.repo.updateEdit;
          jest.spyOn(h.repo, 'updateEdit').mockImplementation(async (org: string, id: string, data: any) => {
            if (data?.log?.usage && !data?.log?.warnings) {
              throw new Error('db down');
            }
            return update(org, id, data);
          });
        },
      ],
    ])('never fails a step when %s', async (_name, breakIt) => {
      const h = build();
      breakIt(h);

      await heavyWithUsage(h);
      await h.service.finishEdit('edit-1');

      expect(h.repo.edits[0].status).toBe('READY');
      expect(h.repo.edits[0].texts).toBeTruthy();
    });

    it('puts no text of the job in any usage row: only ids, codes, labels and numbers', async () => {
      const h = build();
      h.brands.get.mockResolvedValue({ color: '#1E88E5', profile: { schemaVersion: 1, voice: 'Bold and warm', bannedWords: ['cheap'] } });
      const line = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await heavyWithUsage(h);
      await h.service.finishEdit('edit-1');

      const label = /^(speech to text (\d+ s|attempt)|perception( commentary)? of slot piece \d+|writer texts for \d+ slots|icon pick for \d+ slots)$/;
      for (const row of rows(h, 'usage')) {
        for (const [key, value] of Object.entries(row.payload)) {
          if (typeof value === 'string') {
            expect(['editId', 'sessionId', 'workflowId', 'runId', 'step', 'work', 'model']).toContain(key);
          }
        }
        if (row.payload.work) {
          expect(row.payload.work).toMatch(label);
        }
      }
      const everything = JSON.stringify([rows(h, 'usage'), line.mock.calls, h.repo.edits[0].log.usage]);
      for (const word of ['Stop wasting hours', 'Bold and warm', 'cheap']) {
        expect(everything).not.toContain(word);
      }
    });
  });
});
