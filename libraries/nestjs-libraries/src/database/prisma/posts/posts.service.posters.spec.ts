// api.media-retention (RET-B4): a purged video is shown as its poster in the web preview, in the answer
// only. Runs on a hand-made media service, so it needs no database.
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';

// Modules that pull ESM-only packages ts-jest cannot load; PostsService only names them as dependencies
jest.mock('file-type', () => ({}));
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);
jest.mock('@gitroom/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (value: string) => value,
  postContentPlainText: (value: string) => value,
}));

const ORG = 'org-1';
const savedBase = process.env.CLOUDFLARE_BUCKET_URL;

describe('api.media-retention: PostsService.showPosters (RET-B4)', () => {
  let asked: Array<{ org: string; ids: string[] }>;
  let service: PostsService;

  beforeEach(() => {
    process.env.CLOUDFLARE_BUCKET_URL = 'https://cdn.test/bucket';
    asked = [];
    service = Object.create(PostsService.prototype);
    (service as any)._mediaService = {
      // The workspace's purged media that have a poster
      getPosters: async (org: string, ids: string[]) => {
        asked.push({ org, ids });
        return org === ORG && ids.includes('purged')
          ? [{ id: 'purged', posterKey: 'poster00000000000001.jpg' }]
          : [];
      },
    };
  });

  afterAll(() => {
    if (savedBase === undefined) {
      delete process.env.CLOUDFLARE_BUCKET_URL;
    } else {
      process.env.CLOUDFLARE_BUCKET_URL = savedBase;
    }
  });

  it('replaces the path of a purged video with its poster URL and keeps the id', async () => {
    const images = [
      { id: 'purged', path: 'https://cdn.test/bucket/video.mp4' },
      { id: 'live', path: 'https://cdn.test/bucket/other.mp4' },
    ];

    const out = await service.showPosters(ORG, images);

    expect(out).toEqual([
      { id: 'purged', path: 'https://cdn.test/bucket/poster00000000000001.jpg' },
      { id: 'live', path: 'https://cdn.test/bucket/other.mp4' },
    ]);
    // the stored list is not changed
    expect(images[0].path).toBe('https://cdn.test/bucket/video.mp4');
    expect(asked).toEqual([{ org: ORG, ids: ['purged', 'live'] }]);
  });

  it("does not show another workspace's poster", async () => {
    const images = [{ id: 'purged', path: 'https://cdn.test/bucket/video.mp4' }];
    expect(await service.showPosters('org-2', images)).toEqual(images);
  });

  it('asks nothing for entries without an id', async () => {
    const images = [{ path: 'https://cdn.test/bucket/a.png' }];
    expect(await service.showPosters(ORG, images)).toEqual(images);
    expect(asked).toEqual([]);
  });

  it('previewImage answers the stored text as it was when it cannot be read', async () => {
    expect(await service.previewImage(ORG, 'not json')).toBe('not json');
    expect(await service.previewImage(ORG, null)).toBe('[]');
    const text = JSON.stringify([{ id: 'purged', path: 'x.mp4' }]);
    expect(JSON.parse((await service.previewImage(ORG, text))!)).toEqual([
      { id: 'purged', path: 'https://cdn.test/bucket/poster00000000000001.jpg' },
    ]);
  });
});
