// api.mobile-auto-publish: the info, the create-post body built from a Set (or, with no Set, from
// every eligible channel in automatic mode) and a recording, the excluded channels, the post
// statuses, and (on Postgres) the preset table's one-per-workspace and set-null rules.
// The service half runs on hand-made stand-ins shaped like the contract's dependencies.
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  PrismaRepository,
  PrismaService,
  selectWorkerDatabase,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AutoPublishRepository } from '@gitroom/nestjs-libraries/database/prisma/auto-publish/auto.publish.repository';
import {
  AutoPublishService,
  MAX_STATUS_IDS,
} from '@gitroom/nestjs-libraries/database/prisma/auto-publish/auto.publish.service';
import { countLength } from '@gitroom/helpers/utils/count.length';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  AUTO_DEFAULTS,
  TEXT_POST_DEFAULTS,
} from '@gitroom/nestjs-libraries/integrations/auto.publish.defaults';
import {
  allProviders,
  EmptySettings,
} from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/all.providers.settings';

// AutoPublishService names the captions service as a dependency; its real file needs the whole AI stack, and the
// tests hand the service a stand-in.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service',
  () => ({ AiCaptionsService: class {} })
);

// Modules that pull ESM-only packages ts-jest cannot load; the service only names them as dependencies.
jest.mock('file-type', () => ({}));
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock('@gitroom/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (value: string) => value,
  postContentPlainText: (value: string) => value,
}));

// The text limits of the providers, shaped like their maxLength (X: 4000 for a verified account).
const TEXT_LIMITS: Record<string, (additional?: any) => number> = {
  x: (additional) =>
    Array.isArray(additional) &&
    additional.find((s: any) => s?.title === 'Verified')?.value
      ? 4000
      : 280,
  bluesky: () => 300,
  threads: () => 500,
  mastodon: () => 500,
  youtube: () => 5000,
  tiktok: () => 2000,
  instagram: () => 2200,
};

const ORG = 'org-1';
dayjs.extend(utc);
// What the phone sends as `title` is the recording's file name; it is never a caption.
const FILE_NAME = 'myvideo-23-9-26x9x16';
// The text of a post that no AI caption reached.
const NAME = `New video ${dayjs.utc().format('D MMM YYYY')}`;

// A saved Set's content as the editor stores it, one entry per channel.
const setContent = (
  posts: Array<{
    id: string;
    settings?: Record<string, unknown>;
    text?: string[];
  }>
) =>
  JSON.stringify({
    type: 'draft',
    shortLink: false,
    date: '2026-01-01T00:00:00',
    tags: [],
    posts: posts.map((p) => ({
      integration: { id: p.id },
      group: 'old-group',
      settings: p.settings || {},
      value: (p.text || ['Hello {title}!']).map((content, i) => ({
        id: `old-value-${p.id}-${i}`,
        content,
        delay: i === 0 ? 0 : 5,
        image: [{ id: 'old-media', path: 'https://cdn.test/old.png' }],
      })),
    })),
  });

// The channels of the workspace, by id.
const channel = (
  id: string,
  identifier: string,
  disabled = false,
  over: Record<string, unknown> = {}
) => ({
  id,
  name: `name-${id}`,
  providerIdentifier: identifier,
  picture: `https://cdn.test/${id}.png`,
  disabled,
  deletedAt: null,
  refreshNeeded: false,
  inBetweenSteps: false,
  ...over,
});

// The error a call rejects with, or undefined when it resolves.
const failure = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (err) {
    return err as HttpException;
  }
  return undefined;
};

describe('api.mobile-auto-publish: AutoPublishService', () => {
  const savedFrontend = process.env.FRONTEND_URL;
  let preset: any;
  let sets: Record<string, any>;
  let integrations: any[];
  let posts: any[];
  let charged: any[];
  let slotCalls: any[][];
  let postingTimes: number[];
  let statusCalls: Array<[string, string[]]>;
  let available: number;
  let applyToPosts: jest.Mock;
  let mediaStatus: (org: string, id: string) => Promise<any>;
  let service: AutoPublishService;

  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://app.test/';
    preset = null;
    sets = {};
    integrations = [];
    posts = [];
    charged = [];
    slotCalls = [];
    postingTimes = [120, 400, 700];
    statusCalls = [];
    available = 100;
    // the captions service with no caption to apply: the posts come back as they are
    applyToPosts = jest.fn(async (_org: string, _id: string, posts: any[]) => posts);
    mediaStatus = async (org, id) => {
      if (org !== ORG || id !== 'media-1') {
        throw new HttpException('Media not found', 404);
      }
      return { id, path: 'https://cdn.test/video.mp4' };
    };
    const repository = {
      getPreset: async () => preset,
      getExcluded: async () => preset?.excludedIntegrations || [],
      setExcluded: async (org: string, id: string, excluded: boolean) => {
        const current: string[] = preset?.excludedIntegrations || [];
        const next = excluded
          ? [...new Set([...current, id])]
          : current.filter((i) => i !== id);
        preset = preset
          ? { ...preset, excludedIntegrations: next }
          : {
              setId: null,
              set: null,
              timing: 'now',
              excludedIntegrations: next,
            };
      },
      getTextIntegrations: async () => preset?.textIntegrations || [],
      setTextIntegration: async (_org: string, id: string, enabled: boolean) => {
        const current: string[] = preset?.textIntegrations || [];
        const next = enabled
          ? [...new Set([...current, id])]
          : current.filter((i) => i !== id);
        preset = preset
          ? { ...preset, textIntegrations: next }
          : {
              setId: null,
              set: null,
              timing: 'now',
              excludedIntegrations: [],
              textIntegrations: next,
            };
        return next;
      },
      getSet: async (org: string, id: string) =>
        org === ORG ? sets[id] || null : null,
      setPreset: async (_org: string, setId: string, timing: string) => {
        preset = {
          excludedIntegrations: [],
          ...preset,
          setId,
          timing,
          set: sets[setId],
        };
      },
      clearPreset: async () => {
        if (preset) {
          preset = { ...preset, setId: null, set: null, timing: 'now' };
        }
      },
      postStatuses: async (org: string, ids: string[]) => {
        statusCalls.push([org, ids]);
        return posts.filter((p) => org === ORG && ids.includes(p.id));
      },
    } as unknown as AutoPublishRepository;
    service = new AutoPublishService(
      repository,
      {
        getIntegrationsList: async () => integrations,
        getIntegrationById: async (org: string, id: string) =>
          org === ORG ? integrations.find((i) => i.id === id) || null : null,
        findFreeDateTime: async () => postingTimes,
      } as any,
      {
        preview: async (_org: string, req: { integrationIds: string[] }) => {
          charged.push(req.integrationIds);
          return { amount: req.integrationIds.length * 7 };
        },
      } as any,
      { view: async () => ({ available }) } as any,
      {
        findFreeDateTime: async (...args: any[]) => {
          slotCalls.push(args);
          return '2030-05-06T09:30:00';
        },
      } as any,
      {
        getMediaStatus: (org: string, id: string) => mediaStatus(org, id),
      } as any,
      {
        getSocialIntegration: (identifier: string) =>
          TEXT_LIMITS[identifier]
            ? { maxLength: TEXT_LIMITS[identifier] }
            : undefined,
      } as any,
      { applyToPosts } as any
    );
  });

  afterAll(() => {
    if (savedFrontend === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = savedFrontend;
    }
  });

  // Chooses a Set with these channel entries as the preset.
  const choose = (
    entries: Parameters<typeof setContent>[0],
    timing = 'now'
  ) => {
    const set = { id: 'set-1', name: 'My set', content: setContent(entries) };
    sets['set-1'] = set;
    preset = { setId: 'set-1', timing, set };
  };

  describe('info', () => {
    it('is not configured in automatic mode with no eligible channel, and still gives the balance and the setup link', async () => {
      integrations = [channel('p', 'pinterest'), channel('a', 'youtube', true)];

      const info = await service.info(ORG);

      expect(info).toEqual({
        configured: false,
        mode: 'automatic',
        setName: '',
        timing: 'now',
        channels: [],
        cost: 0,
        available: 100,
        setupUrl: `https://app.test/w/${ORG}/settings?tab=sets`,
      });
      expect(charged).toEqual([]);
    });

    it('with no Set, lists every eligible channel (automatic mode) and charges them', async () => {
      integrations = [
        channel('yt', 'youtube'),
        channel('tt', 'tiktok'),
        channel('off', 'x', true),
        channel('stale', 'facebook', false, { refreshNeeded: true }),
        channel('steps', 'instagram', false, { inBetweenSteps: true }),
        channel('pin', 'pinterest'),
        channel('skip', 'threads'),
      ];
      preset = {
        setId: null,
        set: null,
        timing: 'next_slot',
        excludedIntegrations: ['skip'],
      };

      const info = await service.info(ORG);

      expect(info.configured).toBe(true);
      expect(info.mode).toBe('automatic');
      expect(info.setName).toBe('');
      expect(info.timing).toBe('now');
      expect(info.channels.map((c) => c.id)).toEqual(['yt', 'tt']);
      expect(info.channels[0]).toEqual({
        id: 'yt',
        name: 'name-yt',
        identifier: 'youtube',
        picture: 'https://cdn.test/yt.png',
        disabled: false,
      });
      expect(charged).toEqual([['yt', 'tt']]);
      expect(info.cost).toBe(14);
    });

    it('skips the excluded channels of a Set', async () => {
      integrations = [channel('a', 'youtube'), channel('b', 'tiktok')];
      choose([{ id: 'a' }, { id: 'b' }]);
      preset.excludedIntegrations = ['b'];

      const info = await service.info(ORG);

      expect(info.mode).toBe('preset');
      expect(info.channels.map((c) => c.id)).toEqual(['a']);
      expect(charged).toEqual([['a']]);
    });

    it("lists the Set's channels, charges only the usable ones and reports the timing", async () => {
      integrations = [
        channel('a', 'youtube'),
        channel('b', 'tiktok'),
        channel('c', 'x', true),
      ];
      choose(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'deleted' }],
        'next_slot'
      );

      const info = await service.info(ORG);

      expect(info.configured).toBe(true);
      expect(info.mode).toBe('preset');
      expect(info.setName).toBe('My set');
      expect(info.timing).toBe('next_slot');
      expect(info.channels).toEqual([
        {
          id: 'a',
          name: 'name-a',
          identifier: 'youtube',
          picture: 'https://cdn.test/a.png',
          disabled: false,
        },
        {
          id: 'b',
          name: 'name-b',
          identifier: 'tiktok',
          picture: 'https://cdn.test/b.png',
          disabled: false,
        },
        {
          id: 'c',
          name: 'name-c',
          identifier: 'x',
          picture: 'https://cdn.test/c.png',
          disabled: true,
        },
      ]);
      expect(charged).toEqual([['a', 'b']]);
      expect(info.cost).toBe(14);
      expect(info.available).toBe(100);
    });

    it('is not configured when no channel of the Set is usable', async () => {
      integrations = [channel('a', 'youtube', true)];
      choose([{ id: 'a' }]);

      const info = await service.info(ORG);

      expect(info.configured).toBe(false);
      expect(info.cost).toBe(0);
      expect(charged).toEqual([]);
    });

    it('is not configured when the Set holds something that is not post data', async () => {
      sets['set-1'] = { id: 'set-1', name: 'Broken', content: 'not json' };
      preset = { setId: 'set-1', timing: 'now', set: sets['set-1'] };

      expect((await service.info(ORG)).configured).toBe(false);
    });
  });

  describe('buildPostBody', () => {
    const request = {
      media: { id: 'media-1', path: 'https://other.test/ignored.mp4' },
      title: FILE_NAME,
    };

    it('409 AUTO_PUBLISH_NOT_CONFIGURED with no Set and no eligible channel', async () => {
      integrations = [channel('p', 'pinterest'), channel('a', 'youtube', true)];

      const err = await failure(service.buildPostBody(ORG, request));

      expect(err?.getStatus()).toBe(409);
      expect((err?.getResponse() as any).code).toBe(
        'AUTO_PUBLISH_NOT_CONFIGURED'
      );
    });

    it('409 AUTO_PUBLISH_NOT_CONFIGURED when every channel is disabled', async () => {
      integrations = [channel('a', 'youtube', true)];
      choose([{ id: 'a' }]);

      const err = await failure(service.buildPostBody(ORG, request));

      expect(err?.getStatus()).toBe(409);
    });

    it('posts now to the usable channels with {title} replaced and the recording as the only media', async () => {
      integrations = [
        channel('a', 'x'),
        channel('b', 'x', true),
        channel('c', 'x'),
      ];
      choose([
        { id: 'a', text: ['Watch {title} now', 'and {title} again'] },
        { id: 'b' },
        { id: 'c', settings: { who_can_reply_post: 'everyone' } },
      ]);

      const body = await service.buildPostBody(ORG, request);

      expect(body.type).toBe('now');
      expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(body.posts.map((p) => p.integration.id)).toEqual(['a', 'c']);
      expect(body.posts[0].value).toEqual([
        {
          content: `Watch ${NAME} now`,
          delay: 0,
          image: [{ id: 'media-1', path: 'https://cdn.test/video.mp4' }],
        },
        { content: `and ${NAME} again`, delay: 5, image: [] },
      ]);
      expect(body.posts[1].settings).toEqual({
        who_can_reply_post: 'everyone',
      });
      expect(JSON.stringify(body)).not.toContain('old-media');
      expect(JSON.stringify(body)).not.toContain('old-group');
      expect(slotCalls).toEqual([]);
    });

    it('with no Set, posts now to every eligible channel with its defaults and the recording name', async () => {
      integrations = [
        channel('yt', 'youtube'),
        channel('tt', 'tiktok'),
        channel('ig', 'instagram'),
        channel('x1', 'x'),
        channel('skip', 'x'),
        channel('rd', 'reddit'),
      ];
      preset = {
        setId: null,
        set: null,
        timing: 'now',
        excludedIntegrations: ['skip'],
      };

      const body = await service.buildPostBody(ORG, request);

      expect(body.type).toBe('now');
      expect(body.shortLink).toBe(false);
      expect(body.tags).toEqual([]);
      expect(body.posts.map((p) => p.integration.id)).toEqual([
        'yt',
        'tt',
        'ig',
        'x1',
      ]);
      expect(body.posts[0].settings).toEqual({
        type: 'public',
        selfDeclaredMadeForKids: 'no',
        title: NAME,
      });
      expect(body.posts[1].settings).toMatchObject({
        privacy_level: 'PUBLIC_TO_EVERYONE',
        content_posting_method: 'DIRECT_POST',
        title: NAME,
      });
      expect(body.posts[2].settings).toEqual({ post_type: 'post' });
      expect(body.posts[3].settings).toEqual({
        post_type: 'post',
        who_can_reply_post: 'everyone',
      });
      for (const post of body.posts) {
        expect(post.value).toEqual([
          {
            content: NAME,
            delay: 0,
            image: [{ id: 'media-1', path: 'https://cdn.test/video.mp4' }],
          },
        ]);
      }
      expect(slotCalls).toEqual([]);
    });

    it('does not post to the excluded channels of a Set', async () => {
      integrations = [channel('a', 'x'), channel('b', 'x')];
      choose([{ id: 'a' }, { id: 'b' }]);
      preset.excludedIntegrations = ['a'];

      const body = await service.buildPostBody(ORG, request);

      expect(body.posts.map((p) => p.integration.id)).toEqual(['b']);
    });

    it('409 when every channel of the Set is excluded', async () => {
      integrations = [channel('a', 'x')];
      choose([{ id: 'a' }]);
      preset.excludedIntegrations = ['a'];

      const err = await failure(service.buildPostBody(ORG, request));

      expect(err?.getStatus()).toBe(409);
    });

    it('takes the next free slot of the workspace for next_slot', async () => {
      integrations = [channel('a', 'x')];
      choose([{ id: 'a' }], 'next_slot');

      const body = await service.buildPostBody(ORG, request);

      expect(body.type).toBe('schedule');
      expect(body.date).toBe('2030-05-06T09:30:00');
      expect(slotCalls).toEqual([[ORG]]);
    });

    it('publishes now for next_slot when the workspace has no posting times', async () => {
      integrations = [channel('a', 'x')];
      postingTimes = [];
      choose([{ id: 'a' }], 'next_slot');

      const body = await service.buildPostBody(ORG, request);

      expect(body.type).toBe('now');
      expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(slotCalls).toEqual([]);
    });

    it('fills an empty title setting with the fallback name, cut to the limit, and keeps a given one', async () => {
      integrations = [
        channel('yt', 'youtube'),
        channel('yt2', 'youtube'),
        channel('tt', 'tiktok'),
        channel('th', 'threads'),
      ];
      choose([
        { id: 'yt', settings: { title: '', type: 'public' } },
        { id: 'yt2', settings: { title: 'Mine', type: 'public' } },
        { id: 'tt', settings: {} },
        { id: 'th' },
      ]);

      const body = await service.buildPostBody(ORG, request);

      expect((body.posts[0].settings as any).title).toBe(NAME);
      expect((body.posts[1].settings as any).title).toBe('Mine');
      expect((body.posts[2].settings as any).title).toBe(NAME);
      expect(body.posts[3].settings).not.toHaveProperty('title');
    });

    it.each([
      'myvideo-23-9-26x9x16',
      'IMG_0012',
      'Recording',
      'Beach day',
      'My demo',
      'a'.repeat(500),
    ])(
      'never posts the title %j the phone sends: the text and the title setting are the fallback name',
      async (title) => {
        integrations = [channel('yt', 'youtube'), channel('tt', 'tiktok')];

        const body = await service.buildPostBody(ORG, { ...request, title });

        expect(body.posts.map((p) => p.value[0].content)).toEqual([NAME, NAME]);
        expect(body.posts[0].value[0].image).toHaveLength(1);
        expect((body.posts[0].settings as any).title).toBe(NAME);
        expect((body.posts[1].settings as any).title).toBe(NAME);
        expect(JSON.stringify(body)).not.toContain(title);
      }
    );

    it("in a Set, {title} is the fallback name, not the phone's title", async () => {
      integrations = [channel('a', 'x'), channel('yt', 'youtube')];
      choose([
        { id: 'a', text: ['Watch {title} now'] },
        { id: 'yt', settings: { type: 'public' }, text: ['{title}'] },
      ]);

      const body = await service.buildPostBody(ORG, request);

      expect(body.posts[0].value[0].content).toBe(`Watch ${NAME} now`);
      expect(body.posts[1].value[0].content).toBe(NAME);
      expect((body.posts[1].settings as any).title).toBe(NAME);
      expect(JSON.stringify(body)).not.toContain(FILE_NAME);
    });

    it("404 MEDIA_NOT_FOUND for media that is not the workspace's", async () => {
      integrations = [channel('a', 'x')];
      choose([{ id: 'a' }]);

      const err = await failure(
        service.buildPostBody(ORG, {
          media: { id: 'foreign', path: 'p' },
          title: 't',
        })
      );

      expect(err?.getStatus()).toBe(404);
      expect((err?.getResponse() as any).code).toBe('MEDIA_NOT_FOUND');
    });

    it('does not turn another failure of the media lookup into a 404', async () => {
      integrations = [channel('a', 'x')];
      choose([{ id: 'a' }]);
      mediaStatus = async () => {
        throw new Error('database down');
      };

      const err = await failure(service.buildPostBody(ORG, request));

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(HttpException);
    });
  });

  describe('buildPostBody with an AI caption (ai.video-captions)', () => {
    const request = {
      media: { id: 'media-1', path: 'https://other.test/ignored.mp4' },
      title: FILE_NAME,
      aiCaptionId: 'cap-1',
    };
    const plain = { media: request.media, title: request.title };
    const VIDEO = { id: 'media-1', path: 'https://cdn.test/video.mp4' };

    // Automatic mode, with these text-only channels switched on.
    const automatic = (textIntegrations: string[], excluded: string[] = []) => {
      preset = {
        setId: null,
        set: null,
        timing: 'now',
        excludedIntegrations: excluded,
        textIntegrations,
      };
    };

    // The captions service as it answers for a READY caption: each post's first text is written by it.
    const writes = () =>
      applyToPosts.mockImplementation(async (_org, _id, posts: any[]) =>
        posts.map((p) => ({
          ...p,
          value: [
            { ...p.value[0], content: `AI text for ${p.integration.id}` },
            ...p.value.slice(1),
          ],
        }))
      );

    it('does not ask the captions service without a caption, and adds no text channel', async () => {
      integrations = [channel('yt', 'youtube'), channel('gmb', 'gmb')];
      automatic(['gmb']);

      const body = await service.buildPostBody(ORG, plain);

      expect(applyToPosts).not.toHaveBeenCalled();
      expect(body.posts.map((p) => p.integration.id)).toEqual(['yt']);
      expect(body.posts[0].value).toEqual([
        { content: NAME, delay: 0, image: [VIDEO] },
      ]);
    });

    it("asks the captions service for the posts as the recording's, with {title} still in the text and before any title is filled", async () => {
      integrations = [channel('yt', 'youtube'), channel('gmb', 'gmb')];
      automatic(['gmb']);

      await service.buildPostBody(ORG, request);

      expect(applyToPosts).toHaveBeenCalledTimes(1);
      const [org, id, sent, context] = applyToPosts.mock.calls[0];
      expect([org, id, context]).toEqual([
        ORG,
        'cap-1',
        { placeholder: '{title}' },
      ]);
      expect(sent).toEqual([
        {
          integration: { id: 'yt' },
          settings: AUTO_DEFAULTS.youtube,
          value: [{ content: '{title}', delay: 0, image: [VIDEO] }],
        },
        {
          // the text channel: its text-post settings, and no video
          integration: { id: 'gmb' },
          settings: TEXT_POST_DEFAULTS.gmb,
          value: [{ content: '{title}', delay: 0, image: [] }],
        },
      ]);
    });

    it('builds the body from what the captions service answers, and fills the YouTube title after it', async () => {
      integrations = [channel('yt', 'youtube'), channel('gmb', 'gmb')];
      automatic(['gmb']);
      writes();

      const body = await service.buildPostBody(ORG, request);

      expect(body.posts).toEqual([
        {
          integration: { id: 'yt' },
          settings: { ...AUTO_DEFAULTS.youtube, title: NAME },
          value: [{ content: 'AI text for yt', delay: 0, image: [VIDEO] }],
        },
        {
          integration: { id: 'gmb' },
          settings: TEXT_POST_DEFAULTS.gmb,
          value: [{ content: 'AI text for gmb', delay: 0, image: [] }],
        },
      ]);
    });

    it("keeps the title the captions service gave a channel", async () => {
      integrations = [channel('yt', 'youtube')];
      applyToPosts.mockImplementation(async (_org, _id, posts: any[]) =>
        posts.map((p) => ({ ...p, settings: { ...p.settings, title: 'AI title' } }))
      );

      const body = await service.buildPostBody(ORG, request);

      expect(body.posts[0].settings).toMatchObject({ title: 'AI title' });
    });

    it('is the body of today when the captions service changes nothing (a caption that is not READY)', async () => {
      integrations = [
        channel('yt', 'youtube'),
        channel('tt', 'tiktok'),
        channel('x1', 'x'),
      ];

      const without = await service.buildPostBody(ORG, plain);
      const withCaption = await service.buildPostBody(ORG, request);

      expect(withCaption.posts).toEqual(without.posts);
    });

    it('in a Set, replaces the {title} the captions service left (a thread comment) with the recording name as before', async () => {
      integrations = [channel('a', 'x')];
      choose([{ id: 'a', text: ['Watch {title} now', 'and {title} again'] }]);

      const body = await service.buildPostBody(ORG, request);

      expect(applyToPosts.mock.calls[0][2][0].value[0].content).toBe(
        'Watch {title} now'
      );
      expect(body.posts[0].value.map((v) => v.content)).toEqual([
        `Watch ${NAME} now`,
        `and ${NAME} again`,
      ]);
    });

    it('adds no text channel to a Set, which decides its channels itself', async () => {
      integrations = [channel('a', 'x'), channel('g', 'gmb')];
      choose([{ id: 'a' }]);
      preset.textIntegrations = ['g'];

      const body = await service.buildPostBody(ORG, request);

      expect(body.posts.map((p) => p.integration.id)).toEqual(['a']);
    });

    it('leaves out a switched-on text channel that is excluded, disabled, deleted, in need of a reconnect or of a provider with no text post', async () => {
      integrations = [
        channel('yt', 'youtube'),
        channel('ok', 'gmb'),
        channel('nostr', 'nostr'),
        channel('off', 'gmb', true),
        channel('stale', 'gmb', false, { refreshNeeded: true }),
        channel('gone', 'gmb', false, { deletedAt: new Date() }),
        channel('skip', 'gmb'),
        channel('slack', 'slack'),
        channel('off-switch', 'gmb'),
      ];
      automatic(
        ['ok', 'nostr', 'off', 'stale', 'gone', 'skip', 'slack', 'missing'],
        ['skip']
      );
      writes();

      const body = await service.buildPostBody(ORG, request);

      expect(body.posts.map((p) => p.integration.id)).toEqual([
        'yt',
        'ok',
        'nostr',
      ]);
      expect(await service.textChannelIds(ORG)).toEqual(['ok', 'nostr']);
    });

    it('leaves out a text channel the captions service did not reach (it failed and returned the posts as they came), and the video channels still post', async () => {
      integrations = [channel('yt', 'youtube'), channel('gmb', 'gmb')];
      automatic(['gmb']);

      const body = await service.buildPostBody(ORG, request);

      expect(applyToPosts).toHaveBeenCalledTimes(1);
      expect(body.posts.map((p) => p.integration.id)).toEqual(['yt']);
    });

    it('when the captions service did not reach a post, the video channel posts the fallback name and the text channel is left out', async () => {
      integrations = [channel('yt', 'youtube'), channel('gmb', 'gmb')];
      automatic(['gmb']);

      const body = await service.buildPostBody(ORG, request);

      expect(body.posts.map((p) => p.integration.id)).toEqual(['yt']);
      expect(body.posts[0].value[0]).toEqual({
        content: NAME,
        delay: 0,
        image: [VIDEO],
      });
    });

    it('leaves out the text channels the captions service wrote nothing for, and the video channels still post', async () => {
      integrations = [channel('yt', 'youtube'), channel('gmb', 'gmb')];
      automatic(['gmb']);
      applyToPosts.mockImplementation(async (_org, _id, posts: any[]) =>
        posts.filter((p) => p.integration.id !== 'gmb')
      );

      const body = await service.buildPostBody(ORG, request);

      expect(body.posts.map((p) => p.integration.id)).toEqual(['yt']);
    });

    it.each([
      [100, ['yt', 'tt', 'gmb1', 'gmb2']],
      [28, ['yt', 'tt', 'gmb1', 'gmb2']],
      [21, ['yt', 'tt', 'gmb1']],
      [14, ['yt', 'tt']],
      [0, ['yt', 'tt']],
    ])(
      'with %s credits (7 a channel) posts to %j: the text channels the credits cannot pay for are left out, never the video channels',
      async (credits, expected) => {
        integrations = [
          channel('yt', 'youtube'),
          channel('tt', 'tiktok'),
          channel('gmb1', 'gmb'),
          channel('gmb2', 'gmb'),
        ];
        automatic(['gmb1', 'gmb2']);
        available = credits;
        writes();

        const body = await service.buildPostBody(ORG, request);

        expect(body.posts.map((p) => p.integration.id)).toEqual(expected);
        expect(charged).toEqual([['yt', 'tt', 'gmb1', 'gmb2']]);
      }
    );

    it('asks about the credits only when a text channel is in the body', async () => {
      integrations = [channel('yt', 'youtube')];

      await service.buildPostBody(ORG, request);

      expect(charged).toEqual([]);
    });

    it('409 AUTO_PUBLISH_NOT_CONFIGURED when nothing is left to post', async () => {
      integrations = [channel('yt', 'youtube')];
      applyToPosts.mockResolvedValue([]);

      const err = await failure(service.buildPostBody(ORG, request));

      expect(err?.getStatus()).toBe(409);
      expect((err?.getResponse() as any).code).toBe(
        'AUTO_PUBLISH_NOT_CONFIGURED'
      );
    });

    it('still needs a video channel: a text channel alone is not a configured auto-publish', async () => {
      integrations = [channel('gmb', 'gmb')];
      automatic(['gmb']);

      const err = await failure(service.buildPostBody(ORG, request));

      expect(err?.getStatus()).toBe(409);
      expect(applyToPosts).not.toHaveBeenCalled();
    });
  });

  describe('text channels', () => {
    it('info counts the switched-on text channels in the cost (the most a publish can cost) and not in the channels', async () => {
      integrations = [channel('yt', 'youtube'), channel('gmb', 'gmb')];
      preset = {
        setId: null,
        set: null,
        timing: 'now',
        excludedIntegrations: [],
        textIntegrations: ['gmb'],
      };

      const info = await service.info(ORG);

      expect(info.channels.map((c) => c.id)).toEqual(['yt']);
      expect(info.configured).toBe(true);
      expect(charged).toEqual([['yt', 'gmb']]);
      expect(info.cost).toBe(14);
    });

    it('info is not configured with a text channel only, and charges nothing', async () => {
      integrations = [channel('gmb', 'gmb')];
      preset = {
        setId: null,
        set: null,
        timing: 'now',
        excludedIntegrations: [],
        textIntegrations: ['gmb'],
      };

      const info = await service.info(ORG);

      expect(info.configured).toBe(false);
      expect(info.cost).toBe(0);
      expect(charged).toEqual([]);
    });

    it('lists no text channel with a Set', async () => {
      integrations = [channel('a', 'x'), channel('g', 'gmb')];
      choose([{ id: 'a' }]);
      preset.textIntegrations = ['g'];

      expect(await service.textChannelIds(ORG)).toEqual([]);
    });

    it('switches a channel on once, and off, creating the row with no Set when missing', async () => {
      integrations = [channel('g', 'gmb'), channel('n', 'nostr')];

      expect(await service.setTextChannel(ORG, 'g', true)).toEqual({
        textIntegrations: ['g'],
      });
      expect(await service.setTextChannel(ORG, 'g', true)).toEqual({
        textIntegrations: ['g'],
      });
      expect(await service.setTextChannel(ORG, 'n', true)).toEqual({
        textIntegrations: ['g', 'n'],
      });
      expect(preset.setId).toBeNull();
      expect(await service.getTextIntegrations(ORG)).toEqual(['g', 'n']);

      expect(await service.setTextChannel(ORG, 'g', false)).toEqual({
        textIntegrations: ['n'],
      });
    });

    it('keeps the chosen Set and the excluded channels', async () => {
      integrations = [channel('a', 'x'), channel('g', 'gmb')];
      choose([{ id: 'a' }]);
      preset.excludedIntegrations = ['a'];

      await service.setTextChannel(ORG, 'g', true);

      expect(preset.setId).toBe('set-1');
      expect(preset.excludedIntegrations).toEqual(['a']);
    });

    it('404 CHANNEL_NOT_FOUND for a channel of another workspace or a deleted one', async () => {
      integrations = [channel('gone', 'gmb', false, { deletedAt: new Date() })];

      const foreign = await failure(service.setTextChannel(ORG, 'other', true));
      const deleted = await failure(service.setTextChannel(ORG, 'gone', true));

      expect(foreign?.getStatus()).toBe(404);
      expect((foreign?.getResponse() as any).code).toBe('CHANNEL_NOT_FOUND');
      expect(deleted?.getStatus()).toBe(404);
      expect(preset).toBeNull();
    });

    it('400 TEXT_POST_NOT_SUPPORTED for a provider that cannot get a text post, and writes nothing', async () => {
      integrations = [channel('yt', 'youtube'), channel('s', 'slack')];

      const video = await failure(service.setTextChannel(ORG, 'yt', true));
      const needsChoice = await failure(service.setTextChannel(ORG, 's', true));

      expect(video?.getStatus()).toBe(400);
      expect((video?.getResponse() as any).code).toBe('TEXT_POST_NOT_SUPPORTED');
      expect(needsChoice?.getStatus()).toBe(400);
      expect(preset).toBeNull();
    });
  });

  describe('TEXT_POST_DEFAULTS', () => {
    it("every entry passes its provider's settings class, as the create-post validation reads it", () => {
      for (const [identifier, defaults] of Object.entries(TEXT_POST_DEFAULTS)) {
        const dto = allProviders(EmptySettings).find(
          (p) => p.name === identifier
        );
        expect(dto).toBeDefined();
        const errors = validateSync(
          plainToInstance(dto!.value, {
            ...defaults,
            __type: identifier,
          }) as object
        );
        expect({ identifier, errors: errors.map((e) => e.toString()) }).toEqual(
          { identifier, errors: [] }
        );
      }
    });

    it('lists no provider that auto-publishes a video', () => {
      expect(
        Object.keys(TEXT_POST_DEFAULTS).filter((i) => i in AUTO_DEFAULTS)
      ).toEqual([]);
    });
  });

  describe('setPreset', () => {
    it('404 SET_NOT_FOUND for a Set of another workspace', async () => {
      const err = await failure(service.setPreset(ORG, 'set-x'));

      expect(err?.getStatus()).toBe(404);
      expect((err?.getResponse() as any).code).toBe('SET_NOT_FOUND');
    });

    it('makes the Set the preset with timing now by default', async () => {
      sets['set-1'] = { id: 'set-1', name: 'My set', content: '{}' };

      expect(await service.setPreset(ORG, 'set-1')).toEqual({
        setId: 'set-1',
        setName: 'My set',
        timing: 'now',
      });
    });
  });

  describe('getPreset and clearPreset', () => {
    it('answers null for a row with no Set', async () => {
      preset = {
        setId: null,
        set: null,
        timing: 'now',
        excludedIntegrations: ['a'],
      };

      expect(await service.getPreset(ORG)).toBeNull();
    });

    it('stops using the Set and keeps the excluded channels', async () => {
      integrations = [channel('a', 'x'), channel('b', 'x')];
      choose([{ id: 'a' }]);
      preset.excludedIntegrations = ['b'];

      expect(await service.clearPreset(ORG)).toEqual({ cleared: true });

      expect(await service.getPreset(ORG)).toBeNull();
      expect(await service.getExcluded(ORG)).toEqual(['b']);
      expect((await service.info(ORG)).mode).toBe('automatic');
    });
  });

  describe('setChannelExcluded', () => {
    it('adds a channel once, and removes it, creating the row with no Set when missing', async () => {
      integrations = [channel('a', 'x')];

      await service.setChannelExcluded(ORG, 'a', true);
      await service.setChannelExcluded(ORG, 'a', true);

      expect(await service.getExcluded(ORG)).toEqual(['a']);
      expect(preset.setId).toBeNull();

      await service.setChannelExcluded(ORG, 'a', false);

      expect(await service.getExcluded(ORG)).toEqual([]);
    });

    it('keeps the chosen Set', async () => {
      integrations = [channel('a', 'x')];
      choose([{ id: 'a' }]);

      await service.setChannelExcluded(ORG, 'a', true);

      expect((await service.getPreset(ORG))?.setId).toBe('set-1');
    });

    it('404 CHANNEL_NOT_FOUND for a channel of another workspace or a deleted one', async () => {
      integrations = [channel('gone', 'x', false, { deletedAt: new Date() })];

      const foreign = await failure(
        service.setChannelExcluded(ORG, 'other', true)
      );
      const deleted = await failure(
        service.setChannelExcluded(ORG, 'gone', true)
      );

      expect(foreign?.getStatus()).toBe(404);
      expect((foreign?.getResponse() as any).code).toBe('CHANNEL_NOT_FOUND');
      expect(deleted?.getStatus()).toBe(404);
      expect(preset).toBeNull();
    });
  });

  describe('postStatuses', () => {
    const row = (over: Record<string, unknown>) => ({
      id: 'p',
      state: 'QUEUE',
      publishDate: new Date('2026-10-14T10:00:00Z'),
      releaseURL: null,
      error: null,
      deletedAt: null,
      ...over,
    });

    it('answers each state, the release link of a published post and the error of a failed one', async () => {
      posts = [
        row({ id: 'q' }),
        row({ id: 'ok', state: 'PUBLISHED', releaseURL: 'https://yt.test/1' }),
        row({ id: 'bad', state: 'ERROR', error: 'quota exceeded' }),
        row({ id: 'gone', state: 'QUEUE', deletedAt: new Date() }),
      ];

      const out = await service.postStatuses(ORG, ['q', 'ok', 'bad', 'gone']);

      expect(out).toEqual([
        { id: 'q', state: 'QUEUE', publishDate: '2026-10-14T10:00:00.000Z' },
        {
          id: 'ok',
          state: 'PUBLISHED',
          publishDate: '2026-10-14T10:00:00.000Z',
          releaseURL: 'https://yt.test/1',
        },
        {
          id: 'bad',
          state: 'ERROR',
          publishDate: '2026-10-14T10:00:00.000Z',
          error: 'quota exceeded',
        },
        {
          id: 'gone',
          state: 'DELETED',
          publishDate: '2026-10-14T10:00:00.000Z',
        },
      ]);
    });

    it('answers DELETED without the error of a deleted post whose state is ERROR', async () => {
      posts = [
        row({
          id: 'gone',
          state: 'ERROR',
          error: 'quota exceeded',
          deletedAt: new Date(),
        }),
      ];

      const out = await service.postStatuses(ORG, ['gone']);

      expect(out).toHaveLength(1);
      expect(out[0].state).toBe('DELETED');
      expect(out[0]).not.toHaveProperty('error');
    });

    it('omits unknown and foreign ids', async () => {
      posts = [row({ id: 'q' })];

      expect(await service.postStatuses(ORG, ['q', 'nope'])).toHaveLength(1);
      expect(statusCalls).toEqual([[ORG, ['q', 'nope']]]);
      expect(await service.postStatuses('other-org', ['q'])).toEqual([]);
      expect(statusCalls[1]).toEqual(['other-org', ['q']]);
    });

    it('asks the repository for each distinct id once', async () => {
      await service.postStatuses(ORG, ['q', '', 'q', 'ok']);

      expect(statusCalls).toEqual([[ORG, ['q', 'ok']]]);
    });

    it('accepts one id and exactly the limit', async () => {
      posts = [row({ id: 'q' })];

      expect(await service.postStatuses(ORG, ['q'])).toHaveLength(1);
      expect(
        await service.postStatuses(
          ORG,
          Array.from({ length: MAX_STATUS_IDS }, (_, i) => `id-${i}`)
        )
      ).toEqual([]);
    });

    it('400 for no ids or more than the limit', async () => {
      const none = await failure(service.postStatuses(ORG, ['', '']));
      const many = await failure(
        service.postStatuses(
          ORG,
          Array.from({ length: MAX_STATUS_IDS + 1 }, (_, i) => `id-${i}`)
        )
      );

      const repeated = await failure(
        service.postStatuses(ORG, [
          ...Array.from({ length: MAX_STATUS_IDS }, (_, i) => `id-${i}`),
          'id-0',
        ])
      );

      expect(none?.getStatus()).toBe(400);
      expect(many?.getStatus()).toBe(400);
      expect(repeated?.getStatus()).toBe(400);
      expect((none?.getResponse() as any).code).toBe('INVALID_IDS');
      expect((many?.getResponse() as any).code).toBe('INVALID_IDS');
      expect((repeated?.getResponse() as any).code).toBe('INVALID_IDS');
      expect(statusCalls).toEqual([]);
    });
  });

  describe('AUTO_DEFAULTS', () => {
    it("every entry passes its provider's settings class, as the create-post validation reads it", () => {
      for (const [identifier, defaults] of Object.entries(AUTO_DEFAULTS)) {
        const dto = allProviders(EmptySettings).find(
          (p) => p.name === identifier
        );
        expect(dto).toBeDefined();
        // `title` is filled from the recording's name, `__type` by the create-post mapping.
        const errors = validateSync(
          plainToInstance(dto!.value, {
            ...defaults,
            title: 'My demo',
            __type: identifier,
          }) as object
        );
        expect({ identifier, errors: errors.map((e) => e.toString()) }).toEqual(
          { identifier, errors: [] }
        );
      }
    });
  });
});

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('api.mobile-auto-publish: AutoPublishPreset (Postgres)', () => {
  let service: PrismaService;
  let worker: PrismaClient;
  let repository: AutoPublishRepository;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  beforeAll(async () => {
    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    service = new PrismaService();
    await service.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    const repo = new PrismaRepository<any>(service);
    repository = new AutoPublishRepository(repo, repo, repo);
  });

  afterAll(async () => {
    await service.$disconnect();
    await worker.$disconnect();
    if (savedWorkerUrl === undefined) {
      delete process.env.DATABASE_WORKER_URL;
    } else {
      process.env.DATABASE_WORKER_URL = savedWorkerUrl;
    }
  });

  // A workspace with two Sets.
  const workspace = async () => {
    const org = await worker.organization.create({
      data: { name: 'ws-' + randomUUID() },
    });
    const a = await worker.sets.create({
      data: { organizationId: org.id, name: 'A', content: '{}' },
    });
    const b = await worker.sets.create({
      data: { organizationId: org.id, name: 'B', content: '{}' },
    });
    return { orgId: org.id, a, b };
  };

  it('keeps one preset per workspace: choosing another Set replaces it', async () => {
    const { orgId, a, b } = await workspace();

    await repository.setPreset(orgId, a.id, 'now');
    await repository.setPreset(orgId, b.id, 'next_slot');

    const rows = await worker.autoPublishPreset.findMany({
      where: { organizationId: orgId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ setId: b.id, timing: 'next_slot' });
    expect((await repository.getPreset(orgId))?.set.name).toBe('B');
  });

  it('defaults the timing to now', async () => {
    const { orgId, a } = await workspace();

    await worker.autoPublishPreset.create({
      data: { organizationId: orgId, setId: a.id },
    });

    expect((await repository.getPreset(orgId))?.timing).toBe('now');
  });

  it('loses its Set (automatic mode) but keeps its row and exclusions when the Set is deleted', async () => {
    const { orgId, a } = await workspace();
    await repository.setPreset(orgId, a.id, 'now');
    await repository.setExcluded(orgId, 'channel-1', true);

    await worker.sets.delete({ where: { id: a.id } });

    const row = await repository.getPreset(orgId);
    expect(row?.setId).toBeNull();
    expect(row?.set).toBeNull();
    expect(row?.excludedIntegrations).toEqual(['channel-1']);
  });

  it('creates a row with no Set for an exclusion, lists a channel once and removes it', async () => {
    const { orgId } = await workspace();

    await repository.setExcluded(orgId, 'channel-1', true);
    await repository.setExcluded(orgId, 'channel-1', true);
    await repository.setExcluded(orgId, 'channel-2', true);

    expect(await repository.getExcluded(orgId)).toEqual([
      'channel-1',
      'channel-2',
    ]);
    expect((await repository.getPreset(orgId))?.setId).toBeNull();

    await repository.setExcluded(orgId, 'channel-1', false);

    expect(await repository.getExcluded(orgId)).toEqual(['channel-2']);
  });

  it('clearPreset drops the Set and keeps the exclusions', async () => {
    const { orgId, a } = await workspace();
    await repository.setPreset(orgId, a.id, 'next_slot');
    await repository.setExcluded(orgId, 'channel-1', true);

    await repository.clearPreset(orgId);

    const row = await repository.getPreset(orgId);
    expect(row).toMatchObject({
      setId: null,
      timing: 'now',
      excludedIntegrations: ['channel-1'],
    });
  });

  it('defaults the exclusions to none', async () => {
    const { orgId, a } = await workspace();

    await repository.setPreset(orgId, a.id, 'now');

    expect(await repository.getExcluded(orgId)).toEqual([]);
  });

  it('finds a Set only in its own workspace', async () => {
    const one = await workspace();
    const two = await workspace();

    expect(await repository.getSet(one.orgId, one.a.id)).not.toBeNull();
    expect(await repository.getSet(two.orgId, one.a.id)).toBeNull();
  });
});
