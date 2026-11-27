// AI charging: clipping is AI video priced per source minute. The credits are refused up front
// when not even one minute can be paid for, held once the real duration is known (before any media is
// paid for), committed when a clip rendered and returned when none did. Driven through the real
// ClippingService against a real Postgres, with the media service, storage and Temporal stubbed.
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
// Direct reads of the money tables use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('Clipping charging (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let minute: number;
  let cap: number;
  let credits: CreditsService;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  const ledgers = (accountId: string) =>
    worker.creditLedger.findMany({ where: { accountId } });
  const balance = (organizationId: string) => credits.balance(organizationId);

  // The credits and AI services on a given client, wired as the database module wires them.
  const chargingOn = (prisma: PrismaService) => {
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
    const pricing = new PricingService(
      new PricingRepository(new PrismaTransaction(prisma), repo, repo),
      creditsService,
      accountsService
    );
    return {
      credits: creditsService,
      pricing,
      ai: new AiChargingService(
        creditsService,
        creditsRepository,
        accountsService,
        pricing,
        { getAllVideos: () => [] } as any
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
    const apiSide = chargingOn(api);
    credits = apiSide.credits;
    await apiSide.pricing.sync();
    minute = (await credits.quote('ai.clip.per_minute', 1, 'PRO')).unitCost;
    cap = await apiSide.pricing.freeMonthlyAiCap();
    expect(cap).toBeGreaterThanOrEqual(2 * minute);
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

  // A workspace billed to its owner's account, holding credits, on the given plan.
  const workspace = async (amount: number, planKey = 'PRO') => {
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
      data: { planKey },
    });
    if (amount > 0) {
      await credits.grant(accountId, { type: 'GRANT', amount });
    }
    return { org: { id: org.id, isTrailing: false } as any, accountId };
  };

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    const wired = () => chargingOn(role === 'api' ? api : workerService);

    // The clipping service on the role's client, with the media service, storage and Temporal stubbed.
    const clipping = (
      opts: {
        record?: Record<string, unknown>;
        analyse?: Record<string, unknown>;
      } = {}
    ) => {
      const w = wired();
      const repository = {
        getClippingById: jest.fn(async () => opts.record),
        updateClipping: jest.fn(async () => undefined),
        failUnfinishedClips: jest.fn(async () => undefined),
        getRunningClippings: jest.fn(async () => []),
        countClippingsSince: jest.fn(async () => 0),
        createClipping: jest.fn(async () => ({ id: 'clipping-1' })),
      };
      const start = jest.fn(async () => ({}));
      const service = new ClippingService(
        repository as any,
        w.ai,
        w.credits,
        { getIntegrationById: async () => ({}) } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { client: { getRawClient: () => ({ workflow: { start } }) } } as any
      );
      const submit = jest.fn(async () => 'job-1');
      Object.assign(service as any, {
        ingest: {
          submit,
          status: jest.fn(async () => ({
            status: 'completed',
            result: opts.analyse,
          })),
        },
        clipper: {},
        storage: {
          signDownloadUrl: async () => 'https://s.test/d',
          signUploadUrl: async () => 'https://s.test/u',
          removeFile: async () => undefined,
        },
      });
      return { service, repository, start, submit };
    };

    const body = {
      url: 'https://www.youtube.com/watch?v=abc',
      clips: 3,
    } as any;
    const record = (ws: { org: any }, extra: Record<string, unknown> = {}) => ({
      id: `clip-${randomUUID()}`,
      organizationId: ws.org.id,
      url: body.url,
      status: 'analysing',
      clips: [],
      ...extra,
    });
    // What the media service answers for a video of this many seconds with captions that can be trusted.
    const analysed = (seconds: number) => ({
      status: 'completed',
      source: { duration_seconds: seconds, title: 'A talk' },
      transcript: { origin: 'auto_generated' },
      audio: {},
    });

    describe('POST /clipping (startClipping)', () => {
      it('refuses with 402 INSUFFICIENT_CREDITS when not even one source minute can be paid for, and starts nothing', async () => {
        const ws = await workspace(minute - 1);
        const c = clipping();

        const err = await c.service.startClipping(ws.org, body).catch((e) => e);

        expect(err.getStatus()).toBe(402);
        expect(err.getResponse()).toMatchObject({
          code: 'INSUFFICIENT_CREDITS',
          required: minute,
          available: minute - 1,
        });
        expect(c.repository.createClipping).not.toHaveBeenCalled();
        expect(c.start).not.toHaveBeenCalled();
        expect(await ledgers(ws.accountId)).toHaveLength(0);
      });

      it('refuses with 402 AI_CAP_REACHED on the free plan when the monthly cap leaves no minute, and starts nothing', async () => {
        const ws = await workspace(1000, 'FREE');
        await wired().ai.charge(
          {
            organizationId: ws.org.id,
            kind: 'image',
            quantity: Math.floor(cap / 5),
            idempotencyKey: `ai:${randomUUID()}`,
          },
          async () => 'x'
        );
        const c = clipping();

        const err = await c.service.startClipping(ws.org, body).catch((e) => e);

        expect(err.getStatus()).toBe(402);
        expect(err.getResponse()).toMatchObject({
          code: 'AI_CAP_REACHED',
          cap,
        });
        expect(c.repository.createClipping).not.toHaveBeenCalled();
        expect(c.start).not.toHaveBeenCalled();
      });

      it('starts when at least one minute can be paid for, and holds nothing yet (the duration is not known)', async () => {
        const ws = await workspace(minute);
        const c = clipping();

        await expect(c.service.startClipping(ws.org, body)).resolves.toEqual({
          id: 'clipping-1',
        });

        expect(c.start).toHaveBeenCalledTimes(1);
        expect(await ledgers(ws.accountId)).toHaveLength(0);
      });
    });

    describe('analysis (submitAnalyse, checkAnalyse)', () => {
      it('the video may be as long as the credits allow: whole minutes the balance pays for', async () => {
        const ws = await workspace(3 * minute + 1);
        const c = clipping({ record: record(ws) });

        await c.service.submitAnalyse('any');

        expect(c.submit.mock.calls[0][0]).toMatchObject({
          limits: { max_duration_seconds: 3 * 60 },
        });
      });

      it('no minute left to pay for stops the clipping with a message for the customer', async () => {
        const ws = await workspace(minute - 1);
        const c = clipping({ record: record(ws) });

        await expect(c.service.submitAnalyse('any')).rejects.toMatchObject({
          type: 'clipping_stop',
          nonRetryable: true,
        });
        expect(c.submit).not.toHaveBeenCalled();
      });

      it('holds ai.clip.per_minute × the source minutes rounded up, keyed by the clipping id, once the duration is known', async () => {
        const ws = await workspace(10 * minute);
        const rec = record(ws);
        const c = clipping({ record: rec, analyse: analysed(150) });

        await expect(c.service.checkAnalyse(rec.id, 'job-1')).resolves.toEqual({
          state: 'done',
          transcribe: false,
        });

        const [ledger] = await ledgers(ws.accountId);
        expect(ledger).toMatchObject({
          idempotencyKey: `ai:clip:${rec.id}`,
          actionKey: 'ai.clip.per_minute',
          quantity: 3,
          reserved: 3 * minute,
          status: 'RESERVED',
          organizationId: ws.org.id,
          metadata: { kind: 'clip', route: 'clipping' },
        });
        expect(c.repository.updateClipping).toHaveBeenCalledWith(
          ws.org.id,
          rec.id,
          expect.objectContaining({ duration: 150, creditsId: ledger.id })
        );
        expect(await balance(ws.org.id)).toEqual({
          available: 7 * minute,
          reserved: 3 * minute,
        });
      });

      it('a poll that runs again holds the credits once', async () => {
        const ws = await workspace(10 * minute);
        const rec = record(ws);
        const c = clipping({ record: rec, analyse: analysed(150) });

        await c.service.checkAnalyse(rec.id, 'job-1');
        await c.service.checkAnalyse(rec.id, 'job-1');

        expect(await ledgers(ws.accountId)).toHaveLength(1);
        expect(await balance(ws.org.id)).toEqual({
          available: 7 * minute,
          reserved: 3 * minute,
        });
      });

      it('a video that costs more than the credits left stops the clipping before any media is paid for, and the ledger is unchanged', async () => {
        const ws = await workspace(2 * minute);
        const rec = record(ws);
        const c = clipping({ record: rec, analyse: analysed(150) });

        const err = await c.service
          .checkAnalyse(rec.id, 'job-1')
          .catch((e) => e);

        expect(err).toMatchObject({
          type: 'clipping_stop',
          nonRetryable: true,
        });
        expect(err.message).toContain('3 minutes');
        expect(err.message).toContain(`${3 * minute} credits`);
        expect(c.repository.updateClipping).not.toHaveBeenCalled();
        expect(await ledgers(ws.accountId)).toHaveLength(0);
      });

      it('two clippings racing for credits that pay for one: one is held, the other stops', async () => {
        const ws = await workspace(3 * minute);
        const first = record(ws);
        const second = record(ws);

        const results = await Promise.all(
          [first, second].map((rec) =>
            clipping({ record: rec, analyse: analysed(150) })
              .service.checkAnalyse(rec.id, 'job-1')
              .then(
                () => 'held',
                (err) => err.type
              )
          )
        );

        expect(results.sort()).toEqual(['clipping_stop', 'held']);
        expect(await balance(ws.org.id)).toEqual({
          available: 0,
          reserved: 3 * minute,
        });
      });
    });

    describe('the end of a clipping (finishClipping, failClipping)', () => {
      // A clipping whose credits are held, as after checkAnalyse.
      const held = async (minutes: number, clips: { status: string }[]) => {
        const ws = await workspace(10 * minute);
        const rec = record(ws, {
          clips: clips.map((c, i) => ({ id: `c${i}`, ...c })),
        });
        await wired().ai.reserve({
          organizationId: ws.org.id,
          kind: 'clip',
          quantity: minutes,
          idempotencyKey: `ai:clip:${rec.id}`,
        });
        return { ws, rec, ...clipping({ record: rec }) };
      };

      it('finishing with a rendered clip commits the credits, and repeating it changes nothing', async () => {
        const { ws, rec, service } = await held(3, [
          { status: 'completed' },
          { status: 'failed' },
        ]);

        await service.finishClipping(rec.id);
        await service.finishClipping(rec.id);

        expect((await ledgers(ws.accountId))[0]).toMatchObject({
          status: 'COMMITTED',
          committed: 3 * minute,
        });
        expect(await balance(ws.org.id)).toEqual({
          available: 7 * minute,
          reserved: 0,
        });
      });

      it('finishing with no clip rendered gives the credits back', async () => {
        const { ws, rec, service } = await held(3, [{ status: 'failed' }]);

        await service.finishClipping(rec.id);

        expect((await ledgers(ws.accountId))[0].status).toBe('RELEASED');
        expect(await balance(ws.org.id)).toEqual({
          available: 10 * minute,
          reserved: 0,
        });
      });

      it('failing a clipping that rendered nothing gives the credits back', async () => {
        const { ws, rec, service } = await held(3, [{ status: 'failed' }]);

        await service.failClipping(rec.id, 'The video was removed', true);

        expect((await ledgers(ws.accountId))[0].status).toBe('RELEASED');
        expect(await balance(ws.org.id)).toEqual({
          available: 10 * minute,
          reserved: 0,
        });
      });

      it('failing a clipping after a clip rendered keeps the charge: the customer got something', async () => {
        const { ws, rec, service } = await held(3, [{ status: 'completed' }]);

        await service.failClipping(rec.id, 'Something went wrong afterwards');

        expect((await ledgers(ws.accountId))[0]).toMatchObject({
          status: 'COMMITTED',
          committed: 3 * minute,
        });
      });

      it('failing a clipping that never held credits (stopped before the analysis) has nothing to give back', async () => {
        const ws = await workspace(minute);
        const rec = record(ws);
        const c = clipping({ record: rec });

        await c.service.failClipping(rec.id, 'No captions', true);

        expect(c.repository.updateClipping).toHaveBeenCalledWith(
          ws.org.id,
          rec.id,
          expect.objectContaining({ status: 'failed' })
        );
        expect(await ledgers(ws.accountId)).toHaveLength(0);
        expect(await balance(ws.org.id)).toEqual({
          available: minute,
          reserved: 0,
        });
      });
    });
  });
});
