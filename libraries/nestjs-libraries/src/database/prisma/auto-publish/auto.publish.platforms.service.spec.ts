// api.platforms (B5): the order, status, channels and mode of GET /public/v1/platforms. Runs on
// hand-made stand-ins shaped like the service's dependencies; needs no database.
import { AutoPublishPlatformsService } from '@gitroom/nestjs-libraries/database/prisma/auto-publish/auto.publish.platforms.service';

// AutoPublishService names the captions service as a dependency; its real file needs the whole AI stack.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service',
  () => ({ AiCaptionsService: class {} })
);

const ORG = 'org-1';

// A provider as IntegrationManager.getAllIntegrations lists it.
const provider = (identifier: string, name = identifier) => ({
  identifier,
  name,
});

// One of the workspace's channels, as getIntegrationsList returns it.
const channel = (
  id: string,
  identifier: string,
  over: Record<string, unknown> = {}
) => ({
  id,
  name: `name-${id}`,
  providerIdentifier: identifier,
  picture: `https://cdn.test/${id}.png`,
  disabled: false,
  deletedAt: null,
  refreshNeeded: false,
  inBetweenSteps: false,
  ...over,
});

describe('api.platforms: AutoPublishPlatformsService', () => {
  const savedFrontend = process.env.FRONTEND_URL;
  let social: Array<{ identifier: string; name: string }>;
  let integrations: any[];
  let missing: Record<string, string[]>;
  let preset: any;
  let excluded: string[];
  let textOn: string[];
  let reads: string[];
  let service: AutoPublishPlatformsService;

  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://app.test/';
    social = [
      provider('reddit'),
      provider('instagram', 'Instagram\n(Facebook Business)'),
      provider('pinterest'),
      provider('youtube', 'YouTube'),
      provider('tiktok', 'TikTok'),
    ];
    integrations = [];
    missing = {};
    preset = null;
    excluded = [];
    textOn = [];
    reads = [];
    service = new AutoPublishPlatformsService(
      { getAllIntegrations: async () => ({ social, article: [] }) } as any,
      {
        getIntegrationsList: async () => {
          reads.push('integrations');
          return integrations;
        },
      } as any,
      {
        missingKeysByProvider: async (org: string, ids: string[]) => {
          reads.push('credentials');
          return new Map<string, string[]>(
            ids.map((id) => [id, missing[id] || []])
          );
        },
      } as any,
      {
        getPreset: async () => {
          reads.push('preset');
          return preset;
        },
        getExcluded: async () => {
          reads.push('excluded');
          return excluded;
        },
        getTextIntegrations: async () => {
          reads.push('textIntegrations');
          return textOn;
        },
      } as any
    );
  });

  afterAll(() => {
    process.env.FRONTEND_URL = savedFrontend;
  });

  it('lists video providers first in VIDEO_PLATFORMS order, then the rest in list order', async () => {
    const { platforms } = await service.list(ORG, 'ADMIN');

    expect(platforms.map((p) => [p.identifier, p.group])).toEqual([
      ['youtube', 'video'],
      ['tiktok', 'video'],
      ['instagram', 'video'],
      ['reddit', 'other'],
      ['pinterest', 'other'],
    ]);
  });

  it('gives a one-line name, an absolute icon and the guide link', async () => {
    const { platforms } = await service.list(ORG, 'ADMIN');
    const instagram = platforms.find((p) => p.identifier === 'instagram')!;

    expect(instagram.name).toBe('Instagram (Facebook Business)');
    expect(instagram.icon).toBe(
      'https://app.test/icons/platforms/instagram.png'
    );
    expect(typeof instagram.guideUrl).toBe('string');
  });

  it('is connected with a live channel, else needs credentials when keys are missing, else ready', async () => {
    integrations = [
      channel('yt-1', 'youtube'),
      channel('tt-setup', 'tiktok', { inBetweenSteps: true }),
    ];
    missing = { youtube: ['YOUTUBE_CLIENT_ID'], tiktok: ['TIKTOK_CLIENT_ID'] };

    const { platforms } = await service.list(ORG, 'ADMIN');
    const status = Object.fromEntries(
      platforms.map((p) => [p.identifier, p.status])
    );

    expect(status).toEqual({
      youtube: 'connected',
      tiktok: 'needs_credentials',
      instagram: 'ready_to_connect',
      reddit: 'ready_to_connect',
      pinterest: 'ready_to_connect',
    });
  });

  it('lists the channels with their switch: off when excluded or when the provider is never auto-published', async () => {
    integrations = [
      channel('yt-1', 'youtube'),
      channel('yt-2', 'youtube', { picture: null, refreshNeeded: true }),
      channel('rd-1', 'reddit'),
    ];
    excluded = ['yt-2'];

    const { platforms } = await service.list(ORG, 'ADMIN');
    const youtube = platforms.find((p) => p.identifier === 'youtube')!;
    const reddit = platforms.find((p) => p.identifier === 'reddit')!;

    expect(youtube.autoPublishSupported).toBe(true);
    expect(youtube.channels).toEqual([
      {
        id: 'yt-1',
        name: 'name-yt-1',
        picture: 'https://cdn.test/yt-1.png',
        disabled: false,
        refreshNeeded: false,
        autoPublish: true,
        textPostOn: false,
      },
      {
        id: 'yt-2',
        name: 'name-yt-2',
        picture: null,
        disabled: false,
        refreshNeeded: true,
        autoPublish: false,
        textPostOn: false,
      },
    ]);
    expect(reddit.autoPublishSupported).toBe(false);
    expect(reddit.channels.map((c) => c.autoPublish)).toEqual([false]);
  });

  it('answers automatic mode with no Set, preset mode with the Set name', async () => {
    expect((await service.list(ORG, 'ADMIN')).autoPublish).toEqual({
      mode: 'automatic',
    });

    preset = { setId: 'set-1', setName: 'Daily', timing: 'now' };

    expect((await service.list(ORG, 'ADMIN')).autoPublish).toEqual({
      mode: 'preset',
      presetName: 'Daily',
    });
  });

  it('lets only an admin manage credentials', async () => {
    expect((await service.list(ORG, 'ADMIN')).canManageCredentials).toBe(true);
    expect((await service.list(ORG, 'SUPERADMIN')).canManageCredentials).toBe(
      true
    );
    expect((await service.list(ORG, 'USER')).canManageCredentials).toBe(false);
    expect((await service.list(ORG)).canManageCredentials).toBe(false);
  });

  it('reads each source once, whatever the provider count', async () => {
    await service.list(ORG, 'ADMIN');

    expect(reads.sort()).toEqual(
      [
        'credentials',
        'excluded',
        'integrations',
        'preset',
        'textIntegrations',
      ].sort()
    );
  });

  it('marks the providers that can get a text post from a recording, and the channels switched on for it (ai.video-captions)', async () => {
    social = [
      provider('youtube', 'YouTube'),
      provider('gmb', 'Google Business'),
      provider('slack'),
    ];
    integrations = [
      channel('yt-1', 'youtube'),
      channel('gmb-1', 'gmb'),
      channel('gmb-2', 'gmb'),
      channel('sl-1', 'slack'),
    ];
    // a stale id of a provider that cannot get one is never reported as on
    textOn = ['gmb-2', 'yt-1', 'sl-1', 'gone'];

    const { platforms } = await service.list(ORG, 'ADMIN');
    const textPost = Object.fromEntries(
      platforms.map((p) => [p.identifier, p.textPost])
    );
    const on = Object.fromEntries(
      platforms.flatMap((p) => p.channels.map((c) => [c.id, c.textPostOn]))
    );

    expect(textPost).toEqual({ youtube: false, gmb: true, slack: false });
    expect(on).toEqual({
      'yt-1': false,
      'gmb-1': false,
      'gmb-2': true,
      'sl-1': false,
    });
  });
});
