// Cost preview: POST /credits/quote answers the price of an action for the workspace's plan, from the
// server's price list, and the quote equals what the action then reserves. Runs against a real Postgres on both
// database roles.
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
import { CreditQuoteDto } from '@gitroom/nestjs-libraries/dtos/credits/credit.quote.dto';
import { CreditsQuoteController } from '@gitroom/backend/api/routes/credits.quote.controller';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

interface Services {
  credits: CreditsService;
  controller: CreditsQuoteController;
}

describeDb('POST /credits/quote (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  const roles: Record<'api' | 'worker', Services> = {} as any;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  // The credits service and the quote controller on a given client, wired as the database module wires them.
  const servicesOn = (prisma: PrismaService): Services => {
    const repo = new PrismaRepository<any>(prisma);
    const accountsService = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const moneyScope = new MoneyScope(
      new PrismaTransaction(prisma),
      accountsService
    );
    const credits = new CreditsService(
      new CreditsRepository(moneyScope, repo, repo, repo),
      accountsService,
      moneyScope
    );
    return { credits, controller: new CreditsQuoteController(credits) };
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
    roles.api = servicesOn(api);
    roles.worker = servicesOn(workerService);
    await new PricingService(
      new PricingRepository(new PrismaTransaction(api), repo, repo),
      roles.api.credits,
      accounts
    ).sync();
  });

  afterAll(async () => {
    await worker.creditPlanOverride.deleteMany({
      where: { planKey: { startsWith: 'QUOTE-' } },
    });
    await api.$disconnect();
    await workerService.$disconnect();
    await worker.$disconnect();
    if (savedWorkerUrl === undefined) {
      delete process.env.DATABASE_WORKER_URL;
    } else {
      process.env.DATABASE_WORKER_URL = savedWorkerUrl;
    }
  });

  // A workspace billed to its owner's account, on the given plan, holding credits.
  const workspace = async (credits: number, plan = 'FREE') => {
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
    if (plan !== 'FREE') {
      await worker.account.update({ where: { id: accountId }, data: { planKey: plan } });
    }
    if (credits > 0) {
      await roles.worker.credits.grant(accountId, { type: 'GRANT', amount: credits });
    }
    return { organizationId: org.id, accountId };
  };

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    // The controller of the role under test.
    const c = () => roles[role].controller;

    it('answers the unit cost, quantity and total of an action', async () => {
      const ws = await workspace(0);
      const unit = (await roles[role].credits.quote('post.publish', 1, 'FREE')).unitCost;

      const answer = await c().quote({ id: ws.organizationId } as any, {
        actionKey: 'post.publish',
        quantity: 3,
      });

      expect(answer).toEqual({
        actionKey: 'post.publish',
        unitCost: unit,
        quantity: 3,
        amount: 3 * unit,
      });
    });

    it('takes a quantity of 1 when none is given', async () => {
      const ws = await workspace(0);

      const answer = await c().quote({ id: ws.organizationId } as any, {
        actionKey: 'post.publish',
      });

      expect(answer.quantity).toBe(1);
      expect(answer.amount).toBe(answer.unitCost);
    });

    it('a quantity of 0 costs 0', async () => {
      const ws = await workspace(0);

      const answer = await c().quote({ id: ws.organizationId } as any, {
        actionKey: 'post.publish',
        quantity: 0,
      });

      expect(answer.amount).toBe(0);
    });

    it("quotes the price of the workspace's plan, not the default one", async () => {
      // A plan of its own, so no other spec's account sees this price; made just before it is read,
      // because another spec's price sync removes overrides that are not in the pricing file.
      const planKey = 'QUOTE-' + randomUUID();
      await worker.creditPlanOverride.create({
        data: { planKey, actionKey: 'post.publish', cost: 7 },
      });
      const ws = await workspace(0, planKey);

      const answer = await c().quote({ id: ws.organizationId } as any, {
        actionKey: 'post.publish',
        quantity: 2,
      });

      expect(answer).toMatchObject({ unitCost: 7, amount: 14 });
    });

    it('does not expose the price version', async () => {
      const ws = await workspace(0);

      const answer = await c().quote({ id: ws.organizationId } as any, {
        actionKey: 'post.publish',
      });

      expect(Object.keys(answer).sort()).toEqual([
        'actionKey',
        'amount',
        'quantity',
        'unitCost',
      ]);
    });

    it('answers 404 for an action with no price', async () => {
      const ws = await workspace(0);

      await expect(
        c().quote({ id: ws.organizationId } as any, {
          actionKey: 'no.such.action.' + randomUUID(),
        })
      ).rejects.toMatchObject({ status: 404 });
    });

    it('answers 400 for a quantity the engine refuses', async () => {
      const ws = await workspace(0);

      await expect(
        c().quote({ id: ws.organizationId } as any, {
          actionKey: 'post.publish',
          quantity: 1.5,
        })
      ).rejects.toMatchObject({ status: 400 });
    });

    it('equals what the action then reserves for the same inputs', async () => {
      const ws = await workspace(50);
      const answer = await c().quote({ id: ws.organizationId } as any, {
        actionKey: 'post.publish',
        quantity: 4,
      });

      const ledger = await roles[role].credits.reserve({
        organizationId: ws.organizationId,
        actionKey: 'post.publish',
        quantity: 4,
        idempotencyKey: 'quote:' + randomUUID(),
      });

      expect(ledger.reserved).toBe(answer.amount);
    });
  });

  describe('the route', () => {
    it('is POST /credits/quote and answers 200', () => {
      expect(Reflect.getMetadata(PATH_METADATA, CreditsQuoteController)).toBe('/credits');
      expect(
        Reflect.getMetadata(PATH_METADATA, CreditsQuoteController.prototype.quote)
      ).toBe('/quote');
      expect(
        Reflect.getMetadata(METHOD_METADATA, CreditsQuoteController.prototype.quote)
      ).toBe(RequestMethod.POST);
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, CreditsQuoteController.prototype.quote)
      ).toBe(200);
    });

    // Runs a body through the pipe as the backend's `main.ts` configures it.
    const parse = (body: Record<string, unknown>) =>
      new ValidationPipe({ transform: true }).transform(body, {
        type: 'body',
        metatype: CreditQuoteDto,
      });

    it('accepts an action key with or without a quantity', async () => {
      await expect(parse({ actionKey: 'post.publish' })).resolves.toMatchObject({
        actionKey: 'post.publish',
      });
      await expect(
        parse({ actionKey: 'post.publish', quantity: 2 })
      ).resolves.toMatchObject({ quantity: 2 });
    });

    it.each([
      [{}],
      [{ actionKey: '' }],
      [{ actionKey: 5 }],
      [{ actionKey: 'post.publish', quantity: -1 }],
      [{ actionKey: 'post.publish', quantity: 'many' }],
    ])('refuses %j with 400', async (body) => {
      await expect(parse(body)).rejects.toMatchObject({ status: 400 });
    });
  });
});
