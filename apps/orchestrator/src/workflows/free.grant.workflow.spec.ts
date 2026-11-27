// Free monthly grant (G-009): freeGrantWorkflow grants every eligible account its month's free
// credits at start, then waits 24 hours before it runs again.
//
// Runs the built workflow (pnpm run build:orchestrator) on a real Temporal server with the
// real FreeGrantActivity on a real Postgres (worker role). Run from the repo root:
//   TEST_DATABASE_URL=... TEST_TEMPORAL_ADDRESS=localhost:7233 npx jest \
//     -c libraries/nestjs-libraries/jest.config.cjs free.grant.workflow --roots '<rootDir>/apps/orchestrator/src'
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
import { PRICING } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import { CreditGrantsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.repository';
import { CreditGrantsService } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.service';
import { FreeGrantRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/free-grant/free.grant.repository';
import { FreeGrantService } from '@gitroom/nestjs-libraries/database/prisma/credits/free-grant/free.grant.service';
// relative: the jest config maps no @gitroom/orchestrator alias
import { FreeGrantActivity } from '../activities/free.grant.activity';
import { Client, Connection } from '@temporalio/client';
import {
  DefaultLogger,
  NativeConnection,
  Runtime,
  Worker,
} from '@temporalio/worker';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { resolve } from 'path';

const url = process.env.TEST_DATABASE_URL;
const address = process.env.TEST_TEMPORAL_ADDRESS;
const describeRun = url && address ? describe : describe.skip;

// The workflow as the orchestrator bundles it in production.
const workflowsPath = resolve(
  __dirname,
  '../../dist/apps/orchestrator/src/workflows/free.grant.workflow.js'
);

describeRun('freeGrantWorkflow (Temporal + Postgres)', () => {
  let prisma: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let client: Client;
  let connection: Connection;
  let nativeConnection: NativeConnection;
  let running: { worker: Worker; done: Promise<void> };
  const taskQueue = 'free-grant-' + randomUUID();
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  // The UTC month key the workflow grants for now.
  const monthKey = () => new Date().toISOString().slice(0, 7);

  beforeAll(async () => {
    if (!existsSync(workflowsPath)) {
      throw new Error(
        `Build the orchestrator first (pnpm run build:orchestrator): ${workflowsPath} is missing`
      );
    }
    Runtime.install({ logger: new DefaultLogger('WARN') });

    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    prisma = new PrismaService();
    expect(prisma.role).toBe('worker');
    await prisma.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    const repo = new PrismaRepository<any>(prisma);
    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    const moneyScope = new MoneyScope(new PrismaTransaction(prisma), accounts);
    const creditsRepository = new CreditsRepository(moneyScope, repo, repo, repo);
    const credits = new CreditsService(creditsRepository, accounts, moneyScope);
    const pricing = new PricingService(
      new PricingRepository(new PrismaTransaction(prisma), repo, repo),
      credits,
      accounts
    );
    await pricing.sync();
    const freeGrant = new FreeGrantService(
      new FreeGrantRepository(repo, repo),
      new CreditGrantsService(
        creditsRepository,
        new CreditGrantsRepository(moneyScope)
      ),
      pricing
    );

    connection = await Connection.connect({ address });
    client = new Client({ connection });
    nativeConnection = await NativeConnection.connect({ address });
    const activity = new FreeGrantActivity(freeGrant);
    const created = await Worker.create({
      connection: nativeConnection,
      taskQueue,
      workflowsPath,
      activities: { runMonthlyGrants: activity.runMonthlyGrants.bind(activity) },
      shutdownGraceTime: '100 ms',
    });
    running = { worker: created, done: created.run() };
  });

  afterAll(async () => {
    running?.worker.shutdown();
    await running?.done;
    await nativeConnection?.close();
    await connection?.close();
    await prisma?.$disconnect();
    await worker?.$disconnect();
    if (savedWorkerUrl === undefined) {
      delete process.env.DATABASE_WORKER_URL;
    } else {
      process.env.DATABASE_WORKER_URL = savedWorkerUrl;
    }
  });

  // A workspace on the given plan, with a channel when asked.
  const workspace = async (planKey: 'FREE' | 'PRO', withChannel: boolean) => {
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
    await worker.account.update({ where: { id: accountId }, data: { planKey } });
    if (withChannel) {
      await worker.integration.create({
        data: {
          organizationId: org.id,
          internalId: randomUUID(),
          name: 'channel-' + randomUUID(),
          picture: '/no-picture.jpg',
          providerIdentifier: 'bluesky',
          type: 'social',
          token: 'token',
        },
      });
    }
    return accountId;
  };

  const bucketsOf = (accountId: string) =>
    worker.creditBucket.findMany({ where: { accountId } });

  // Polls until check passes or ~30 s have gone.
  const eventually = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 300; i++) {
      if (await check()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  // Durations of the timers a workflow started, in ms.
  const timers = async (workflowId: string) => {
    const history = await client.workflow.getHandle(workflowId).fetchHistory();
    return (history.events || [])
      .map((e) => e.timerStartedEventAttributes?.startToFireTimeout)
      .filter(Boolean)
      .map((d) => Number(d!.seconds || 0) * 1000 + Math.round((d!.nanos || 0) / 1e6));
  };

  it('grants an eligible account the month at start, leaves the others alone, and waits 24 hours', async () => {
    const eligible = await workspace('FREE', true);
    const signedUp = await workspace('FREE', false);
    const paid = await workspace('PRO', true);

    const workflowId = 'free-grant-' + randomUUID();
    const handle = await client.workflow.start('freeGrantWorkflow', {
      taskQueue,
      workflowId,
    });
    try {
      const granted = await eventually(
        async () => (await bucketsOf(eligible)).length === 1
      );
      expect(granted).toBe(true);

      const [bucket] = await bucketsOf(eligible);
      expect(bucket.grantKey).toBe(`free:${eligible}:${monthKey()}`);
      expect(bucket.type).toBe('PROMO');
      expect(bucket.initial).toBe(PRICING.free.monthlyGrant);
      expect(await bucketsOf(signedUp)).toEqual([]);
      expect(await bucketsOf(paid)).toEqual([]);

      // the run is over and the workflow sleeps until the next day
      expect(await eventually(async () => (await timers(workflowId)).length > 0)).toBe(true);
      expect(await timers(workflowId)).toEqual([24 * 60 * 60 * 1000]);
      expect((await handle.describe()).status.name).toBe('RUNNING');
    } finally {
      await handle.terminate('test over').catch(() => undefined);
    }
  });

  it('a second workflow in the same month changes nothing', async () => {
    const eligible = await workspace('FREE', true);
    const first = await client.workflow.start('freeGrantWorkflow', {
      taskQueue,
      workflowId: 'free-grant-' + randomUUID(),
    });
    try {
      expect(await eventually(async () => (await bucketsOf(eligible)).length === 1)).toBe(true);
      const second = await client.workflow.start('freeGrantWorkflow', {
        taskQueue,
        workflowId: 'free-grant-' + randomUUID(),
      });
      try {
        expect(
          await eventually(async () => (await timers(second.workflowId)).length > 0)
        ).toBe(true);
        expect(await bucketsOf(eligible)).toHaveLength(1);
      } finally {
        await second.terminate('test over').catch(() => undefined);
      }
    } finally {
      await first.terminate('test over').catch(() => undefined);
    }
  });
});
