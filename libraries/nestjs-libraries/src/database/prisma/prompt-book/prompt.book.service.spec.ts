// ai.video-captions (Prompt Book): the book's rules. The defaults file is checked on its own; the service
// and repository run against a real Postgres on both database roles (the contract's access is "both"):
// the resolve chain, a seed that never overwrites, locked and unknown keys refused, and one workspace
// never reading another's text.
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  PrismaRepository,
  PrismaService,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { PromptBookRepository } from '@gitroom/nestjs-libraries/database/prisma/prompt-book/prompt.book.repository';
import { PromptBookService } from '@gitroom/nestjs-libraries/database/prisma/prompt-book/prompt.book.service';
import {
  PROMPT_BOOK_DEFAULTS,
  PROMPT_BOOK_MODEL,
} from '@gitroom/nestjs-libraries/database/prisma/prompt-book/prompt.book.defaults';
import { AUTO_DEFAULTS } from '@gitroom/nestjs-libraries/integrations/auto.publish.defaults';
import {
  PROMPT_BODY_MAX_LENGTH,
  PROMPT_FRAME_PLACEHOLDERS,
} from '@gitroom/nestjs-libraries/dtos/prompt-book/save.prompt.dto';

const url = process.env.TEST_DATABASE_URL;
const apiUrl = process.env.TEST_DATABASE_API_URL;
const describeDb = url && apiUrl ? describe : describe.skip;

// The error a call rejects with, or undefined when it resolves.
const failure = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (err) {
    return err as HttpException;
  }
  return undefined;
};

describe('ai.video-captions: the defaults file', () => {
  it('has unique keys, and the locked frames are the only locked prompts', () => {
    const keys = PROMPT_BOOK_DEFAULTS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      PROMPT_BOOK_DEFAULTS.filter((entry) => entry.locked).map((entry) => entry.key)
    ).toEqual(['captions.frame.video', 'captions.frame.text']);
  });

  it('keeps the key, the group and the provider of each entry in step', () => {
    for (const entry of PROMPT_BOOK_DEFAULTS) {
      if (entry.group === 'general') {
        expect(entry.key).toBe('captions.general');
      } else if (entry.group === 'frame') {
        expect(entry.key).toMatch(/^captions\.frame\.(video|text)$/);
        expect(entry.locked).toBe(true);
      } else {
        expect(entry.key).toBe(`captions.${entry.group}.${entry.provider ?? 'default'}`);
      }
    }
  });

  it('has a default for each group, so every platform key has a family to fall back to', () => {
    const keys = PROMPT_BOOK_DEFAULTS.map((entry) => entry.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'captions.frame.video',
        'captions.frame.text',
        'captions.general',
        'captions.video.default',
        'captions.text.default',
      ])
    );
  });

  it('names only providers that publish a video in automatic mode for a video caption', () => {
    for (const entry of PROMPT_BOOK_DEFAULTS.filter(
      (candidate) => candidate.group === 'video' && candidate.provider
    )) {
      expect(Object.keys(AUTO_DEFAULTS)).toContain(entry.provider);
    }
  });

  it('puts every placeholder of the generator into both frames', () => {
    for (const key of ['captions.frame.video', 'captions.frame.text']) {
      const body = PROMPT_BOOK_DEFAULTS.find((entry) => entry.key === key)!.body;
      for (const name of PROMPT_FRAME_PLACEHOLDERS) {
        expect(body).toContain(`{{${name}}}`);
      }
    }
  });

  it('keeps every editable default within what a workspace may save', () => {
    for (const entry of PROMPT_BOOK_DEFAULTS.filter((candidate) => !candidate.locked)) {
      expect(entry.body.length).toBeGreaterThan(0);
      expect(entry.body.length).toBeLessThanOrEqual(PROMPT_BODY_MAX_LENGTH);
    }
  });

  it('tells every text post never to point at the video', () => {
    for (const entry of PROMPT_BOOK_DEFAULTS.filter((candidate) => candidate.group === 'text')) {
      expect(entry.body).toMatch(/never (mention a video|tell the reader to watch the video)/i);
    }
  });
});

describeDb('ai.video-captions: PromptBookService (Postgres)', () => {
  let worker: PrismaClient;
  let apiPrisma: PrismaService;
  const saved = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = apiUrl;
    apiPrisma = new PrismaService();
    await apiPrisma.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
  });

  afterAll(async () => {
    if (saved === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = saved;
    }
    await apiPrisma.$disconnect();
    await worker.$disconnect();
  });

  // A workspace, made through the worker client.
  const newWorkspace = async () => {
    const user = await worker.user.create({
      data: {
        email: randomUUID() + '@test.local',
        providerName: 'LOCAL',
        password: 'x',
        activated: true,
        timezone: 0,
      },
    });
    const org = await worker.organization.create({
      data: {
        name: 'ws-' + randomUUID(),
        users: { create: { role: 'SUPERADMIN', userId: user.id } },
      },
    });
    return { userId: user.id, orgId: org.id };
  };

  // The newest stored default of a key, read through the worker client.
  const storedDefault = (key: string) =>
    worker.promptDefault.findFirstOrThrow({
      where: { key },
      orderBy: { version: 'desc' },
    });

  describe.each([
    ['API role', () => apiPrisma],
    ['worker role', () => worker],
  ])('on the %s', (_role, client) => {
    // The service wired to the role's client.
    const service = () =>
      new PromptBookService(
        new PromptBookRepository(
          new PrismaRepository<any>(client() as any),
          new PrismaRepository<any>(client() as any)
        )
      );

    beforeAll(async () => {
      await service().seed();
    });

    describe('seed', () => {
      it('stores version 1 of a key that has no default, from the defaults file, on the default model', async () => {
        await worker.promptDefault.deleteMany({ where: { key: 'captions.text.nostr' } });

        const created = await service().seed();

        expect(created).toEqual(['captions.text.nostr']);
        const entry = PROMPT_BOOK_DEFAULTS.find((e) => e.key === 'captions.text.nostr')!;
        const row = await storedDefault('captions.text.nostr');
        expect(row).toMatchObject({
          version: 1,
          body: entry.body,
          model: PROMPT_BOOK_MODEL,
          settings: { reasoningEffort: 'minimal' },
          createdById: null,
        });
      });

      it('never overwrites or adds a version to a key that has a default, an owner edit included', async () => {
        const { userId } = await newWorkspace();
        const edited = await service().saveDefault(userId, {
          key: 'captions.text.nostr',
          body: 'Owner text',
          model: 'gpt-5-mini',
        });

        const created = await service().seed();

        expect(created).toEqual([]);
        const row = await storedDefault('captions.text.nostr');
        expect(row).toMatchObject({
          version: edited.version,
          body: 'Owner text',
          model: 'gpt-5-mini',
        });
        expect(
          await worker.promptDefault.count({ where: { key: 'captions.text.nostr' } })
        ).toBe(edited.version);
        await worker.promptDefault.deleteMany({ where: { key: 'captions.text.nostr' } });
        await service().seed();
      });

      it('stores a default for every key of the file', async () => {
        const rows = await worker.promptDefault.findMany({ select: { key: true } });
        const stored = new Set(rows.map((row) => row.key));
        for (const entry of PROMPT_BOOK_DEFAULTS) {
          expect(stored.has(entry.key)).toBe(true);
        }
      });
    });

    describe('resolve', () => {
      it('answers the default of the key while the workspace has no text of its own', async () => {
        const { orgId } = await newWorkspace();

        const resolved = await service().resolve(orgId, 'captions.video.youtube');

        const row = await storedDefault('captions.video.youtube');
        expect(resolved).toEqual({
          key: 'captions.video.youtube',
          body: row.body,
          version: row.version,
          source: 'default',
          model: row.model ?? PROMPT_BOOK_MODEL,
          settings: { reasoningEffort: 'minimal' },
        });
      });

      it("answers the workspace's own text, its version and the default's model once it saved one", async () => {
        const { orgId, userId } = await newWorkspace();
        await service().save(orgId, 'captions.video.youtube', 'My YouTube text', userId);

        const resolved = await service().resolve(orgId, 'captions.video.youtube');

        const row = await storedDefault('captions.video.youtube');
        expect(resolved).toMatchObject({
          key: 'captions.video.youtube',
          body: 'My YouTube text',
          version: 1,
          source: 'workspace',
          model: row.model ?? PROMPT_BOOK_MODEL,
        });
      });

      it('answers the newest version of the workspace text', async () => {
        const { orgId } = await newWorkspace();
        await service().save(orgId, 'captions.general', 'First');
        await service().save(orgId, 'captions.general', 'Second');

        expect(await service().resolve(orgId, 'captions.general')).toMatchObject({
          body: 'Second',
          version: 2,
          source: 'workspace',
        });
      });

      it('falls back to the default of the family for a provider without a prompt of its own', async () => {
        const { orgId } = await newWorkspace();

        const video = await service().resolve(orgId, 'captions.video.tumblr');
        const text = await service().resolve(orgId, 'captions.text.tumblr');

        const videoRow = await storedDefault('captions.video.default');
        const textRow = await storedDefault('captions.text.default');
        expect(video).toMatchObject({
          key: 'captions.video.default',
          body: videoRow.body,
          source: 'default',
        });
        expect(text).toMatchObject({
          key: 'captions.text.default',
          body: textRow.body,
          source: 'default',
        });
      });

      it("reads the workspace's text for the family default when the provider has none of its own", async () => {
        const { orgId } = await newWorkspace();
        await service().save(orgId, 'captions.video.default', 'All the rest');

        expect(await service().resolve(orgId, 'captions.video.tumblr')).toMatchObject({
          key: 'captions.video.default',
          body: 'All the rest',
          source: 'workspace',
        });
        // a provider with a prompt of its own keeps it
        const youtube = await storedDefault('captions.video.youtube');
        expect(await service().resolve(orgId, 'captions.video.youtube')).toMatchObject({
          body: youtube.body,
          source: 'default',
        });
      });

      it('answers a locked frame from its default and never from a workspace row', async () => {
        const { orgId } = await newWorkspace();
        await worker.promptOverride.create({
          data: {
            organizationId: orgId,
            key: 'captions.frame.video',
            version: 1,
            body: 'forged',
          },
        });

        const resolved = await service().resolve(orgId, 'captions.frame.video');

        const row = await storedDefault('captions.frame.video');
        expect(resolved).toMatchObject({ body: row.body, source: 'default' });
      });

      it('answers 404 for a key with no text and no family', async () => {
        const { orgId } = await newWorkspace();

        const err = await failure(service().resolve(orgId, 'other.thing'));

        expect(err?.getStatus()).toBe(404);
      });

      it("never reads another workspace's text", async () => {
        const a = await newWorkspace();
        const b = await newWorkspace();
        await service().save(a.orgId, 'captions.general', 'Only A', a.userId);

        const forB = await service().resolve(b.orgId, 'captions.general');
        const forA = await service().resolve(a.orgId, 'captions.general');

        const row = await storedDefault('captions.general');
        expect(forB).toMatchObject({ body: row.body, source: 'default' });
        expect(forA).toMatchObject({ body: 'Only A', source: 'workspace' });
      });
    });

    describe('list', () => {
      it('lists every editable prompt of the file, filled with the defaults, and no locked frame', async () => {
        const { orgId } = await newWorkspace();

        const listed = await service().list(orgId);

        const editable = PROMPT_BOOK_DEFAULTS.filter((entry) => !entry.locked);
        expect(listed.map((item) => item.key)).toEqual(editable.map((entry) => entry.key));
        expect(listed.every((item) => item.isDefault && item.version === undefined)).toBe(true);
        expect(listed.every((item) => item.body.length > 0)).toBe(true);
        const youtube = listed.find((item) => item.key === 'captions.video.youtube');
        expect(youtube).toMatchObject({
          label: 'YouTube',
          group: 'video',
          provider: 'youtube',
        });
        expect(listed.find((item) => item.key === 'captions.general')).toMatchObject({
          group: 'general',
        });
        expect(listed.find((item) => item.key === 'captions.general')).not.toHaveProperty(
          'provider'
        );
      });

      it("shows the workspace's own text with its version, and only for that workspace", async () => {
        const a = await newWorkspace();
        const b = await newWorkspace();
        await service().save(a.orgId, 'captions.text.x', 'A on X');

        const forA = (await service().list(a.orgId)).find((i) => i.key === 'captions.text.x');
        const forB = (await service().list(b.orgId)).find((i) => i.key === 'captions.text.x');

        expect(forA).toMatchObject({ body: 'A on X', isDefault: false, version: 1 });
        expect(forB).toMatchObject({ isDefault: true });
        expect(forB?.body).not.toBe('A on X');
      });
    });

    describe('save', () => {
      it('stores each save as the next version of the key for that workspace', async () => {
        const { orgId, userId } = await newWorkspace();

        const first = await service().save(orgId, 'captions.text.x', 'One', userId);
        const second = await service().save(orgId, 'captions.text.x', 'Two', userId);

        expect([first.version, second.version]).toEqual([1, 2]);
        expect(second).toMatchObject({ key: 'captions.text.x', body: 'Two', isDefault: false });
        const rows = await worker.promptOverride.findMany({
          where: { organizationId: orgId },
          orderBy: { version: 'asc' },
        });
        expect(rows.map((row) => [row.key, row.version, row.body, row.createdById])).toEqual([
          ['captions.text.x', 1, 'One', userId],
          ['captions.text.x', 2, 'Two', userId],
        ]);
      });

      it('refuses a locked frame and an unknown key with 400 and stores nothing', async () => {
        const { orgId } = await newWorkspace();

        for (const key of ['captions.frame.video', 'captions.frame.text', 'captions.video.nope', 'x']) {
          const err = await failure(service().save(orgId, key, 'Text'));
          expect(err?.getStatus()).toBe(400);
          expect(err?.getResponse()).toMatchObject({ code: 'PROMPT_KEY_INVALID' });
        }
        expect(await worker.promptOverride.count({ where: { organizationId: orgId } })).toBe(0);
      });

      it('refuses an empty text and one over the limit with 400, and accepts one at the limit', async () => {
        const { orgId } = await newWorkspace();

        for (const body of ['', '   ', 'x'.repeat(PROMPT_BODY_MAX_LENGTH + 1)]) {
          const err = await failure(service().save(orgId, 'captions.general', body));
          expect(err?.getStatus()).toBe(400);
          expect(err?.getResponse()).toMatchObject({ code: 'PROMPT_BODY_INVALID' });
        }
        const ok = await service().save(orgId, 'captions.general', 'x'.repeat(PROMPT_BODY_MAX_LENGTH));
        expect(ok.body).toHaveLength(PROMPT_BODY_MAX_LENGTH);
      });
    });

    describe('reset', () => {
      it("removes the workspace's text so the default reads again, and leaves other workspaces alone", async () => {
        const a = await newWorkspace();
        const b = await newWorkspace();
        await service().save(a.orgId, 'captions.general', 'A voice');
        await service().save(b.orgId, 'captions.general', 'B voice');

        const reset = await service().reset(a.orgId, 'captions.general');

        const row = await storedDefault('captions.general');
        expect(reset).toMatchObject({ key: 'captions.general', body: row.body, isDefault: true });
        expect(await service().resolve(a.orgId, 'captions.general')).toMatchObject({
          source: 'default',
        });
        expect(await service().resolve(b.orgId, 'captions.general')).toMatchObject({
          body: 'B voice',
          source: 'workspace',
        });
      });

      it('refuses a locked frame and an unknown key with 400', async () => {
        const { orgId } = await newWorkspace();

        for (const key of ['captions.frame.video', 'nope']) {
          const err = await failure(service().reset(orgId, key));
          expect(err?.getStatus()).toBe(400);
        }
      });
    });

    describe('owner defaults', () => {
      afterAll(async () => {
        await worker.promptDefault.deleteMany({ where: { key: 'captions.text.nostr' } });
        await service().seed();
      });

      it('saves a new version, keeps the model and effort when left out, and changes them when given', async () => {
        const { userId } = await newWorkspace();
        const before = await storedDefault('captions.text.nostr');

        const next = await service().saveDefault(userId, {
          key: 'captions.text.nostr',
          body: '  Edited by the owner  ',
          note: 'Tighter',
        });
        const switched = await service().saveDefault(userId, {
          key: 'captions.text.nostr',
          body: 'Edited again',
          model: 'gpt-5-mini',
          reasoningEffort: 'low',
        });

        expect(next).toMatchObject({
          key: 'captions.text.nostr',
          version: before.version + 1,
          body: 'Edited by the owner',
          model: before.model ?? PROMPT_BOOK_MODEL,
          reasoningEffort: 'minimal',
          note: 'Tighter',
          locked: false,
        });
        expect(switched).toMatchObject({
          version: before.version + 2,
          model: 'gpt-5-mini',
          reasoningEffort: 'low',
        });
      });

      it('reaches a workspace that never edited, at once, with no copy stored for it', async () => {
        const { orgId, userId } = await newWorkspace();
        await service().saveDefault(userId, { key: 'captions.text.nostr', body: 'Improved text' });

        const resolved = await service().resolve(orgId, 'captions.text.nostr');

        expect(resolved).toMatchObject({ body: 'Improved text', source: 'default' });
        expect(await worker.promptOverride.count({ where: { organizationId: orgId } })).toBe(0);
      });

      it('saves a locked frame, which a workspace cannot', async () => {
        const { userId } = await newWorkspace();
        const frame = await storedDefault('captions.frame.video');

        const saved = await service().saveDefault(userId, {
          key: 'captions.frame.video',
          body: frame.body,
          note: 'unchanged text',
        });

        expect(saved).toMatchObject({ locked: true, version: frame.version + 1 });
        await worker.promptDefault.deleteMany({
          where: { key: 'captions.frame.video', version: { gt: frame.version } },
        });
      });

      it('refuses an unknown key and an empty text with 400', async () => {
        const { userId } = await newWorkspace();

        const unknown = await failure(
          service().saveDefault(userId, { key: 'captions.video.nope', body: 'Text' })
        );
        const empty = await failure(
          service().saveDefault(userId, { key: 'captions.general', body: '  ' })
        );

        expect(unknown?.getStatus()).toBe(400);
        expect(empty?.getStatus()).toBe(400);
      });

      it('lists every key of the file with its current default, locked frames included', async () => {
        const listed = await service().listDefaults();

        expect(listed.map((item) => item.key)).toEqual(PROMPT_BOOK_DEFAULTS.map((e) => e.key));
        expect(listed.filter((item) => item.locked).map((item) => item.key)).toEqual([
          'captions.frame.video',
          'captions.frame.text',
        ]);
      });

      it('keeps the history newest first and restores a version as a new version', async () => {
        const { userId } = await newWorkspace();
        const first = await service().saveDefault(userId, {
          key: 'captions.text.nostr',
          body: 'History one',
          model: 'gpt-5-nano',
          reasoningEffort: 'minimal',
        });
        const second = await service().saveDefault(userId, {
          key: 'captions.text.nostr',
          body: 'History two',
          model: 'gpt-5-mini',
          reasoningEffort: 'high',
        });

        const restored = await service().restore(userId, 'captions.text.nostr', first.version);

        expect(restored).toMatchObject({
          version: second.version + 1,
          body: 'History one',
          model: 'gpt-5-nano',
          reasoningEffort: 'minimal',
          note: `Restored from version ${first.version}`,
        });
        const history = await service().history('captions.text.nostr');
        expect(history.map((row) => row.version)).toEqual(
          [...history.map((row) => row.version)].sort((x, y) => y - x)
        );
        expect(history[0]).toMatchObject({
          version: restored.version,
          body: 'History one',
          createdById: userId,
        });
        expect(history.find((row) => row.version === second.version)).toMatchObject({
          body: 'History two',
          model: 'gpt-5-mini',
        });
      });

      it('answers 404 when the version to restore does not exist, and 400 for an unknown key', async () => {
        const { userId } = await newWorkspace();

        const missing = await failure(service().restore(userId, 'captions.text.nostr', 9999));
        const unknown = await failure(service().restore(userId, 'captions.video.nope', 1));
        const history = await failure(service().history('captions.video.nope'));

        expect(missing?.getStatus()).toBe(404);
        expect(unknown?.getStatus()).toBe(400);
        expect(history?.getStatus()).toBe(400);
      });
    });
  });
});
