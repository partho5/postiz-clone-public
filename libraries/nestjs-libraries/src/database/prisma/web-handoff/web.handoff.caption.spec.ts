// api.web-handoff / ai.video-captions (AC8): the `ai-caption` target of POST /public/v1/web-link. A link opens
// `/ai-captions?open=<id>` signed in, in the request's workspace, and only for a live caption of that workspace: another
// workspace's caption, a deleted one and an unknown id are all a 404 CAPTION_NOT_FOUND with no link made. Runs the real
// service on hand-made repositories and an in-memory link store; needs no database and no Redis.
import { HttpException } from '@nestjs/common';
import { WebHandoffGrant } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.repository';
import { WebHandoffService } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.service';

// Modules that pull ESM-only packages or connect at import; nothing here calls them
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
  socialIntegrationList: [],
}));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {},
}));

const USER = 'user-1';
const SESSION = 'session-1';
const ACTIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('api.web-handoff: the ai-caption target', () => {
  let saved: Array<{ hash: string; grant: WebHandoffGrant; ttl: number }>;
  let store: Map<string, WebHandoffGrant>;
  let integrations: { isHiddenProvider: jest.Mock };
  let accounts: { getAccountById: jest.Mock; getOrganizationAccountId: jest.Mock };
  // The captions of every workspace; a deleted one has a `deletedAt`
  let captions: Array<{ id: string; organizationId: string; deletedAt: Date | null }>;
  let captionRepository: { getCaption: jest.Mock };
  let service: WebHandoffService;
  const env = process.env.FRONTEND_URL;

  beforeEach(() => {
    saved = [];
    store = new Map();
    captions = [
      { id: 'cap-1', organizationId: ACTIVE, deletedAt: null },
      { id: 'cap-2', organizationId: OTHER, deletedAt: null },
      { id: 'cap-3', organizationId: ACTIVE, deletedAt: new Date() },
    ];
    integrations = { isHiddenProvider: jest.fn().mockReturnValue(false) };
    accounts = { getAccountById: jest.fn(), getOrganizationAccountId: jest.fn() };
    // Reads like the real one: the workspace's own live caption, else null
    captionRepository = {
      getCaption: jest.fn(
        async (organizationId: string, id: string) =>
          captions.find(
            (c) => c.id === id && c.organizationId === organizationId && !c.deletedAt
          ) ?? null
      ),
    };
    service = new WebHandoffService(
      {
        save: async (hash: string, grant: WebHandoffGrant, ttl: number) => {
          saved.push({ hash, grant, ttl });
          store.set(hash, grant);
        },
        take: async (hash: string) => {
          const grant = store.get(hash) ?? null;
          store.delete(hash);
          return grant;
        },
      } as any,
      integrations as any,
      { findById: jest.fn(async () => ({ name: 'Pixel 8' })) } as any,
      accounts as any,
      captionRepository as any
    );
    process.env.FRONTEND_URL = 'https://app.test/';
  });

  afterEach(() => {
    if (env === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = env;
    }
  });

  // The error a link request rejects with.
  const refused = (id: string) =>
    service.createLink(USER, ACTIVE, SESSION, 'ai-caption', id).catch((e) => e);

  it("opens the caption's page in the request's workspace, signed in", async () => {
    const { url } = await service.createLink(USER, ACTIVE, SESSION, 'ai-caption', 'cap-1');

    expect(saved).toHaveLength(1);
    expect(saved[0].grant).toEqual({
      userId: USER,
      organizationId: ACTIVE,
      next: `/w/${ACTIVE}/ai-captions?open=cap-1`,
      deviceName: 'Pixel 8',
    });
    expect(saved[0].ttl).toBe(60);
    expect(url).toMatch(/^https:\/\/app\.test\/auth\/continue\?code=[A-Za-z0-9_-]{43}$/);
  });

  it('redeems once to that page, then never again', async () => {
    const { url } = await service.createLink(USER, ACTIVE, SESSION, 'ai-caption', 'cap-1');
    const code = url.split('code=')[1];

    expect(await service.redeem(code)).toEqual({
      userId: USER,
      next: `/w/${ACTIVE}/ai-captions?open=cap-1`,
      sessionName: 'Web browser (from Pixel 8)',
    });
    expect(await service.redeem(code)).toBeNull();
  });

  it("is a 404 CAPTION_NOT_FOUND for another workspace's caption, and no link is made", async () => {
    const err = await refused('cap-2');

    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(404);
    expect(err.getResponse()).toEqual({
      statusCode: 404,
      code: 'CAPTION_NOT_FOUND',
      message: 'Caption not found',
    });
    expect(saved).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('asks about the request\'s workspace and nobody else\'s', async () => {
    await refused('cap-2');
    await service.createLink(USER, ACTIVE, SESSION, 'ai-caption', 'cap-1');

    expect(captionRepository.getCaption.mock.calls).toEqual([
      [ACTIVE, 'cap-2'],
      [ACTIVE, 'cap-1'],
    ]);
  });

  it('is a 404 for a deleted caption and for an unknown id', async () => {
    for (const id of ['cap-3', 'nope']) {
      const err = await refused(id);

      expect(err.getStatus()).toBe(404);
      expect((err.getResponse() as any).code).toBe('CAPTION_NOT_FOUND');
    }
    expect(saved).toEqual([]);
  });

  it('keeps an id that is not plain text safe inside the page address', async () => {
    captions.push({ id: 'a b&c=d', organizationId: ACTIVE, deletedAt: null });

    await service.createLink(USER, ACTIVE, SESSION, 'ai-caption', 'a b&c=d');

    expect(saved[0].grant.next).toBe(`/w/${ACTIVE}/ai-captions?open=a%20b%26c%3Dd`);
  });

  it('is never asked about providers or accounts: a caption id is no provider and the page needs no plan owner', async () => {
    await service.createLink(USER, ACTIVE, SESSION, 'ai-caption', 'cap-1');

    expect(integrations.isHiddenProvider).not.toHaveBeenCalled();
    expect(accounts.getOrganizationAccountId).not.toHaveBeenCalled();
    expect(accounts.getAccountById).not.toHaveBeenCalled();
  });

  it('leaves the other targets without a caption lookup', async () => {
    await service.createLink(USER, ACTIVE, SESSION, 'connect', 'x');

    expect(captionRepository.getCaption).not.toHaveBeenCalled();
    expect(saved[0].grant.next).toBe(`/w/${ACTIVE}/launches?connect=x`);
  });
});
