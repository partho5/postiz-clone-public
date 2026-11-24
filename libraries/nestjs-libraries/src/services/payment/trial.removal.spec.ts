// Trial state removal: a newly created organization is not in
// trial, and an existing one still marked as trial is not refused either, so video and clipping are
// limited only by the credit check. Driven through the real organization repository, media service
// and clipping service on a real Postgres, with the video types, storage and Temporal stubbed.
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
  selectWorkerDatabase,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { CreditsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { PricingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { AiChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service';
import { ClippingService } from '@gitroom/nestjs-libraries/database/prisma/clipping/clipping.service';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { OrganizationRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

jest.mock('file-type', () => ({}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock(
  '@gitroom/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: { set: async () => 'OK', del: async () => 1 },
}));

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('A new organization is not in trial (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  // A video type that is not a trial type, made by a stub that never renders anything.
  const plainVideo = {
    identifier: 'plain',
    title: 'Plain',
    trial: false,
    instance: {
      processAndValidate: async () => true,
      maxSeconds: () => 8,
      process: jest.fn(async () => 'https://video.test/out.mp4'),
      takeRenderedSeconds: () => 8,
    },
  };
  const videoManager = {
    getAllVideos: () => [plainVideo],
    getVideoByName: () => plainVideo,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    api = new PrismaService();
    await api.$connect();
    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    workerService = new PrismaService();
    await workerService.$connect();
    worker = new PrismaClient({ datasourceUrl: url });

    await wired().pricing.sync();
  });

  afterAll(async () => {
    await api.$disconnect();
    await workerService.$disconnect();
    await worker.$disconnect();
    if (savedWorkerUrl === undefined) {
      delete process.env.DATABASE_WORKER_URL;
    } else {
      process.env.DATABASE_WORKER_URL = savedWorkerUrl;
    }
  });

  // The credits, pricing and AI services on the API role, wired as the database module wires them.
  const wired = () => {
    const repo = new PrismaRepository<any>(api);
    const accountsService = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const moneyScope = new MoneyScope(
      new PrismaTransaction(api),
      accountsService
    );
    const creditsRepository = new CreditsRepository(
      moneyScope,
      repo,
      repo,
      repo
    );
    const credits = new CreditsService(
      creditsRepository,
      accountsService,
      moneyScope
    );
    const pricing = new PricingService(
      new PricingRepository(new PrismaTransaction(api), repo, repo),
      credits,
      accountsService
    );
    const ai = new AiChargingService(
      credits,
      creditsRepository,
      accountsService,
      pricing,
      videoManager as any
    );
    return { credits, pricing, ai };
  };

  // An organization created by the sign-up repository path, read back as the services receive it.
  const newOrganization = async () => {
    const repo = new PrismaRepository<any>(api);
    const created = await new OrganizationRepository(
      repo,
      repo,
      repo
    ).createOrgAndUser(
      {
        company: 'co-' + randomUUID(),
        email: randomUUID() + '@test.local',
        password: '',
        provider: 'GITHUB',
      } as any,
      '127.0.0.1',
      'jest'
    );
    return worker.organization.findUniqueOrThrow({ where: { id: created.id } });
  };

  // An organization row that predates the removal: still marked as trial, never migrated.
  const trialOrganization = async () => {
    const created = await newOrganization();
    return worker.organization.update({
      where: { id: created.id },
      data: { isTrailing: true, allowTrial: true },
    });
  };

  // The organizations the entry checks must accept: a new one and one still marked as trial.
  const organizations = [
    ['a new organization', newOrganization],
    ['an existing organization still marked as trial', trialOrganization],
  ] as const;

  // The real clipping service over stubbed storage and Temporal; `start` records a started workflow.
  const clippingService = (start: jest.Mock) => {
    const { ai, credits } = wired();
    const service = new ClippingService(
      { createClipping: jest.fn() } as any,
      ai,
      credits,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { client: { getRawClient: () => ({ workflow: { start } }) } } as any
    );
    Object.assign(service as any, {
      ingest: {},
      clipper: {},
      storage: {
        signDownloadUrl: async () => 'https://s.test/d',
        signUploadUrl: async () => 'https://s.test/u',
        removeFile: async () => undefined,
      },
    });
    return service;
  };

  it('is created with trial state off in the database', async () => {
    const org = await newOrganization();

    expect(org.isTrailing).toBe(false);
    expect(org.allowTrial).toBe(false);
  });

  it('marks an existing organization as trial in the database before the checks run', async () => {
    const org = await trialOrganization();

    expect(org.isTrailing).toBe(true);
    expect(org.allowTrial).toBe(true);
  });

  it.each(organizations)(
    'passes the video entry check for a type that is not a trial type: %s',
    async (_name, make) => {
      const { ai } = wired();
      const media = new MediaService(
        {} as any,
        {} as any,
        ai,
        videoManager as any,
        {} as any,
        {} as any
      );
      const org = await make();

      await expect(media.generateVideoAllowed(org, 'plain')).resolves.toBe(true);
    }
  );

  it.each(organizations)(
    'reaches the credit check on video generation: 402 INSUFFICIENT_CREDITS, never 406: %s',
    async (_name, make) => {
      const { ai } = wired();
      const media = new MediaService(
        {} as any,
        {} as any,
        ai,
        videoManager as any,
        { client: { getRawClient: () => ({}) } } as any,
        {} as any
      );
      const org = await make();
      const body = { type: 'plain', output: 'vertical', customParams: {} } as any;

      const direct = await media.generateVideo(org, body).catch((e) => e);
      const job = await media.startGenerateVideo(org, body).catch((e) => e);

      for (const err of [direct, job]) {
        expect(err.getStatus()).toBe(402);
        expect(err.getResponse()).toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
      }
      expect(plainVideo.instance.process).not.toHaveBeenCalled();
    }
  );

  it.each(organizations)(
    'reaches the credit check on clipping: 402 INSUFFICIENT_CREDITS, never 406: %s',
    async (_name, make) => {
      const start = jest.fn(async () => ({}));
      const service = clippingService(start);
      const org = await make();

      const err = await service
        .startClipping(org, {
          url: 'https://www.youtube.com/watch?v=abc',
          clips: 3,
        } as any)
        .catch((e) => e);

      expect(err.getStatus()).toBe(402);
      expect(err.getResponse()).toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
      expect(start).not.toHaveBeenCalled();
    }
  );
});
