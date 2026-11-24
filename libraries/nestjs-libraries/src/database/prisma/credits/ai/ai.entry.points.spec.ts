// AI charging: the entry points that call an AI provider go through AiChargingService. Each is
// driven through its real service or controller against a real Postgres, with only the providers and
// Temporal stubbed: with too few credits nothing is generated or charged, a failed generation leaves
// no committed charge.
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
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { VideoActivity } from '../../../../../../../apps/orchestrator/src/activities/video.activity';
import { VideoManager } from '@gitroom/nestjs-libraries/videos/video.manager';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

// The workflow id the video activity runs under; the activity reads it from Temporal's context.
let mockWorkflowId = '';
jest.mock('@temporalio/activity', () => ({
  ...jest.requireActual('@temporalio/activity'),
  Context: {
    current: () => ({
      info: { workflowExecution: { workflowId: mockWorkflowId } },
    }),
  },
}));
jest.mock('file-type', () => ({}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// Direct reads of the money tables use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('AI entry points (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let image: number;
  let second: number;
  const ai: Record<'api' | 'worker', AiChargingService> = {} as any;
  let credits: CreditsService;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  const ledgerOf = (k: string) =>
    worker.creditLedger.findUnique({ where: { idempotencyKey: k } });
  const balance = (organizationId: string) => credits.balance(organizationId);

  // Video types as the video manager's contract declares them; `rendered` is what the type recorded.
  const video = (seconds: number, rendered?: number) => {
    const instance = {
      processAndValidate: jest.fn(async () => undefined),
      process: jest.fn(async () => 'https://videos.test/out.mp4'),
      maxSeconds: () => seconds,
      takeRenderedSeconds: jest.fn(() => rendered),
    };
    const manager = {
      getAllVideos: () => [{ identifier: 'clip-type' }],
      getVideoByName: () => ({
        identifier: 'clip-type',
        trial: true,
        instance,
      }),
    } as unknown as VideoManager;
    return { instance, manager };
  };

  // The AI service on a given client, wired as the database module wires it.
  const chargingOn = (prisma: PrismaService, manager: VideoManager) => {
    const repo = new PrismaRepository<any>(prisma);
    const accountsService = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const moneyScope = new MoneyScope(
      new PrismaTransaction(prisma),
      accountsService
    );
    const creditsRepository = new CreditsRepository(
      moneyScope,
      repo,
      repo,
      repo
    );
    const creditsService = new CreditsService(
      creditsRepository,
      accountsService,
      moneyScope
    );
    return {
      credits: creditsService,
      ai: new AiChargingService(
        creditsService,
        creditsRepository,
        accountsService,
        new PricingService(
          new PricingRepository(new PrismaTransaction(prisma), repo, repo),
          creditsService,
          accountsService
        ),
        manager
      ),
    };
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

    const repo = new PrismaRepository<any>(api);
    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    const apiSide = chargingOn(api, video(8).manager);
    credits = apiSide.credits;
    await new PricingService(
      new PricingRepository(new PrismaTransaction(api), repo, repo),
      credits,
      accounts
    ).sync();
    image = (await credits.quote('ai.image', 1, 'PRO')).unitCost;
    second = (await credits.quote('ai.video.per_second', 1, 'PRO')).unitCost;
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

  // A workspace billed to its owner's account on a paid plan, holding credits.
  const workspace = async (amount: number) => {
    const org = await worker.organization.create({
      data: {
        name: 'ws-' + randomUUID(),
        users: {
          create: {
            role: 'SUPERADMIN',
            user: {
              create: {
                email: randomUUID() + '@test.local',
                providerName: 'LOCAL',
                timezone: 0,
              },
            },
          },
        },
      },
    });
    const accountId = await accounts.getAccountIdForOrganization(org.id);
    await worker.account.update({
      where: { id: accountId },
      data: { planKey: 'PRO' },
    });
    if (amount > 0) {
      await credits.grant(accountId, { type: 'GRANT', amount });
    }
    return { org: { id: org.id, isTrailing: false } as any, accountId };
  };

  // MediaService with providers stubbed: the OpenAI service, the video type, storage and Temporal.
  const media = (
    prisma: PrismaService,
    opts: { manager: VideoManager; image?: jest.Mock; start?: jest.Mock }
  ) => {
    const wired = chargingOn(prisma, opts.manager);
    const start = opts.start ?? jest.fn(async () => ({}));
    const service = new MediaService(
      {} as any,
      {
        generateImage: opts.image ?? jest.fn(async () => 'base64'),
        generatePromptForPicture: jest.fn(async (p: string) => p),
      } as any,
      wired.ai,
      opts.manager,
      { client: { getRawClient: () => ({ workflow: { start } }) } } as any,
      {} as any
    );
    (service as any).storage = {
      uploadSimple: jest.fn(async () => '/uploads/out.mp4'),
    };
    jest
      .spyOn(service, 'saveFile')
      .mockImplementation(
        async (org: string, name: string) =>
          ({ id: 'media-1', name, org } as any)
      );
    return { service, ai: wired.ai, start };
  };

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    const prisma = () => (role === 'api' ? api : workerService);

    describe('image generation (MediaService.generateImage)', () => {
      it('charges one ai.image and returns the picture', async () => {
        const ws = await workspace(3 * image);
        const provider = jest.fn(async () => 'base64');
        const { service } = media(prisma(), {
          manager: video(8).manager,
          image: provider,
        });

        await expect(service.generateImage('a cat', ws.org)).resolves.toBe(
          'base64'
        );

        expect(provider).toHaveBeenCalledTimes(1);
        expect(await balance(ws.org.id)).toEqual({
          available: 2 * image,
          reserved: 0,
        });
        const ledgers = await worker.creditLedger.findMany({
          where: { accountId: ws.accountId },
        });
        expect(ledgers).toHaveLength(1);
        expect(ledgers[0]).toMatchObject({
          actionKey: 'ai.image',
          status: 'COMMITTED',
          committed: image,
          metadata: { kind: 'image', route: expect.any(String) },
        });
        expect(ledgers[0].idempotencyKey).toMatch(/^ai:/);
      });

      it('zero balance: 402, the provider is never called and the ledger is unchanged', async () => {
        const ws = await workspace(0);
        const provider = jest.fn(async () => 'base64');
        const { service } = media(prisma(), {
          manager: video(8).manager,
          image: provider,
        });

        const err = await service
          .generateImage('a cat', ws.org)
          .catch((e) => e);

        expect(err.getStatus()).toBe(402);
        expect(err.getResponse()).toMatchObject({
          code: 'INSUFFICIENT_CREDITS',
        });
        expect(provider).not.toHaveBeenCalled();
        expect(
          await worker.creditLedger.count({
            where: { accountId: ws.accountId },
          })
        ).toBe(0);
      });

      it('a provider failure leaves no committed charge', async () => {
        const ws = await workspace(3 * image);
        const provider = jest.fn(async () => {
          throw new Error('provider down');
        });
        const { service } = media(prisma(), {
          manager: video(8).manager,
          image: provider,
        });

        await expect(
          service.generateImage('a cat', ws.org)
        ).rejects.toBeDefined();

        expect(await balance(ws.org.id)).toEqual({
          available: 3 * image,
          reserved: 0,
        });
        expect(
          await worker.creditLedger.count({
            where: { accountId: ws.accountId, status: 'COMMITTED' },
          })
        ).toBe(0);
      });
    });

    describe('video generation (MediaService.generateVideo, sync)', () => {
      it("holds the type's longest video, commits the rendered seconds and gives the rest back", async () => {
        const ws = await workspace(100 * second);
        const type = video(30, 12);
        const { service } = media(prisma(), { manager: type.manager });

        const saved = await service.generateVideo(ws.org, {
          type: 'clip-type',
          output: 'vertical',
          customParams: {},
        } as any);

        expect(saved).toMatchObject({ id: 'media-1' });
        const ledger = (
          await worker.creditLedger.findMany({
            where: { accountId: ws.accountId },
          })
        )[0];
        expect(ledger).toMatchObject({
          actionKey: 'ai.video.per_second',
          reserved: 30 * second,
          committed: 12 * second,
          status: 'COMMITTED',
          metadata: { kind: 'video', videoType: 'clip-type' },
        });
        expect(await balance(ws.org.id)).toEqual({
          available: 88 * second,
          reserved: 0,
        });
      });

      it('a type that records no length is charged its full maximum', async () => {
        const ws = await workspace(100 * second);
        const { service } = media(prisma(), { manager: video(8).manager });

        await service.generateVideo(ws.org, {
          type: 'clip-type',
          output: 'vertical',
          customParams: {},
        } as any);

        expect(await balance(ws.org.id)).toEqual({
          available: 92 * second,
          reserved: 0,
        });
      });

      it('too few credits for the maximum: 402, nothing is rendered, the ledger is unchanged', async () => {
        const ws = await workspace(30 * second - 1);
        const type = video(30, 12);
        const { service } = media(prisma(), { manager: type.manager });

        const err = await service
          .generateVideo(ws.org, {
            type: 'clip-type',
            output: 'vertical',
            customParams: {},
          } as any)
          .catch((e) => e);

        expect(err.getStatus()).toBe(402);
        expect(type.instance.process).not.toHaveBeenCalled();
        expect(
          await worker.creditLedger.count({
            where: { accountId: ws.accountId },
          })
        ).toBe(0);
      });

      it('a render that fails leaves no committed charge', async () => {
        const ws = await workspace(100 * second);
        const type = video(30, 12);
        type.instance.process.mockRejectedValueOnce(new Error('render failed'));
        const { service } = media(prisma(), { manager: type.manager });

        await expect(
          service.generateVideo(ws.org, {
            type: 'clip-type',
            output: 'vertical',
            customParams: {},
          } as any)
        ).rejects.toBeDefined();

        expect(await balance(ws.org.id)).toEqual({
          available: 100 * second,
          reserved: 0,
        });
      });
    });

    describe("video job (startGenerateVideo, then the workflow's activity)", () => {
      const body = {
        type: 'clip-type',
        output: 'vertical',
        customParams: {},
      } as any;

      it('reserves the maximum under the job key before the workflow starts, and the activity finishes that reservation at the rendered seconds', async () => {
        const ws = await workspace(100 * second);
        const type = video(30, 12);
        const started: { workflowId: string; heldWhenStarted?: unknown }[] = [];
        const start = jest.fn(
          async (_name: string, options: { workflowId: string }) => {
            started.push({
              workflowId: options.workflowId,
              heldWhenStarted: await balance(ws.org.id),
            });
          }
        );
        const { service } = media(prisma(), { manager: type.manager, start });

        const { jobId } = await service.startGenerateVideo(ws.org, body);

        expect(started).toEqual([
          {
            workflowId: jobId,
            heldWhenStarted: { available: 70 * second, reserved: 30 * second },
          },
        ]);
        const key = `ai:video:${jobId}`;
        expect(await ledgerOf(key)).toMatchObject({
          status: 'RESERVED',
          reserved: 30 * second,
        });

        mockWorkflowId = jobId;
        const activity = new VideoActivity(service, {
          getOrgByIdWithSubscription: async () => ws.org,
        } as any);
        await activity.generateVideo(ws.org.id, body);

        expect(await ledgerOf(key)).toMatchObject({
          status: 'COMMITTED',
          committed: 12 * second,
        });
        expect(await balance(ws.org.id)).toEqual({
          available: 88 * second,
          reserved: 0,
        });
        expect(
          await worker.creditLedger.count({
            where: { accountId: ws.accountId },
          })
        ).toBe(1);
      });

      it('a job that cannot be paid for is refused with 402 and no workflow starts', async () => {
        const ws = await workspace(30 * second - 1);
        const start = jest.fn();
        const { service } = media(prisma(), {
          manager: video(30, 12).manager,
          start,
        });

        const err = await service
          .startGenerateVideo(ws.org, body)
          .catch((e) => e);

        expect(err.getStatus()).toBe(402);
        expect(start).not.toHaveBeenCalled();
        expect(
          await worker.creditLedger.count({
            where: { accountId: ws.accountId },
          })
        ).toBe(0);
      });

      it('a workflow that fails to start gives the reservation back', async () => {
        const ws = await workspace(100 * second);
        const start = jest.fn(async () => {
          throw new Error('temporal down');
        });
        const { service } = media(prisma(), {
          manager: video(30, 12).manager,
          start,
        });

        await expect(service.startGenerateVideo(ws.org, body)).rejects.toThrow(
          'temporal down'
        );

        expect(await balance(ws.org.id)).toEqual({
          available: 100 * second,
          reserved: 0,
        });
        expect(
          await worker.creditLedger.count({
            where: { accountId: ws.accountId, status: 'RELEASED' },
          })
        ).toBe(1);
      });

      it("a render that fails in the activity releases the job's reservation", async () => {
        const ws = await workspace(100 * second);
        const type = video(30, 12);
        const { service } = media(prisma(), { manager: type.manager });
        const { jobId } = await service.startGenerateVideo(ws.org, body);
        type.instance.process.mockRejectedValueOnce(new Error('render failed'));
        mockWorkflowId = jobId;
        const activity = new VideoActivity(service, {
          getOrgByIdWithSubscription: async () => ws.org,
        } as any);

        await expect(
          activity.generateVideo(ws.org.id, body)
        ).rejects.toBeDefined();

        expect((await ledgerOf(`ai:video:${jobId}`))!.status).toBe('RELEASED');
        expect(await balance(ws.org.id)).toEqual({
          available: 100 * second,
          reserved: 0,
        });
      });

      it('an activity whose job was started before charging existed holds its own credits, and a 402 there is the non-retryable insufficient_credits', async () => {
        const ws = await workspace(1);
        const { service } = media(prisma(), { manager: video(30, 12).manager });
        mockWorkflowId = `video_${ws.org.id}_legacy`;
        const activity = new VideoActivity(service, {
          getOrgByIdWithSubscription: async () => ws.org,
        } as any);

        const err = await activity
          .generateVideo(ws.org.id, body)
          .catch((e) => e);

        expect(err).toMatchObject({
          type: 'insufficient_credits',
          nonRetryable: true,
        });
      });
    });
  });
});
