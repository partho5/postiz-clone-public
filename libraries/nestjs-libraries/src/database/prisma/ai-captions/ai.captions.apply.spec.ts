// ai.video-captions (AC7): the caption's text in the posts of a publish call (AiCaptionsService.applyToPosts) and
// the post made from each text (linkPosts). Needs no network and no database: the storage of the captions, the
// channels and their providers are stand-ins. Covers a READY caption in automatic mode (each channel's text, the
// YouTube title, the video only on the channels that take one, the text channels), a Set's text (`{title}`
// replaced, the rest of the Set kept, a Set without `{title}`), a manual publish with the creator's own text, the
// character limit as validation counts it, and every way the caption can be missing, which leaves the posts as
// they were.
import * as fs from 'fs';
import * as path from 'path';
import { AiCaptionsService } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service';
import { TEXT_POST_DEFAULTS } from '@gitroom/nestjs-libraries/integrations/auto.publish.defaults';
import { postTextLength } from '@gitroom/nestjs-libraries/integrations/post.text.limits';

jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  R2: { send: jest.fn() },
  R2_BUCKET: 'test-bucket',
  deleteObject: jest.fn(),
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.repository',
  () => ({ AiCaptionsRepository: class {} })
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
const CAPTION = 'cap-1';
const VIDEO = { id: 'media-1', path: 'https://cdn.test/video.mp4' };

// The channels of the workspace: two with a video, two that take none.
const INTEGRATIONS = [
  { id: 'int-yt', providerIdentifier: 'youtube', additionalSettings: '[]' },
  { id: 'int-x', providerIdentifier: 'x', additionalSettings: '[]' },
  { id: 'int-gmb', providerIdentifier: 'gmb', additionalSettings: '[]' },
  { id: 'int-slack', providerIdentifier: 'slack', additionalSettings: '[]' },
];

// `acceptsVideo` left out is a provider that takes a video, as today.
const PROVIDERS: Record<string, any> = {
  youtube: { maxLength: () => 5000 },
  x: { maxLength: () => 280 },
  gmb: { maxLength: () => 1500, acceptsVideo: false },
  slack: { maxLength: () => 400000, acceptsVideo: false },
};

// The text written for one channel, as saved.
const output = (integrationId: string, extra: Record<string, unknown> = {}) => {
  const channel = INTEGRATIONS.find((i) => i.id === integrationId)!;
  return {
    integrationId,
    providerIdentifier: channel.providerIdentifier,
    kind: channel.providerIdentifier === 'gmb' ? 'text' : 'video',
    title: null,
    text: `Text for ${channel.providerIdentifier}\n\n#tips`,
    hashtags: ['tips'],
    ...extra,
  };
};

const html = (identifier: string) =>
  `<p>Text for ${identifier}</p><p></p><p>#tips</p>`;

const readyCaption = (over: Record<string, unknown> = {}) => ({
  id: CAPTION,
  organizationId: ORG,
  status: 'READY',
  userText: null,
  deletedAt: null,
  outputs: [
    output('int-yt', { title: 'A title from the talk' }),
    output('int-x'),
    output('int-gmb'),
  ],
  ...over,
});

// The service over stand-ins. `stored` is what the storage holds for the workspace (a caption of another
// workspace, or a deleted one, is not found, as the real storage answers).
const build = (stored: any = readyCaption()) => {
  const repo = {
    getCaption: jest.fn(async (organizationId: string, id: string) =>
      stored &&
      stored.organizationId === organizationId &&
      stored.id === id &&
      !stored.deletedAt
        ? stored
        : null
    ),
    linkOutputs: jest.fn().mockResolvedValue([]),
  };
  const service = new AiCaptionsService(
    repo as any,
    {} as any,
    {} as any,
    {} as any,
    { getIntegrationsList: async () => INTEGRATIONS } as any,
    { getSocialIntegration: (identifier: string) => PROVIDERS[identifier] } as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { service, repo };
};

// A channel entry as AutoPublishService builds it in automatic mode: the text is `{title}`, the video on the
// first value.
const entry = (
  id: string,
  content = '{title}',
  settings: Record<string, unknown> = {},
  image: unknown[] = [VIDEO]
) => ({
  integration: { id },
  settings,
  value: [{ content, delay: 0, image }],
});

const SET = { placeholder: '{title}' };

const contentOf = (post: { value: Array<{ content?: string }> }) =>
  post.value[0].content;

describe('ai.video-captions: AiCaptionsService.applyToPosts', () => {
  describe('automatic mode with a READY caption', () => {
    it("gives each channel the text written for it and keeps the video only on the channels that take one", async () => {
      const { service } = build();
      const posts = [
        entry('int-yt'),
        entry('int-x'),
        // the text channel the workspace switched on: no video from the start
        entry('int-gmb', '{title}', { topicType: 'STANDARD' }, []),
      ];

      const applied = await service.applyToPosts(ORG, CAPTION, posts, SET);

      expect(applied.map((p) => p.integration.id)).toEqual([
        'int-yt',
        'int-x',
        'int-gmb',
      ]);
      expect(applied.map(contentOf)).toEqual([
        html('youtube'),
        html('x'),
        html('gmb'),
      ]);
      expect(applied[0].value[0].image).toEqual([VIDEO]);
      expect(applied[1].value[0].image).toEqual([VIDEO]);
      expect(applied[2].value[0].image).toEqual([]);
      expect(applied[2].settings).toEqual({ topicType: 'STANDARD' });
    });

    it('takes the video off a channel that takes none, even when the post carries one', async () => {
      const { service } = build();

      const [applied] = await service.applyToPosts(
        ORG,
        CAPTION,
        [entry('int-gmb')],
        SET
      );

      expect(applied.value[0].image).toEqual([]);
      expect(contentOf(applied)).toBe(html('gmb'));
    });

    it("gives YouTube the caption's title, and leaves the settings of a channel with none alone", async () => {
      const { service } = build();
      const x = entry('int-x', '{title}', { post_type: 'post' });

      const [youtube, other] = await service.applyToPosts(
        ORG,
        CAPTION,
        [entry('int-yt', '{title}', { type: 'public' }), x],
        SET
      );

      expect(youtube.settings).toEqual({
        type: 'public',
        title: 'A title from the talk',
      });
      expect(other.settings).toBe(x.settings);
    });

    it('leaves the settings alone when the caption has no title, so the recording name can fill it', async () => {
      const { service } = build(
        readyCaption({ outputs: [output('int-yt', { title: null })] })
      );
      const youtube = entry('int-yt', '{title}', { type: 'public' });

      const [applied] = await service.applyToPosts(ORG, CAPTION, [youtube], SET);

      expect(applied.settings).toBe(youtube.settings);
      expect(contentOf(applied)).toBe(html('youtube'));
    });

    it("keeps today's text for a video channel the caption wrote nothing for", async () => {
      const { service } = build(readyCaption({ outputs: [output('int-x')] }));
      const youtube = entry('int-yt');

      const applied = await service.applyToPosts(
        ORG,
        CAPTION,
        [youtube, entry('int-x')],
        SET
      );

      expect(applied[0]).toBe(youtube);
      expect(contentOf(applied[1])).toBe(html('x'));
    });

    it('drops a text channel the caption wrote nothing for, and keeps the video channels as they were', async () => {
      const { service } = build(
        readyCaption({ outputs: [output('int-yt'), output('int-x')] })
      );
      const posts = [entry('int-yt'), entry('int-x'), entry('int-gmb', '{title}', {}, [])];

      const applied = await service.applyToPosts(ORG, CAPTION, posts, SET);

      expect(applied.map((p) => p.integration.id)).toEqual(['int-yt', 'int-x']);
    });

    it('does not change the posts it was given', async () => {
      const { service } = build();
      const posts = [entry('int-yt', '{title}', { type: 'public' }), entry('int-gmb')];
      const before = JSON.parse(JSON.stringify(posts));

      await service.applyToPosts(ORG, CAPTION, posts, SET);

      expect(posts).toEqual(before);
    });
  });

  describe('a caption that is not READY', () => {
    const notReady: Array<[string, any, string]> = [
      ['still PENDING', readyCaption({ status: 'PENDING' }), CAPTION],
      ['GENERATING with its texts already saved', readyCaption({ status: 'GENERATING' }), CAPTION],
      ['FAILED', readyCaption({ status: 'FAILED' }), CAPTION],
      ['NO_SPEECH', readyCaption({ status: 'NO_SPEECH', outputs: [] }), CAPTION],
      ['deleted', readyCaption({ deletedAt: new Date() }), CAPTION],
      ['another workspace\'s', readyCaption({ organizationId: 'org-2' }), CAPTION],
      ['unknown', readyCaption(), 'no-such-caption'],
    ];

    it.each(notReady)('%s: a video channel keeps today\'s text and the text channel is dropped', async (_name, stored, id) => {
      const { service } = build(stored);
      const youtube = entry('int-yt');
      const x = entry('int-x', '{title}', { post_type: 'post' });

      const applied = await service.applyToPosts(
        ORG,
        id,
        [youtube, x, entry('int-gmb', '{title}', {}, [])],
        SET
      );

      expect(applied).toEqual([youtube, x]);
      expect(applied[0]).toBe(youtube);
      expect(applied[1]).toBe(x);
    });

    it("keeps a text channel's own text (a Set's other text) without the video and without {title}", async () => {
      const { service } = build(readyCaption({ status: 'PENDING' }));

      const [applied] = await service.applyToPosts(
        ORG,
        CAPTION,
        [entry('int-slack', '<p>{title}</p><p>Join us at example.com</p>')],
        SET
      );

      expect(contentOf(applied)).toBe('<p></p><p>Join us at example.com</p>');
      expect(applied.value[0].image).toEqual([]);
    });

    it('drops a text channel whose Set text is only {title}', async () => {
      const { service } = build(readyCaption({ status: 'PENDING' }));

      const applied = await service.applyToPosts(
        ORG,
        CAPTION,
        [entry('int-slack', '<p>{title}</p>')],
        SET
      );

      expect(applied).toEqual([]);
    });
  });

  describe("a Set's text", () => {
    it('puts the caption where {title} is as paragraphs and keeps the rest of the Set text', async () => {
      const { service } = build();

      const [applied] = await service.applyToPosts(
        ORG,
        CAPTION,
        [entry('int-yt', '<p>{title}</p><p>Subscribe at example.com</p>')],
        SET
      );

      expect(contentOf(applied)).toBe(
        `${html('youtube')}<p>Subscribe at example.com</p>`
      );
    });

    it('puts the caption inside the line when {title} is part of a line', async () => {
      const { service } = build();

      const [applied] = await service.applyToPosts(
        ORG,
        CAPTION,
        [entry('int-yt', '<p>New video: {title} #shorts</p><p>Link in bio</p>')],
        SET
      );

      expect(contentOf(applied)).toBe(
        '<p>New video: Text for youtube #tips #shorts</p><p>Link in bio</p>'
      );
    });

    it('puts the caption in front of a Set text that has no {title}', async () => {
      const { service } = build();

      const [applied] = await service.applyToPosts(
        ORG,
        CAPTION,
        [entry('int-yt', '<p>Subscribe at example.com</p>')],
        SET
      );

      expect(contentOf(applied)).toBe(
        `${html('youtube')}<p>Subscribe at example.com</p>`
      );
    });

    it('takes a text without HTML as plain text, one paragraph per line, escaped once', async () => {
      const { service } = build();

      const [inLine, inFront] = await service.applyToPosts(
        ORG,
        CAPTION,
        [
          entry('int-yt', 'Hello {title}! Q&A'),
          entry('int-x', 'Q&A 1 < 2'),
        ],
        SET
      );

      expect(contentOf(inLine)).toBe('<p>Hello Text for youtube #tips! Q&amp;A</p>');
      expect(contentOf(inFront)).toBe(`${html('x')}<p>Q&amp;A 1 &lt; 2</p>`);
    });

    it('gives a Set with no text at all the caption alone', async () => {
      const { service } = build();

      const [applied] = await service.applyToPosts(
        ORG,
        CAPTION,
        [entry('int-yt', '')],
        SET
      );

      expect(contentOf(applied)).toBe(html('youtube'));
    });

    it("keeps a title the Set already has, and changes only the first text (not the thread's comments)", async () => {
      const { service } = build();
      const post = {
        ...entry('int-yt', '<p>{title}</p>', { title: 'My weekly show' }),
        value: [
          { content: '<p>{title}</p>', delay: 0, image: [VIDEO] },
          { content: '<p>first comment {title}</p>', delay: 5, image: [] },
        ],
      };

      const [applied] = await service.applyToPosts(ORG, CAPTION, [post], SET);

      expect(applied.settings).toEqual({ title: 'My weekly show' });
      expect(applied.value[0].content).toBe(html('youtube'));
      expect(applied.value[1]).toBe(post.value[1]);
    });

    it("counts the Set's other text against the channel's limit and cuts only the caption", async () => {
      const long = `${'word '.repeat(70)}end`;
      const { service } = build(
        readyCaption({ outputs: [output('int-x', { text: long })] })
      );
      const setText = `<p>${'s'.repeat(100)}</p><p>{title}</p>`;

      const [applied] = await service.applyToPosts(
        ORG,
        CAPTION,
        [entry('int-x', setText)],
        SET
      );

      const content = contentOf(applied)!;
      expect(postTextLength('x', content)).toBeLessThanOrEqual(280);
      expect(content.startsWith(`<p>${'s'.repeat(100)}</p><p>word`)).toBe(true);
      expect(postTextLength('x', content)).toBeGreaterThan(250);
    });

    it("measures the limit with the Set's own settings (the provider's maxLength gets them)", async () => {
      const maxLength = jest.fn(() => 5000);
      const { service } = build();
      PROVIDERS.youtube = { maxLength };
      try {
        await service.applyToPosts(
          ORG,
          CAPTION,
          [entry('int-yt', '{title}', { type: 'unlisted' })],
          SET
        );
      } finally {
        PROVIDERS.youtube = { maxLength: () => 5000 };
      }

      expect(maxLength).toHaveBeenCalledWith([], { type: 'unlisted' });
    });
  });

  describe('a manual publish (the creator typed the caption)', () => {
    it("puts the caption first and the creator's text after it word for word, escaped", async () => {
      const { service } = build(
        readyCaption({ userText: 'Offer: example.com/a?b=1&c=2 <3\nLine two' })
      );
      // the app sends its usual body: the typed caption as the content
      const typed = entry('int-yt', '<p>Offer: example.com/a?b=1&amp;c=2 &lt;3</p><p>Line two</p>');

      const [applied] = await service.applyToPosts(ORG, CAPTION, [typed]);

      expect(contentOf(applied)).toBe(
        `${html('youtube')}<p>Offer: example.com/a?b=1&amp;c=2 &lt;3</p><p>Line two</p>`
      );
      expect(applied.value[0].image).toEqual([VIDEO]);
    });

    it('replaces the title the app derived with the caption\'s own', async () => {
      const { service } = build();

      const [applied] = await service.applyToPosts(ORG, CAPTION, [
        entry('int-yt', '<p>typed</p>', { type: 'public', title: 'typed' }),
      ]);

      expect(applied.settings).toEqual({
        type: 'public',
        title: 'A title from the talk',
      });
    });

    it("keeps the post's own text after the caption when the job kept none", async () => {
      const { service } = build();

      const [applied] = await service.applyToPosts(ORG, CAPTION, [
        entry('int-yt', '<p>typed in the body</p>'),
      ]);

      expect(contentOf(applied)).toBe(
        `${html('youtube')}<p>typed in the body</p>`
      );
    });

    it('with no text typed the caption stands alone', async () => {
      const { service } = build();

      const [applied] = await service.applyToPosts(ORG, CAPTION, [
        entry('int-x', ''),
      ]);

      expect(contentOf(applied)).toBe(html('x'));
    });

    it("keeps the creator's text whole and cuts only the caption to fit the channel", async () => {
      const long = `${'word '.repeat(80)}end`;
      const typed = 'Link: example.com/offer';
      const { service } = build(
        readyCaption({ userText: typed, outputs: [output('int-x', { text: long })] })
      );

      const [applied] = await service.applyToPosts(ORG, CAPTION, [
        entry('int-x', `<p>${typed}</p>`),
      ]);

      const content = contentOf(applied)!;
      expect(content.endsWith(`<p>${typed}</p>`)).toBe(true);
      expect(postTextLength('x', content)).toBeLessThanOrEqual(280);
      expect(content.startsWith('<p>word word')).toBe(true);
    });

    it('a channel that takes no video gets the text without the video', async () => {
      const { service } = build(readyCaption({ userText: 'My link' }));

      const [applied] = await service.applyToPosts(ORG, CAPTION, [
        entry('int-gmb', '<p>My link</p>'),
      ]);

      expect(contentOf(applied)).toBe(`${html('gmb')}<p>My link</p>`);
      expect(applied.value[0].image).toEqual([]);
    });

    it('without a READY caption a channel that takes no video keeps the typed text and loses the video, or is dropped when nothing was typed', async () => {
      const { service } = build(readyCaption({ status: 'FAILED' }));

      const applied = await service.applyToPosts(ORG, CAPTION, [
        entry('int-slack', '<p>typed text</p>'),
        entry('int-gmb', '<p></p>'),
        entry('int-yt', '<p>typed text</p>'),
      ]);

      expect(applied.map((p) => p.integration.id)).toEqual(['int-slack', 'int-yt']);
      expect(contentOf(applied[0])).toBe('<p>typed text</p>');
      expect(applied[0].value[0].image).toEqual([]);
      expect(applied[1].value[0].image).toEqual([VIDEO]);
    });
  });

  describe('a provider with no `acceptsVideo`', () => {
    it('keeps its video and gets its text, as before the flag existed', async () => {
      const { service } = build();

      const [applied] = await service.applyToPosts(ORG, CAPTION, [entry('int-x')], SET);

      expect(applied.value[0].image).toEqual([VIDEO]);
    });
  });

  describe('leaves the posts as they came', () => {
    it('for a channel the workspace does not have, or a post with no text value', async () => {
      const { service } = build();
      const foreign = entry('int-other');
      const empty = { integration: { id: 'int-yt' }, settings: {}, value: [] };

      const applied = await service.applyToPosts(
        ORG,
        CAPTION,
        [foreign, empty],
        SET
      );

      expect(applied[0]).toBe(foreign);
      expect(applied[1]).toBe(empty);
    });

    it('when reading the caption fails: AI never breaks a publish', async () => {
      const { service, repo } = build();
      repo.getCaption.mockRejectedValue(new Error('database down'));
      const posts = [entry('int-yt'), entry('int-gmb')];

      const applied = await service.applyToPosts(ORG, CAPTION, posts, SET);

      expect(applied).toBe(posts);
    });

    it('for a READY caption with no texts at all: video channels as they were, text channels dropped', async () => {
      const { service } = build(readyCaption({ outputs: [] }));
      const youtube = entry('int-yt');

      const applied = await service.applyToPosts(
        ORG,
        CAPTION,
        [youtube, entry('int-gmb', '{title}', {}, [])],
        SET
      );

      expect(applied).toEqual([youtube]);
    });
  });
});

describe('ai.video-captions: AiCaptionsService.linkPosts', () => {
  it('records the post made for each channel on its text', async () => {
    const { service, repo } = build();

    await service.linkPosts(ORG, CAPTION, [
      { postId: 'post-1', integration: 'int-yt' },
      { postId: 'post-2', integration: 'int-x' },
    ]);

    expect(repo.linkOutputs).toHaveBeenCalledWith(ORG, CAPTION, [
      { integrationId: 'int-yt', postId: 'post-1' },
      { integrationId: 'int-x', postId: 'post-2' },
    ]);
  });

  it('does nothing when no post was made', async () => {
    const { service, repo } = build();

    await service.linkPosts(ORG, CAPTION, []);

    expect(repo.linkOutputs).not.toHaveBeenCalled();
  });

  it('never fails the publish: the posts exist already', async () => {
    const { service, repo } = build();
    repo.linkOutputs.mockRejectedValue(new Error('database down'));

    await expect(
      service.linkPosts(ORG, CAPTION, [{ postId: 'post-1', integration: 'int-yt' }])
    ).resolves.toBeUndefined();
  });
});

// The provider classes are read as text: building them all needs every provider's packages, which this spec does not.
describe('ai.video-captions: the providers that take no video', () => {
  const dir = path.resolve(__dirname, '../../../integrations/social');
  const flagged = () =>
    fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.provider.ts'))
      .flatMap((file) => {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        const identifier = /^\s+identifier = '([^']+)'/m.exec(source)?.[1];
        return identifier && /^\s+acceptsVideo = false;/m.test(source)
          ? [identifier]
          : [];
      })
      .sort();

  it("are the ones whose checkValidity or post code never takes a video, and no other (an unset flag is a provider that takes one)", () => {
    expect(flagged()).toEqual([
      'devto',
      'dribbble',
      'gmb',
      'hashnode',
      'kick',
      'lemmy',
      'listmonk',
      'medium',
      'mewe',
      'moltbook',
      'nostr',
      'slack',
      'twitch',
      'wordpress',
      'wrapcast',
    ]);
  });

  it('include every provider that can get a text post from a recording', () => {
    expect(flagged()).toEqual(expect.arrayContaining(Object.keys(TEXT_POST_DEFAULTS)));
  });
});

// The order of the calls is read from the source: the hand-made stand-ins above cannot say where a controller or a
// service calls the captions.
describe('ai.video-captions: where the caption is applied', () => {
  const root = path.resolve(__dirname, '../../../../../..');
  const read = (file: string) =>
    fs.readFileSync(path.join(root, file), 'utf8');
  // The text of the source from `from` up to the next `to`.
  const between = (source: string, from: string, to: string) => {
    const start = source.indexOf(from);
    return source.slice(start, source.indexOf(to, start));
  };
  const controller = read(
    'apps/backend/src/public-api/routes/v1/public.integrations.controller.ts'
  );

  it('createPostFromBody, the code POST /posts and POST /auto-publish share, knows nothing of captions', () => {
    const shared = between(
      controller,
      'private async createPostFromBody(',
      "@Delete('/posts/:id')"
    );

    expect(shared).not.toMatch(/aiCaption|applyToPosts|linkPosts/i);
    expect(shared.indexOf('mapTypeToPost(')).toBeGreaterThan(-1);
    expect(shared.indexOf('validatePosts(')).toBeGreaterThan(
      shared.indexOf('mapTypeToPost(')
    );
    expect(shared.indexOf('createPost(orgId, body')).toBeGreaterThan(
      shared.indexOf('validatePosts(')
    );
  });

  it('POST /posts applies the caption to the posts it hands to the shared code, and links the posts made', () => {
    const handler = between(controller, "@Post('/posts')", "@Get('/posts/status')");

    expect(handler.indexOf('applyToPosts(')).toBeGreaterThan(-1);
    expect(handler.indexOf('linkPosts(')).toBeGreaterThan(
      handler.indexOf('applyToPosts(')
    );
    // the captions are applied inside the arguments of the shared code's call, so before it runs
    expect(handler.lastIndexOf('createPostFromBody(')).toBeLessThan(
      handler.indexOf('applyToPosts(')
    );
  });

  it('POST /auto-publish builds the body, hands it to the shared code, then links the posts made', () => {
    const handler = between(controller, "@Post('/auto-publish')", "@Put('/auto-publish/channels");

    expect(handler.indexOf('buildPostBody(')).toBeLessThan(
      handler.indexOf('createPostFromBody(')
    );
    expect(handler.indexOf('linkPosts(')).toBeGreaterThan(
      handler.indexOf('createPostFromBody(')
    );
  });

  it("buildPostBody applies the caption while {title} is still in the text, before the title is filled and replaced", () => {
    const service = read(
      'libraries/nestjs-libraries/src/database/prisma/auto-publish/auto.publish.service.ts'
    );
    const body = between(service, 'async buildPostBody(', 'async postStatuses(');

    expect(body.indexOf('applyToPosts(')).toBeGreaterThan(-1);
    expect(body.indexOf('this.settingsWithTitle(')).toBeGreaterThan(
      body.indexOf('applyToPosts(')
    );
    expect(body.indexOf('.split(TITLE_PLACEHOLDER)')).toBeGreaterThan(
      body.indexOf('applyToPosts(')
    );
  });
});
