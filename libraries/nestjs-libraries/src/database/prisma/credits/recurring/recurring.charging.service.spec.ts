// Recurring charging: a repeating post reserves its next occurrence ahead of time, is
// flagged while that reservation can't be paid, and holds nothing once it no longer repeats.
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
import { PublishChargingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.repository';
import { PublishChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.service';
import { RecurringChargingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/recurring/recurring.charging.repository';
import { RecurringChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/recurring/recurring.charging.service';
import { RecurringFlagsController } from '@gitroom/backend/api/routes/recurring.flags.controller';
import { HttpException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// Direct reads of the money tables use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

interface Services {
  credits: CreditsService;
  charging: PublishChargingService;
  recurring: RecurringChargingService;
}

describeDb('RecurringChargingService (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let unit: number;
  const roles: Record<'api' | 'worker', Services> = {} as any;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  const publishKey = (postId: string, integrationId: string, n = 1) =>
    `post:${postId}:integration:${integrationId}:publish${n === 1 ? '' : `:${n}`}`;
  const ledgerOf = (key: string) =>
    worker.creditLedger.findUnique({ where: { idempotencyKey: key } });
  const due = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

  // The recurring, charging and credits services on a given client, wired as the database module wires them.
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
    const charging = new PublishChargingService(
      credits,
      new PublishChargingRepository(moneyScope, repo)
    );
    const recurring = new RecurringChargingService(
      new RecurringChargingRepository(repo, repo),
      charging
    );
    return { credits, charging, recurring };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    api = new PrismaService();
    await api.$connect();
    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    workerService = new PrismaService();
    expect(api.role).toBe('api');
    expect(workerService.role).toBe('worker');
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
    unit = (await roles.api.credits.quote('post.publish', 1, 'FREE')).unitCost;
    expect(unit).toBeGreaterThan(0);
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

  // A workspace billed to its owner's account, holding credits, with one channel.
  const workspace = async (credits: number) => {
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
    if (credits > 0) {
      await roles.worker.credits.grant(accountId, {
        type: 'GRANT',
        amount: credits,
      });
    }
    const integration = await worker.integration.create({
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
    return { organizationId: org.id, accountId, integrationId: integration.id };
  };

  // A published post repeating every day on the workspace's channel.
  const repeatingPost = (
    ws: Awaited<ReturnType<typeof workspace>>,
    data: Record<string, unknown> = {}
  ) =>
    worker.post.create({
      data: {
        organizationId: ws.organizationId,
        integrationId: ws.integrationId,
        group: randomUUID(),
        content: '<p>again</p>',
        publishDate: new Date(),
        state: 'PUBLISHED',
        intervalInDays: 1,
        ...data,
      },
    });

  const balance = (organizationId: string) =>
    roles.api.credits.balance(organizationId);

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    const s = () => roles[role];

    it('reserves the next occurrence under its occurrence key and answers reserved: true', async () => {
      const ws = await workspace(5 * unit);
      const post = await repeatingPost(ws);
      const dueAt = due();

      await expect(
        s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, dueAt)
      ).resolves.toEqual({ reserved: true });

      expect(await ledgerOf(publishKey(post.id, ws.integrationId, 2))).toMatchObject({
        status: 'RESERVED',
        reserved: unit,
        organizationId: ws.organizationId,
      });
      expect(await balance(ws.organizationId)).toEqual({
        available: 4 * unit,
        reserved: unit,
      });
      expect(
        await worker.recurringCharge.findUnique({ where: { postId: post.id } })
      ).toEqual({ postId: post.id, occurrence: 2, dueAt, flaggedAt: null });
      expect(await s().recurring.flagsForPosts(ws.organizationId, [post.id])).toEqual({});
    });

    it('a repeated reserve of the same occurrence holds it once', async () => {
      const ws = await workspace(5 * unit);
      const post = await repeatingPost(ws);
      const dueAt = due();

      await s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, dueAt);
      await expect(
        s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, dueAt)
      ).resolves.toEqual({ reserved: true });

      expect(
        await worker.creditLedger.count({ where: { accountId: ws.accountId } })
      ).toBe(1);
      expect(await balance(ws.organizationId)).toEqual({
        available: 4 * unit,
        reserved: unit,
      });
    });

    it('not enough credits: reserved: false, the post is flagged, nothing is held', async () => {
      const ws = await workspace(0);
      const post = await repeatingPost(ws);
      const dueAt = due();
      const before = Date.now();

      await expect(
        s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, dueAt)
      ).resolves.toEqual({ reserved: false });

      expect(await ledgerOf(publishKey(post.id, ws.integrationId, 2))).toBeNull();
      const flags = await s().recurring.flagsForPosts(ws.organizationId, [post.id]);
      expect(flags).toEqual({
        [post.id]: {
          occurrence: 2,
          dueAt: dueAt.toISOString(),
          reason: 'INSUFFICIENT_CREDITS',
          since: expect.any(String),
        },
      });
      expect(new Date(flags[post.id].since).getTime()).toBeGreaterThanOrEqual(
        before - 1000
      );
    });

    it('a retry that still fails keeps the flag and when it was first raised', async () => {
      const ws = await workspace(0);
      const post = await repeatingPost(ws);
      const dueAt = due();

      await s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, dueAt);
      const first = await s().recurring.flagsForPosts(ws.organizationId, [post.id]);
      await s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, dueAt);

      expect(await s().recurring.flagsForPosts(ws.organizationId, [post.id])).toEqual(
        first
      );
    });

    it('a later success clears the flag', async () => {
      const ws = await workspace(0);
      const post = await repeatingPost(ws);
      const dueAt = due();
      await s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, dueAt);
      await roles.worker.credits.grant(ws.accountId, { type: 'GRANT', amount: unit });

      await expect(
        s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, dueAt)
      ).resolves.toEqual({ reserved: true });

      expect(await s().recurring.flagsForPosts(ws.organizationId, [post.id])).toEqual({});
      expect((await ledgerOf(publishKey(post.id, ws.integrationId, 2)))!.status).toBe(
        'RESERVED'
      );
    });

    it('a skipped occurrence keeps the flag until a later occurrence is paid', async () => {
      const ws = await workspace(0);
      const post = await repeatingPost(ws);
      await s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, due());
      const third = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);

      await expect(
        s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 3, third)
      ).resolves.toEqual({ reserved: false });
      expect(
        (await s().recurring.flagsForPosts(ws.organizationId, [post.id]))[post.id]
      ).toMatchObject({ occurrence: 3, dueAt: third.toISOString() });

      await roles.worker.credits.grant(ws.accountId, { type: 'GRANT', amount: unit });
      await s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 3, third);
      expect(await s().recurring.flagsForPosts(ws.organizationId, [post.id])).toEqual({});
      expect(await ledgerOf(publishKey(post.id, ws.integrationId, 2))).toBeNull();
    });

    it.each([
      ['deleted', { deletedAt: new Date() }],
      ['no longer repeating', { intervalInDays: null }],
      ['a thread follow-up', 'comment'],
    ] as const)(
      'a post that is %s: null, nothing held, its flag cleared',
      async (_name, change) => {
        const ws = await workspace(0);
        const post = await repeatingPost(ws);
        await s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, due());
        await roles.worker.credits.grant(ws.accountId, { type: 'GRANT', amount: 5 * unit });
        if (change === 'comment') {
          const parent = await repeatingPost(ws);
          await worker.post.update({
            where: { id: post.id },
            data: { parentPostId: parent.id },
          });
        } else {
          await worker.post.update({ where: { id: post.id }, data: change });
        }

        await expect(
          s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, due())
        ).resolves.toBeNull();

        expect(await ledgerOf(publishKey(post.id, ws.integrationId, 2))).toBeNull();
        expect(
          (await worker.recurringCharge.findUnique({ where: { postId: post.id } }))!
            .flaggedAt
        ).toBeNull();
        expect(await balance(ws.organizationId)).toEqual({
          available: 5 * unit,
          reserved: 0,
        });
      }
    );

    it('a post of another workspace or on another channel: null, nothing held', async () => {
      const ws = await workspace(5 * unit);
      const other = await workspace(5 * unit);
      const post = await repeatingPost(ws);

      await expect(
        s().recurring.reserveNext(other.organizationId, post.id, other.integrationId, 2, due())
      ).resolves.toBeNull();
      await expect(
        s().recurring.reserveNext(ws.organizationId, post.id, other.integrationId, 2, due())
      ).resolves.toBeNull();
      await expect(
        s().recurring.reserveNext(ws.organizationId, randomUUID(), ws.integrationId, 2, due())
      ).resolves.toBeNull();

      expect(
        await worker.creditLedger.count({
          where: { accountId: { in: [ws.accountId, other.accountId] } },
        })
      ).toBe(0);
    });

    it('a delete that lands while reserving: the reservation is released, null', async () => {
      const ws = await workspace(5 * unit);
      const post = await repeatingPost(ws);
      const reserve = s().charging.reserveOccurrence.bind(s().charging);
      const spy = jest
        .spyOn(s().charging, 'reserveOccurrence')
        .mockImplementationOnce(async (...args) => {
          const ledger = await reserve(...args);
          await worker.post.update({
            where: { id: post.id },
            data: { deletedAt: new Date() },
          });
          return ledger;
        });

      try {
        await expect(
          s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, due())
        ).resolves.toBeNull();
      } finally {
        spy.mockRestore();
      }

      expect((await ledgerOf(publishKey(post.id, ws.integrationId, 2)))!.status).toBe(
        'RELEASED'
      );
      expect(await balance(ws.organizationId)).toEqual({
        available: 5 * unit,
        reserved: 0,
      });
    });

    it.each([
      ['occurrence 1 (reserved when scheduled)', 1, due()],
      ['occurrence 0', 0, due()],
      ['a fractional occurrence', 2.5, due()],
      ['an invalid due date', 2, new Date('nope')],
    ])('rejects %s with 400', async (_name, occurrence, dueAt) => {
      const ws = await workspace(5 * unit);
      const post = await repeatingPost(ws);

      const err = await s()
        .recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, occurrence, dueAt)
        .catch((e) => e);

      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(400);
      expect(
        await worker.creditLedger.count({ where: { accountId: ws.accountId } })
      ).toBe(0);
    });

    it('flagsForPosts answers only flagged, live, repeating posts of the workspace', async () => {
      const ws = await workspace(0);
      const other = await workspace(0);
      const flagged = await repeatingPost(ws);
      const deleted = await repeatingPost(ws);
      const stopped = await repeatingPost(ws);
      const foreign = await repeatingPost(other);
      const paid = await repeatingPost(ws);
      for (const [w, p] of [
        [ws, flagged],
        [ws, deleted],
        [ws, stopped],
        [other, foreign],
      ] as const) {
        await s().recurring.reserveNext(w.organizationId, p.id, w.integrationId, 2, due());
      }
      await worker.post.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
      await worker.post.update({ where: { id: stopped.id }, data: { intervalInDays: null } });

      const flags = await s().recurring.flagsForPosts(ws.organizationId, [
        flagged.id,
        deleted.id,
        stopped.id,
        foreign.id,
        paid.id,
        randomUUID(),
        flagged.id,
      ]);

      expect(Object.keys(flags)).toEqual([flagged.id]);
      expect(await s().recurring.flagsForPosts(ws.organizationId, [])).toEqual({});
    });

    it('clearFlag removes the flag', async () => {
      const ws = await workspace(0);
      const post = await repeatingPost(ws);
      await s().recurring.reserveNext(ws.organizationId, post.id, ws.integrationId, 2, due());

      await s().recurring.clearFlag(post.id);

      expect(await s().recurring.flagsForPosts(ws.organizationId, [post.id])).toEqual({});
    });
  });

  describe('GET /posts/recurring-flags', () => {
    it('is served at that path and answers the flags of the comma-separated ids', async () => {
      const ws = await workspace(0);
      const post = await repeatingPost(ws);
      await roles.api.recurring.reserveNext(
        ws.organizationId,
        post.id,
        ws.integrationId,
        2,
        due()
      );
      const controller = new RecurringFlagsController(roles.api.recurring);

      expect(Reflect.getMetadata(PATH_METADATA, RecurringFlagsController)).toBe('/posts');
      expect(
        Reflect.getMetadata(PATH_METADATA, RecurringFlagsController.prototype.recurringFlags)
      ).toBe('/recurring-flags');
      expect(
        Reflect.getMetadata(METHOD_METADATA, RecurringFlagsController.prototype.recurringFlags)
      ).toBe(RequestMethod.GET);

      const flags = await controller.recurringFlags(
        { id: ws.organizationId } as any,
        `${post.id},${randomUUID()}`
      );
      expect(Object.keys(flags)).toEqual([post.id]);
      expect(await controller.recurringFlags({ id: ws.organizationId } as any)).toEqual({});
    });
  });
});
