// Free monthly grant and channel-connect charging: the real channel-connect
// controller on the API role, with the real credit, account and free-grant services. Only the
// provider's OAuth answer, Redis and the platform's channel save are stand-ins.
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { CreditsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { PricingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { PRICING } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import { CreditGrantsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.repository';
import { CreditGrantsService } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.service';
import { FreeGrantRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/free-grant/free.grant.repository';
import { FreeGrantService } from '@gitroom/nestjs-libraries/database/prisma/credits/free-grant/free.grant.service';
import { NoAuthIntegrationsController } from '@gitroom/backend/api/routes/no.auth.integrations.controller';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

// Modules that pull ESM-only packages ts-jest cannot load, or a live Redis; the connect paths
// under test only name them as dependencies. Redis is a map the tests fill.
const mockRedis = new Map<string, string>();
jest.mock('file-type', () => ({}));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    get: async (key: string) => mockRedis.get(key) ?? null,
    del: async (key: string) => mockRedis.delete(key),
  },
}));
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

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// Seeding and direct reads use the worker role; the controller runs as the API role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const CONNECT_PRICE = 3;
const currentMonth = () => new Date().toISOString().slice(0, 7);

describeDb('channel connect: free grant and connect charge (Postgres)', () => {
  let api: PrismaService;
  let worker: PrismaClient;
  let credits: CreditsService;
  let free: FreeGrantService;
  let accounts: AccountsService;
  let controller: NoAuthIntegrationsController;
  const priceOfConnect = PRICING.actions.find(
    (a) => a.key === 'channel.connect'
  )!.cost;
  // What the platform's channel save does next, set by a test
  let saveFails: Error | null = null;
  const savedPages: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    api = new PrismaService();
    await api.$connect();
    expect(api.role).toBe('api');
    worker = new PrismaClient({ datasourceUrl: url });

    const repo = new PrismaRepository<any>(api);
    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    const moneyScope = new MoneyScope(new PrismaTransaction(api), accounts);
    const creditsRepository = new CreditsRepository(
      moneyScope,
      repo,
      repo,
      repo
    );
    credits = new CreditsService(creditsRepository, accounts, moneyScope);
    await new PricingService(
      new PricingRepository(new PrismaTransaction(api), repo, repo),
      credits,
      accounts
    ).sync();
    free = new FreeGrantService(
      new FreeGrantRepository(repo, repo),
      new CreditGrantsService(
        creditsRepository,
        new CreditGrantsRepository(moneyScope)
      ),
      new PricingService(
        new PricingRepository(new PrismaTransaction(api), repo, repo),
        credits,
        accounts
      )
    );

    // The platform's OAuth answer: the channel id travels in the code
    const provider = {
      customFields: false,
      externalUrl: false,
      isBetweenSteps: false,
      oneTimeToken: false,
      isChromeExtension: false,
      authenticate: async ({ code }: { code: string }) => ({
        id: code,
        name: 'Channel ' + code,
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresIn: 1000,
        picture: '/no-picture.jpg',
        username: 'user-' + code,
        additionalSettings: [],
      }),
    };
    // The platform's channel save, writing the real row (upstream.channel-connect)
    const integrationService = {
      checkPreviousConnections: async () => false,
      migrateIntegration: async () => undefined,
      migrateIntegrationOnConnect: async () => undefined,
      createOrUpdateIntegration: async (
        _additionalSettings: unknown,
        _oneTimeToken: boolean,
        org: string,
        name: string,
        picture: string,
        type: string,
        internalId: string,
        providerIdentifier: string,
        token: string
      ) => {
        if (saveFails) {
          throw saveFails;
        }
        const where = {
          organizationId_internalId: { organizationId: org, internalId },
        };
        try {
          return await worker.integration.upsert({
            where,
            create: {
              organizationId: org,
              internalId,
              name,
              picture,
              type,
              providerIdentifier,
              token,
            },
            update: { deletedAt: null },
          });
        } catch (err: any) {
          if (err.code === 'P2002') {
            return worker.integration.findUniqueOrThrow({ where });
          }
          throw err;
        }
      },
      saveProviderPage: async (_org: string, id: string) => {
        savedPages.push(id);
        return { ok: true };
      },
    };
    controller = new NoAuthIntegrationsController(
      {
        getAllowedSocialsIntegrations: () => ['bluesky'],
        getSocialIntegration: () => provider,
      } as any,
      integrationService as any,
      { startRefreshWorkflow: async () => undefined } as any,
      {
        getOrgById: (id: string) =>
          worker.organization.findUniqueOrThrow({ where: { id } }),
      } as any,
      credits,
      accounts,
      free,
      // Runs the provider's authenticate as is; the workspace's app keys are not under test here.
      { runWithWorkspace: (_orgId: string, fn: () => Promise<unknown>) => fn() } as any
    );
  });

  afterEach(async () => {
    saveFails = null;
    jest.restoreAllMocks();
    await worker.creditAction.update({
      where: { key: 'channel.connect' },
      data: { cost: priceOfConnect },
    });
  });

  afterAll(async () => {
    await api.$disconnect();
    await worker.$disconnect();
  });

  // A workspace whose owner has not connected anything yet.
  const workspace = async (planKey = 'FREE') => {
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
    if (planKey !== 'FREE') {
      await worker.account.update({ where: { id: accountId }, data: { planKey } });
    }
    return { organizationId: org.id, accountId };
  };

  const setConnectPrice = (cost: number) =>
    worker.creditAction.update({
      where: { key: 'channel.connect' },
      data: { cost },
    });

  // Completes the OAuth callback for channel `internalId` of the workspace.
  const connect = (organizationId: string, internalId: string, refresh?: string) => {
    const state = randomUUID();
    mockRedis.set(`login:${state}`, 'verifier');
    mockRedis.set(`organization:${state}`, organizationId);
    return controller.connectSocialMedia('bluesky', {
      state,
      code: internalId,
      timezone: '0',
      ...(refresh ? { refresh } : {}),
    });
  };

  const connectLedgers = (organizationId: string) =>
    worker.creditLedger.findMany({
      where: { organizationId, actionKey: 'channel.connect' },
    });

  const ledgerOf = (organizationId: string, internalId: string) =>
    worker.creditLedger.findUnique({
      where: { idempotencyKey: `connect:${organizationId}:${internalId}` },
    });

  const freeBuckets = (accountId: string) =>
    worker.creditBucket.findMany({
      where: { accountId, grantKey: { startsWith: 'free:' } },
    });

  const channels = (organizationId: string) =>
    worker.integration.findMany({ where: { organizationId } });

  const fund = (accountId: string, amount: number) =>
    credits.grant(accountId, {
      type: 'TOPUP',
      amount,
      grantKey: `test:${randomUUID()}`,
    });

  const statusOf = (err: unknown) => {
    expect(err).toBeInstanceOf(HttpException);
    return err as HttpException;
  };

  describe('the free monthly grant', () => {
    it('grants the month\'s free credits when the first channel connects, and only then', async () => {
      const { organizationId, accountId } = await workspace();
      expect(await freeBuckets(accountId)).toEqual([]);
      expect((await credits.balance(organizationId)).available).toBe(0);

      const saved = await connect(organizationId, 'c1');
      expect(saved.id).toBeTruthy();
      const buckets = await freeBuckets(accountId);
      expect(buckets.map((b) => b.grantKey)).toEqual([
        `free:${accountId}:${currentMonth()}`,
      ]);
      expect(buckets[0]).toMatchObject({
        type: 'PROMO',
        initial: PRICING.free.monthlyGrant,
      });
      expect((await credits.balance(organizationId)).available).toBe(
        PRICING.free.monthlyGrant
      );
    });

    it('does not grant a second time for a second channel, a reconnect or a second workspace', async () => {
      const { organizationId, accountId } = await workspace();
      await connect(organizationId, 'c1');
      await connect(organizationId, 'c2');
      await connect(organizationId, 'c1', 'c1');
      const other = await worker.organization.create({
        data: { name: 'ws-' + randomUUID(), accountId },
      });
      await connect(other.id, 'c3');
      expect(await freeBuckets(accountId)).toHaveLength(1);
      expect((await credits.balance(organizationId)).available).toBe(
        PRICING.free.monthlyGrant
      );
    });

    it('grants nothing to an account on a paid plan', async () => {
      const { organizationId, accountId } = await workspace('STARTER');
      await connect(organizationId, 'c1');
      expect(await freeBuckets(accountId)).toEqual([]);
    });

    it('grants after the page choice completes a between-steps connect', async () => {
      const { organizationId, accountId } = await workspace();
      // The first step saved the channel before the grant existed (as an earlier release did)
      const first = await worker.integration.create({
        data: {
          organizationId,
          internalId: 'step-one',
          name: 'Step one',
          picture: '/no-picture.jpg',
          providerIdentifier: 'bluesky',
          type: 'social',
          token: 'token',
          inBetweenSteps: true,
        },
      });
      expect(await freeBuckets(accountId)).toEqual([]);

      const state = randomUUID();
      mockRedis.set(`organization:${state}`, organizationId);
      const answer = await controller.saveProviderPage(first.id, { state });

      expect(answer).toEqual({ ok: true });
      expect(savedPages).toContain(first.id);
      expect(
        (await freeBuckets(accountId)).map((b) => b.grantKey)
      ).toEqual([`free:${accountId}:${currentMonth()}`]);
    });

    it('never fails the connect when the grant fails, and the daily run gives it later', async () => {
      const { organizationId, accountId } = await workspace();
      const logged = jest.spyOn(console, 'error').mockImplementation();
      const grant = jest
        .spyOn(free, 'ensureMonthlyGrant')
        .mockRejectedValue(new Error('database unavailable'));

      const saved = await connect(organizationId, 'c1');
      expect(saved.id).toBeTruthy();
      expect(await channels(organizationId)).toHaveLength(1);
      expect(await freeBuckets(accountId)).toEqual([]);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('free grant after connect failed'),
        organizationId,
        expect.any(Error)
      );

      grant.mockRestore();
      await free.runMonthlyGrants();
      expect(await freeBuckets(accountId)).toHaveLength(1);
    });
  });

  describe('the connect charge at price 0 (as configured)', () => {
    it('records a zero ledger row per new channel and never refuses', async () => {
      const { organizationId } = await workspace();
      await connect(organizationId, 'c1');
      const ledger = await ledgerOf(organizationId, 'c1');
      expect(ledger).toMatchObject({
        actionKey: 'channel.connect',
        status: 'COMMITTED',
        unitCost: priceOfConnect,
        reserved: priceOfConnect,
        committed: priceOfConnect,
      });
      expect(priceOfConnect).toBe(0);
    });

    it('does not charge a reconnect of a channel the workspace connected before', async () => {
      const { organizationId } = await workspace();
      await connect(organizationId, 'c1');
      await connect(organizationId, 'c1', 'c1');
      expect(await connectLedgers(organizationId)).toHaveLength(1);
    });

    it('lets a failed connect be retried: the released key is reserved again and commits', async () => {
      const { organizationId } = await workspace();
      saveFails = new Error('channel save failed');
      await expect(connect(organizationId, 'c1')).rejects.toThrow(
        'channel save failed'
      );
      expect(await channels(organizationId)).toEqual([]);
      expect((await ledgerOf(organizationId, 'c1'))!.status).toBe('RELEASED');

      saveFails = null;
      await connect(organizationId, 'c1');
      expect(await channels(organizationId)).toHaveLength(1);
      expect((await ledgerOf(organizationId, 'c1'))!.status).toBe('COMMITTED');
    });
  });

  describe('the connect charge at a positive price', () => {
    beforeEach(async () => {
      await setConnectPrice(CONNECT_PRICE);
    });

    it('answers 402 INSUFFICIENT_CREDITS before the channel is saved when the balance is short', async () => {
      const { organizationId, accountId } = await workspace();
      const err = await connect(organizationId, 'c1').catch((e) => e);
      const http = statusOf(err);
      expect(http.getStatus()).toBe(402);
      expect(http.getResponse()).toMatchObject({
        code: 'INSUFFICIENT_CREDITS',
        required: CONNECT_PRICE,
        available: 0,
      });
      expect(await channels(organizationId)).toEqual([]);
      expect(await connectLedgers(organizationId)).toEqual([]);
      expect(await freeBuckets(accountId)).toEqual([]);
    });

    it('charges the price once for a new channel', async () => {
      const { organizationId, accountId } = await workspace();
      await fund(accountId, 10);
      await connect(organizationId, 'c1');
      expect(await ledgerOf(organizationId, 'c1')).toMatchObject({
        status: 'COMMITTED',
        unitCost: CONNECT_PRICE,
        committed: CONNECT_PRICE,
      });
      // 10 topped up, 3 spent, and the first channel brought the free credits
      expect((await credits.balance(organizationId)).available).toBe(
        10 - CONNECT_PRICE + PRICING.free.monthlyGrant
      );
    });

    it('does not charge a reconnect, a deleted channel connected again, or a channel that existed before', async () => {
      const { organizationId, accountId } = await workspace();
      await fund(accountId, 10);
      await connect(organizationId, 'c1');
      const after = (await credits.balance(organizationId)).available;

      await connect(organizationId, 'c1', 'c1');
      await worker.integration.updateMany({
        where: { organizationId, internalId: 'c1' },
        data: { deletedAt: new Date() },
      });
      await connect(organizationId, 'c1');
      // a channel saved before charging existed: a row and no ledger row
      await worker.integration.create({
        data: {
          organizationId,
          internalId: 'old',
          name: 'Old',
          picture: '/no-picture.jpg',
          providerIdentifier: 'bluesky',
          type: 'social',
          token: 'token',
        },
      });
      await connect(organizationId, 'old', 'old');

      expect(await connectLedgers(organizationId)).toHaveLength(1);
      expect((await credits.balance(organizationId)).available).toBe(after);
    });

    it('gives the credits back when the connect fails, and charges once when it is retried', async () => {
      const { organizationId, accountId } = await workspace();
      await fund(accountId, 10);
      saveFails = new Error('channel save failed');
      await expect(connect(organizationId, 'c1')).rejects.toThrow(
        'channel save failed'
      );
      expect((await ledgerOf(organizationId, 'c1'))!.status).toBe('RELEASED');
      expect(await credits.balance(organizationId)).toEqual({
        available: 10,
        reserved: 0,
      });
      expect(await freeBuckets(accountId)).toEqual([]);

      saveFails = null;
      await connect(organizationId, 'c1');
      expect(await ledgerOf(organizationId, 'c1')).toMatchObject({
        status: 'COMMITTED',
        committed: CONNECT_PRICE,
      });
      expect((await credits.balance(organizationId)).available).toBe(
        10 - CONNECT_PRICE + PRICING.free.monthlyGrant
      );
    });

    it('connects after a 402 once the account has topped up', async () => {
      const { organizationId, accountId } = await workspace();
      await expect(connect(organizationId, 'c1')).rejects.toBeInstanceOf(
        HttpException
      );
      await fund(accountId, CONNECT_PRICE);
      await connect(organizationId, 'c1');
      expect(await channels(organizationId)).toHaveLength(1);
      expect((await ledgerOf(organizationId, 'c1'))!.status).toBe('COMMITTED');
    });

    it('charges a channel submitted twice at once a single time', async () => {
      const { organizationId, accountId } = await workspace();
      await fund(accountId, 10);
      const results = await Promise.allSettled([
        connect(organizationId, 'c1'),
        connect(organizationId, 'c1'),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await channels(organizationId)).toHaveLength(1);
      expect(await connectLedgers(organizationId)).toHaveLength(1);
      expect((await credits.balance(organizationId)).available).toBe(
        10 - CONNECT_PRICE + PRICING.free.monthlyGrant
      );
    });
  });
});
