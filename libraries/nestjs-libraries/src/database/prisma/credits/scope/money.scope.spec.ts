// Money-table row-level security: on the API role the credit tables show
// and accept only the scoped account's rows; the worker role bypasses them.
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
  selectWorkerDatabase,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  MoneyScope,
  MoneyScopeRequiredError,
} from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { CreditsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { PricingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { execFileSync, spawnSync } from 'child_process';
import { cpSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const PRISMA = ['dlx', 'prisma@6.5.0'];
const MIGRATIONS = join(__dirname, '..', '..', 'migrations');
const SCHEMA = join(__dirname, '..', '..', 'schema.prisma');
const ROLES = join(__dirname, 'money-roles.sh');

describeDb('MoneyScope and money-table RLS (Postgres)', () => {
  let api: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let scope: MoneyScope;
  let credits: CreditsService;

  // A credits service on a given client, wired as the database module wires it.
  const creditsOn = (prisma: PrismaService) => {
    const repo = new PrismaRepository<any>(prisma);
    const accountsService = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const moneyScope = new MoneyScope(
      new PrismaTransaction(prisma),
      accountsService
    );
    return new CreditsService(
      new CreditsRepository(moneyScope, repo, repo, repo),
      accountsService,
      moneyScope
    );
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    api = new PrismaService();
    await api.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    const repo = new PrismaRepository<any>(api);
    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    scope = new MoneyScope(new PrismaTransaction(api), accounts);
    credits = creditsOn(api);
    await new PricingService(
      new PricingRepository(new PrismaTransaction(api), repo, repo),
      credits,
      accounts
    ).sync();
  });

  afterAll(async () => {
    await api.$disconnect();
    await worker.$disconnect();
  });

  // A user with a workspace, billed to the user's own account.
  const workspace = async () => {
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
    return { organizationId: org.id, accountId };
  };

  const key = () => 'test:' + randomUUID();

  // An account with a grant and a reservation, so every money table has a row of it.
  const fundedAccount = async () => {
    const ws = await workspace();
    await credits.grant(ws.accountId, { type: 'GRANT', amount: 10 });
    const reservation = key();
    await credits.reserve({
      organizationId: ws.organizationId,
      actionKey: 'post.publish',
      idempotencyKey: reservation,
    });
    return { ...ws, reservation };
  };

  // The account's rows in all three money tables, read by the worker role.
  const rowsOf = async (accountId: string) => ({
    buckets: await worker.creditBucket.findMany({
      where: { accountId },
      orderBy: { id: 'asc' },
    }),
    ledgers: await worker.creditLedger.findMany({
      where: { accountId },
      orderBy: { id: 'asc' },
    }),
    entries: await worker.creditEntry.findMany({
      where: { accountId },
      orderBy: { id: 'asc' },
    }),
  });

  // Runs SQL through the Prisma CLI; returns its exit code.
  const execute = (target: string, sql: string) =>
    spawnSync(
      'pnpm',
      [...PRISMA, 'db', 'execute', '--url', target, '--stdin'],
      {
        input: sql,
        stdio: 'pipe',
      }
    ).status;

  // Connection string for another database on the test server.
  const urlFor = (database: string, credentials?: string) => {
    const target = new URL(url!);
    target.pathname = '/' + database;
    if (credentials) {
      target.username = credentials;
      target.password = credentials;
    }
    return target.toString();
  };

  // Runs the role script as the worker role against a database.
  const grantRoles = (target: string, apiUser = 'money_api_test') =>
    spawnSync('sh', [ROLES], {
      env: {
        ...process.env,
        DATABASE_WORKER_URL: target,
        APP_DB_USER: apiUser,
        APP_DB_PASSWORD: 'money_api_test',
      },
      encoding: 'utf8',
    });

  it('shows the API role no money rows when no account is set', async () => {
    const { accountId } = await fundedAccount();
    const seen = await rowsOf(accountId);
    expect(seen.buckets.length).toBeGreaterThan(0);
    expect(seen.ledgers.length).toBeGreaterThan(0);
    expect(seen.entries.length).toBeGreaterThan(0);

    expect(await api.creditBucket.findMany({ where: { accountId } })).toEqual(
      []
    );
    expect(await api.creditLedger.findMany({ where: { accountId } })).toEqual(
      []
    );
    expect(await api.creditEntry.findMany({ where: { accountId } })).toEqual(
      []
    );
  });

  it('refuses writes to money rows when no account is set', async () => {
    const { accountId } = await fundedAccount();
    const before = await rowsOf(accountId);
    await expect(
      api.creditBucket.create({
        data: { accountId, type: 'PROMO', initial: 5, remaining: 5 },
      })
    ).rejects.toThrow();
    expect(
      (
        await api.creditBucket.updateMany({
          where: { accountId },
          data: { remaining: 999 },
        })
      ).count
    ).toBe(0);
    expect(
      (await api.creditEntry.deleteMany({ where: { accountId } })).count
    ).toBe(0);
    expect(await rowsOf(accountId)).toEqual(before);
  });

  it('hides and protects another account inside a scoped transaction', async () => {
    const other = await fundedAccount();
    const mine = await fundedAccount();
    const before = await rowsOf(other.accountId);

    const seen = await scope.run(mine.accountId, async (tx) => ({
      buckets: await tx.creditBucket.findMany({
        where: { accountId: other.accountId },
      }),
      ledgers: await tx.creditLedger.findMany({
        where: { accountId: other.accountId },
      }),
      entries: await tx.creditEntry.findMany({
        where: { accountId: other.accountId },
      }),
      updated: (
        await tx.creditBucket.updateMany({
          where: { accountId: other.accountId },
          data: { remaining: 999 },
        })
      ).count,
      deleted: (
        await tx.creditEntry.deleteMany({
          where: { accountId: other.accountId },
        })
      ).count,
    }));
    expect(seen).toEqual({
      buckets: [],
      ledgers: [],
      entries: [],
      updated: 0,
      deleted: 0,
    });

    await expect(
      scope.run(mine.accountId, (tx) =>
        tx.creditBucket.create({
          data: {
            accountId: other.accountId,
            type: 'PROMO',
            initial: 5,
            remaining: 5,
          },
        })
      )
    ).rejects.toThrow();
    // Moving an own row to the other account is refused too
    await expect(
      scope.run(mine.accountId, (tx) =>
        tx.creditBucket.updateMany({
          where: { accountId: mine.accountId },
          data: { accountId: other.accountId },
        })
      )
    ).rejects.toThrow();
    expect(await rowsOf(other.accountId)).toEqual(before);
  });

  it('shows the scoped account its own rows', async () => {
    const { accountId } = await fundedAccount();
    const expected = await rowsOf(accountId);
    const seen = await scope.run(accountId, async (tx) => ({
      buckets: await tx.creditBucket.findMany({
        where: { accountId },
        orderBy: { id: 'asc' },
      }),
      ledgers: await tx.creditLedger.findMany({
        where: { accountId },
        orderBy: { id: 'asc' },
      }),
      entries: await tx.creditEntry.findMany({
        where: { accountId },
        orderBy: { id: 'asc' },
      }),
    }));
    expect(seen).toEqual(expected);
  });

  it('holds the account row lock for the whole scoped transaction', async () => {
    const { accountId } = await workspace();
    const spans: { start: number; end: number }[] = [];
    const locked = () =>
      scope.run(
        accountId,
        async () => {
          const start = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 300));
          spans.push({ start, end: Date.now() });
        },
        { lock: true }
      );
    await Promise.all([locked(), locked()]);
    spans.sort((a, b) => a.start - b.start);
    expect(spans[1].start).toBeGreaterThanOrEqual(spans[0].end);
  });

  it('refuses to run without an account id', () => {
    expect(() => scope.run('', async () => 1)).toThrow();
  });

  it('finds the account of a workspace', async () => {
    const { organizationId, accountId } = await workspace();
    expect(await scope.accountIdFor(organizationId)).toBe(accountId);
  });

  // Runs fn with a credits service on the worker role, as the orchestrator gets it.
  const onWorkerRole = async (fn: (workerCredits: CreditsService) => Promise<void>) => {
    const saved = process.env.DATABASE_WORKER_URL;
    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    const workerService = new PrismaService();
    try {
      expect(workerService.role).toBe('worker');
      await fn(creditsOn(workerService));
    } finally {
      await workerService.$disconnect();
      if (saved === undefined) {
        delete process.env.DATABASE_WORKER_URL;
      } else {
        process.env.DATABASE_WORKER_URL = saved;
      }
    }
  };

  // A commit or release naming one workspace must not find another account's reservation.
  const expectOtherReservationUnknown = async (service: CreditsService) => {
    const other = await fundedAccount();
    const mine = await workspace();
    await credits.grant(mine.accountId, { type: 'GRANT', amount: 10 });
    const before = await rowsOf(other.accountId);

    const err = await service
      .commit(other.reservation, undefined, mine.organizationId)
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(409);
    expect(
      await service.release(other.reservation, mine.organizationId)
    ).toBeNull();

    expect(await rowsOf(other.accountId)).toEqual(before);
    expect(await credits.balance(mine.organizationId)).toEqual({
      available: 10,
      reserved: 0,
    });
  };

  it('treats a reservation of another account as unknown when a workspace is given', async () => {
    await expectOtherReservationUnknown(credits);
  });

  it('treats a reservation of another account as unknown on the worker role too', async () => {
    await onWorkerRole(expectOtherReservationUnknown);
  });

  // A grant key held by one account is a 409 for another, and grants it nothing;
  // the owner still gets its own bucket back.
  const expectForeignGrantKeyConflict = async (service: CreditsService) => {
    const owner = await workspace();
    const mine = await workspace();
    const grantKey = 'grant:' + randomUUID();
    const { bucket } = await credits.grant(owner.accountId, {
      type: 'PROMO',
      amount: 3,
      grantKey,
    });
    const before = await rowsOf(owner.accountId);

    const err = await service
      .grant(mine.accountId, { type: 'PROMO', amount: 3, grantKey })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(409);

    expect(await rowsOf(owner.accountId)).toEqual(before);
    expect(await rowsOf(mine.accountId)).toEqual({
      buckets: [],
      ledgers: [],
      entries: [],
    });
    expect(
      await service.grant(owner.accountId, { type: 'PROMO', amount: 3, grantKey })
    ).toEqual({ bucket, created: false });
  };

  it('refuses a grant key that another account holds', async () => {
    await expectForeignGrantKeyConflict(credits);
  });

  it('refuses a grant key that another account holds on the worker role too', async () => {
    await onWorkerRole(expectForeignGrantKeyConflict);
  });

  // A reservation key held by another account is a 409 whatever the caller can
  // afford, through reserve and spend alike, and nothing is written.
  const expectForeignReservationKeyConflict = async (
    service: CreditsService
  ) => {
    const other = await fundedAccount();
    const broke = await workspace();
    const funded = await workspace();
    await credits.grant(funded.accountId, { type: 'GRANT', amount: 10 });
    const before = await rowsOf(other.accountId);
    const brokeBefore = await rowsOf(broke.accountId);
    const fundedBefore = await rowsOf(funded.accountId);
    const request = (organizationId: string) => ({
      organizationId,
      actionKey: 'post.publish',
      idempotencyKey: other.reservation,
    });

    for (const { organizationId } of [broke, funded]) {
      const reserved = await service
        .reserve(request(organizationId))
        .catch((e) => e);
      expect(reserved).toBeInstanceOf(HttpException);
      expect(reserved.getStatus()).toBe(409);

      const run = jest.fn();
      const spent = await service
        .spend(request(organizationId), run)
        .catch((e) => e);
      expect(spent).toBeInstanceOf(HttpException);
      expect(spent.getStatus()).toBe(409);
      expect(run).not.toHaveBeenCalled();
    }

    expect(await rowsOf(other.accountId)).toEqual(before);
    expect(await rowsOf(broke.accountId)).toEqual(brokeBefore);
    expect(await rowsOf(funded.accountId)).toEqual(fundedBefore);
  };

  it('refuses a key that another account already reserved', async () => {
    await expectForeignReservationKeyConflict(credits);
  });

  it('refuses a key that another account already reserved on the worker role too', async () => {
    await onWorkerRole(expectForeignReservationKeyConflict);
  });

  it('rolls back a reservation the account cannot afford, so the key stays free', async () => {
    const { organizationId, accountId } = await workspace();
    const reservation = key();
    const err = await credits
      .reserve({ organizationId, actionKey: 'post.publish', idempotencyKey: reservation })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(402);
    expect(await rowsOf(accountId)).toEqual({
      buckets: [],
      ledgers: [],
      entries: [],
    });

    await credits.grant(accountId, { type: 'GRANT', amount: 1 });
    expect(
      (
        await credits.reserve({
          organizationId,
          actionKey: 'post.publish',
          idempotencyKey: reservation,
        })
      ).status
    ).toBe('RESERVED');
  });

  it('commits and releases within the given workspace', async () => {
    const { organizationId, reservation } = await fundedAccount();
    expect(
      (await credits.commit(reservation, undefined, organizationId)).status
    ).toBe('COMMITTED');
    const other = key();
    await credits.reserve({
      organizationId,
      actionKey: 'post.publish',
      idempotencyKey: other,
    });
    expect((await credits.release(other, organizationId))!.status).toBe(
      'RELEASED'
    );
    expect(await credits.balance(organizationId)).toEqual({
      available: 9,
      reserved: 0,
    });
  });

  it('throws MoneyScopeRequiredError for a key-only commit or release on the API role', async () => {
    const { accountId, reservation } = await fundedAccount();
    const before = await rowsOf(accountId);
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      await expect(credits.commit(reservation)).rejects.toBeInstanceOf(
        MoneyScopeRequiredError
      );
      await expect(credits.release(reservation)).rejects.toBeInstanceOf(
        MoneyScopeRequiredError
      );
      // An unknown key is not a silent null either
      await expect(credits.release(key())).rejects.toBeInstanceOf(
        MoneyScopeRequiredError
      );
      expect(error).toHaveBeenCalledWith(expect.any(String), reservation);
    } finally {
      error.mockRestore();
    }
    expect(await rowsOf(accountId)).toEqual(before);
  });

  it('runs key-only commit and release on the worker role, as before', async () => {
    const { organizationId, reservation } = await fundedAccount();

    const saved = process.env.DATABASE_WORKER_URL;
    delete process.env.DATABASE_WORKER_URL;
    expect(() => selectWorkerDatabase()).toThrow('DATABASE_WORKER_URL');

    if (saved !== undefined) {
      process.env.DATABASE_WORKER_URL = saved;
    }
    await onWorkerRole(async (workerCredits) => {
      expect(api.role).toBe('api');
      expect((await workerCredits.commit(reservation)).status).toBe(
        'COMMITTED'
      );
      const other = key();
      await credits.reserve({
        organizationId,
        actionKey: 'post.publish',
        idempotencyKey: other,
      });
      expect((await workerCredits.release(other))!.status).toBe('RELEASED');
      expect(await workerCredits.release(key())).toBeNull();
      await expect(workerCredits.commit(key())).rejects.toThrow(
        'No reservation'
      );
    });
    expect(await credits.balance(organizationId)).toEqual({
      available: 9,
      reserved: 0,
    });
  });

  it('lets the backend Mastra store initialise on the API role', () => {
    // In a plain Node process: @mastra/pg loads ESM-only dependencies Jest cannot
    const init = spawnSync(
      'node',
      [
        '-e',
        `const { PostgresStore } = require('@mastra/pg');
        const store = new PostgresStore({ id: 'money-rls-test', connectionString: process.env.U });
        store.init().then(() => store.close()).then(() => process.exit(0),
          (err) => { console.error(err.message); process.exit(1); });`,
      ],
      {
        env: { ...process.env, U: process.env.TEST_DATABASE_API_URL },
        encoding: 'utf8',
      }
    );
    expect(init.stderr).toBe('');
    expect(init.status).toBe(0);
  });

  describe('on a database migrated from before row-level security', () => {
    const database = 'rls_' + randomUUID().replace(/-/g, '');
    const target = urlFor(database);
    let root: string;

    beforeAll(() => {
      execFileSync(
        'pnpm',
        [...PRISMA, 'db', 'execute', '--url', url!, '--stdin'],
        {
          input: `CREATE DATABASE "${database}";`,
          stdio: 'pipe',
        }
      );
      // The migrations as they were before this one
      root = mkdtempSync(join(tmpdir(), 'money-rls-'));
      cpSync(SCHEMA, join(root, 'schema.prisma'));
      cpSync(
        join(MIGRATIONS, '0_baseline'),
        join(root, 'migrations', '0_baseline'),
        {
          recursive: true,
        }
      );
      cpSync(
        join(MIGRATIONS, 'migration_lock.toml'),
        join(root, 'migrations', 'migration_lock.toml')
      );
      execFileSync(
        'pnpm',
        [
          ...PRISMA,
          'migrate',
          'deploy',
          '--schema',
          join(root, 'schema.prisma'),
        ],
        {
          env: { ...process.env, DATABASE_URL: target },
          stdio: 'pipe',
        }
      );
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
      execute(url!, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE);`);
    });

    it('keeps every existing row, grants the API role, and covers tables added later', async () => {
      const before = new PrismaClient({ datasourceUrl: target });
      let rows: unknown;
      try {
        const account = await before.account.create({
          data: {
            owner: {
              create: {
                email: randomUUID() + '@test.local',
                providerName: 'LOCAL',
                timezone: 0,
              },
            },
          },
        });
        const bucket = await before.creditBucket.create({
          data: {
            accountId: account.id,
            type: 'GRANT',
            initial: 5,
            remaining: 4,
          },
        });
        await before.creditEntry.create({
          data: {
            accountId: account.id,
            bucketId: bucket.id,
            kind: 'GRANT',
            delta: 5,
          },
        });
        await before.creditLedger.create({
          data: {
            accountId: account.id,
            actionKey: 'post.publish',
            actionVersion: 1,
            quantity: 1,
            unitCost: 1,
            reserved: 1,
            status: 'RESERVED',
            idempotencyKey: key(),
          },
        });
        const read = async () => ({
          buckets: await before.creditBucket.findMany(),
          ledgers: await before.creditLedger.findMany(),
          entries: await before.creditEntry.findMany(),
        });
        rows = await read();

        const deploy = spawnSync(
          'sh',
          [join(MIGRATIONS, 'migrate-deploy.sh')],
          {
            env: { ...process.env, DATABASE_URL: target },
            encoding: 'utf8',
          }
        );
        expect(deploy.status).toBe(0);
        expect(grantRoles(target).status).toBe(0);
        // Idempotent: a second deploy's role step changes nothing and succeeds
        expect(grantRoles(target).status).toBe(0);
        expect(await read()).toEqual(rows);
      } finally {
        await before.$disconnect();
      }

      const apiTarget = urlFor(database, 'money_api_test');
      const apiClient = new PrismaClient({ datasourceUrl: apiTarget });
      try {
        expect(await apiClient.creditBucket.findMany()).toEqual([]);
        expect(await apiClient.account.count()).toBe(1);
      } finally {
        await apiClient.$disconnect();
      }

      // A table a later migration adds (created by the worker role) is granted to the API role
      expect(execute(target, 'CREATE TABLE "MoneyRlsLater" (id int);')).toBe(0);
      expect(
        execute(apiTarget, 'INSERT INTO "MoneyRlsLater" VALUES (1);')
      ).toBe(0);
    });

    it('refuses an API role that is the worker role', () => {
      const result = grantRoles(target, new URL(url!).username);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'must not be the worker role'
      );
    });
  });
});
