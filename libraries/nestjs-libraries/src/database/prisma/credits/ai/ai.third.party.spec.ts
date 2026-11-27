// AI charging: a third-party provider function that calls an AI provider on the platform's
// key is declared through the provider's params and charged by the generic route as one ai.text. Driven
// through the real ThirdPartyController and AiChargingService against a real Postgres, with only the
// provider and its stored integration stubbed: with too few credits the provider is never called, a failed
// call leaves no committed charge, and a function the provider does not declare is free.
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
import { ThirdPartyController } from '@gitroom/backend/api/routes/third-party.controller';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

jest.mock('file-type', () => ({}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// Direct reads of the money tables use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('third-party AI functions (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let credits: CreditsService;
  let text: number;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;
  const savedSecret = process.env.JWT_SECRET;

  // The charging service on a given client, wired as the database module wires it.
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
        { getAllVideos: () => [] } as any
      ),
    };
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'third-party-spec';
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
    credits = chargingOn(api).credits;
    await new PricingService(
      new PricingRepository(new PrismaTransaction(api), repo, repo),
      credits,
      accounts
    ).sync();
    text = (await credits.quote('ai.text', 1, 'PRO')).unitCost;
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
    if (savedSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = savedSecret;
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
    return { org: { id: org.id } as any, accountId };
  };

  // The controller on a given client with a provider that declares `generateVoice` as an AI function and
  // `voices` as a free one; the provider functions answer what the test sets.
  const controllerOn = (
    prisma: PrismaService,
    functions: { generateVoice: jest.Mock; voices: jest.Mock }
  ) => {
    const manager = {
      getIntegrationById: jest.fn(async () => ({
        identifier: 'ai-provider',
        apiKey: AuthService.fixedEncryption('provider-key'),
      })),
      getThirdPartyByName: jest.fn(() => ({
        identifier: 'ai-provider',
        aiFunctions: ['generateVoice'],
        instance: functions,
      })),
    };
    return new ThirdPartyController(
      manager as any,
      {} as any,
      chargingOn(prisma).ai
    );
  };

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    const prisma = () => (role === 'api' ? api : workerService);

    it('a declared function is one committed ai.text and returns the provider answer', async () => {
      const ws = await workspace(3 * text);
      const functions = {
        generateVoice: jest.fn(async () => ({ voice: 'hello' })),
        voices: jest.fn(async () => []),
      };

      await expect(
        controllerOn(prisma(), functions).callFunction(ws.org, 'id-1', 'generateVoice', {
          text: 'a post',
        })
      ).resolves.toEqual({ voice: 'hello' });

      expect(functions.generateVoice).toHaveBeenCalledWith('provider-key', {
        text: 'a post',
      });
      expect(await credits.balance(ws.org.id)).toEqual({
        available: 2 * text,
        reserved: 0,
      });
      const ledgers = await worker.creditLedger.findMany({
        where: { accountId: ws.accountId },
      });
      expect(ledgers).toHaveLength(1);
      expect(ledgers[0]).toMatchObject({
        actionKey: 'ai.text',
        status: 'COMMITTED',
        committed: text,
        metadata: { kind: 'text', route: 'third-party.function' },
      });
    });

    it('zero balance: 402, the provider is never called and the ledger is unchanged', async () => {
      const ws = await workspace(0);
      const functions = {
        generateVoice: jest.fn(async () => ({ voice: 'hello' })),
        voices: jest.fn(async () => []),
      };

      const err = await controllerOn(prisma(), functions)
        .callFunction(ws.org, 'id-1', 'generateVoice', { text: 'a post' })
        .catch((e) => e);

      expect(err.getStatus()).toBe(402);
      expect(err.getResponse()).toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
      expect(functions.generateVoice).not.toHaveBeenCalled();
      expect(
        await worker.creditLedger.count({ where: { accountId: ws.accountId } })
      ).toBe(0);
    });

    it('a provider failure leaves no committed charge', async () => {
      const ws = await workspace(3 * text);
      const functions = {
        generateVoice: jest.fn(async () => {
          throw new Error('provider down');
        }),
        voices: jest.fn(async () => []),
      };

      await expect(
        controllerOn(prisma(), functions).callFunction(ws.org, 'id-1', 'generateVoice', {
          text: 'a post',
        })
      ).rejects.toBeDefined();

      expect(await credits.balance(ws.org.id)).toEqual({
        available: 3 * text,
        reserved: 0,
      });
      expect(
        await worker.creditLedger.count({
          where: { accountId: ws.accountId, status: 'COMMITTED' },
        })
      ).toBe(0);
    });

    it('a function the provider does not declare is free, even at zero balance', async () => {
      const ws = await workspace(0);
      const functions = {
        generateVoice: jest.fn(async () => ({ voice: 'hello' })),
        voices: jest.fn(async () => [{ voice_id: 'v1' }]),
      };

      await expect(
        controllerOn(prisma(), functions).callFunction(ws.org, 'id-1', 'voices', {})
      ).resolves.toEqual([{ voice_id: 'v1' }]);

      expect(functions.voices).toHaveBeenCalledTimes(1);
      expect(
        await worker.creditLedger.count({ where: { accountId: ws.accountId } })
      ).toBe(0);
    });
  });
});
