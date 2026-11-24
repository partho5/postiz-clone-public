import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { CreditsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import {
  CreditsService,
  InsufficientCreditsException,
} from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { PricingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

// Runs against a real, disposable Postgres, migrated by the jest global setup.
// The service runs as the API role (row-level security on the money tables);
// fixtures that write credit rows directly use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('CreditsService (Postgres)', () => {
  let prisma: PrismaService;
  let worker: PrismaClient;
  let credits: CreditsService;
  let accounts: AccountsService;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    const repo = new PrismaRepository<any>(prisma);
    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    const scope = new MoneyScope(new PrismaTransaction(prisma), accounts);
    credits = new CreditsService(
      new CreditsRepository(scope, repo, repo, repo),
      accounts,
      scope
    );
    await new PricingService(
      new PricingRepository(new PrismaTransaction(prisma), repo, repo),
      credits,
      accounts
    ).sync();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await worker.$disconnect();
  });

  // A user with a workspace, billed to the user's own account
  const workspace = async () => {
    const org = await prisma.organization.create({
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

  const expectConsistent = async (accountId: string) => {
    const drift = await credits.reconcile(accountId);
    expect(drift).toEqual({ buckets: [], ledgers: [] });
  };

  it('attaches a legacy workspace to exactly one account under concurrency', async () => {
    const org = await prisma.organization.create({
      data: {
        name: 'legacy',
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
    const ids = await Promise.all(
      Array.from({ length: 10 }, () =>
        accounts.getAccountIdForOrganization(org.id)
      )
    );
    expect(new Set(ids).size).toBe(1);
  });

  it('fails closed on unknown actions', async () => {
    const { organizationId } = await workspace();
    await expect(
      credits.reserve({
        organizationId,
        actionKey: 'does.not.exist',
        idempotencyKey: key(),
      })
    ).rejects.toThrow('Unknown credit action');
  });

  it('grants once per grant key', async () => {
    const { accountId, organizationId } = await workspace();
    const grantKey = 'starter:' + accountId;
    await credits.grant(accountId, { type: 'PROMO', amount: 10, grantKey });
    await credits.grant(accountId, { type: 'PROMO', amount: 10, grantKey });
    expect(await credits.balance(organizationId)).toEqual({
      available: 10,
      reserved: 0,
    });
    await expectConsistent(accountId);
  });

  it('reserves, commits and releases idempotently', async () => {
    const { accountId, organizationId } = await workspace();
    await credits.grant(accountId, { type: 'GRANT', amount: 10 });

    const publish = key();
    const request = {
      organizationId,
      actionKey: 'post.publish',
      quantity: 3,
      idempotencyKey: publish,
    };
    await credits.reserve(request);
    await credits.reserve(request); // Temporal retry
    expect(await credits.balance(organizationId)).toEqual({
      available: 7,
      reserved: 3,
    });

    await credits.commit(publish, undefined, organizationId);
    await credits.commit(publish, undefined, organizationId);
    expect(await credits.balance(organizationId)).toEqual({
      available: 7,
      reserved: 0,
    });
    await expect(credits.release(publish, organizationId)).rejects.toThrow(
      'already committed'
    );

    const failed = key();
    await credits.reserve({ ...request, idempotencyKey: failed });
    await credits.release(failed, organizationId);
    await credits.release(failed, organizationId);
    await expect(
      credits.commit(failed, undefined, organizationId)
    ).rejects.toThrow('already released');
    expect(await credits.release(key(), organizationId)).toBeNull();

    expect(await credits.balance(organizationId)).toEqual({
      available: 7,
      reserved: 0,
    });
    await expectConsistent(accountId);
  });

  it('refuses a key reused for another action', async () => {
    const { accountId, organizationId } = await workspace();
    await credits.grant(accountId, { type: 'GRANT', amount: 10 });
    const shared = key();
    await credits.reserve({
      organizationId,
      actionKey: 'post.publish',
      idempotencyKey: shared,
    });
    await expect(
      credits.reserve({
        organizationId,
        actionKey: 'ai.text',
        idempotencyKey: shared,
      })
    ).rejects.toThrow('different action');
  });

  it('returns 402 with the numbers when credits run out', async () => {
    const { accountId, organizationId } = await workspace();
    await credits.grant(accountId, { type: 'GRANT', amount: 4 });
    const err = await credits
      .reserve({ organizationId, actionKey: 'ai.image', idempotencyKey: key() })
      .catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsException);
    expect(err.getStatus()).toBe(402);
    expect(err.getResponse()).toMatchObject({ required: 5, available: 4 });
    await expectConsistent(accountId);
  });

  it('never overspends under 50 parallel spends', async () => {
    const { accountId, organizationId } = await workspace();
    await credits.grant(accountId, { type: 'GRANT', amount: 30 });

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        credits.reserve({
          organizationId,
          actionKey: 'post.publish',
          idempotencyKey: key(),
        })
      )
    );

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof InsufficientCreditsException
    ).length;
    expect(ok).toBe(30);
    expect(refused).toBe(20);
    expect(await credits.balance(organizationId)).toEqual({
      available: 0,
      reserved: 30,
    });
    await expectConsistent(accountId);
  });

  it('charges once when the same key races', async () => {
    const { accountId, organizationId } = await workspace();
    await credits.grant(accountId, { type: 'GRANT', amount: 10 });
    const same = key();
    const ledgers = await Promise.all(
      Array.from({ length: 20 }, () =>
        credits.reserve({
          organizationId,
          actionKey: 'post.publish',
          idempotencyKey: same,
        })
      )
    );
    expect(new Set(ledgers.map((l) => l.id)).size).toBe(1);
    expect((await credits.balance(organizationId)).available).toBe(9);
    await expectConsistent(accountId);
  });

  it('spends the earliest expiring bucket first', async () => {
    const { accountId, organizationId } = await workspace();
    const { bucket: never } = await credits.grant(accountId, {
      type: 'TOPUP',
      amount: 10,
    });
    const { bucket: soon } = await credits.grant(accountId, {
      type: 'GRANT',
      amount: 2,
      expiresInDays: 1,
    });
    const { bucket: later } = await credits.grant(accountId, {
      type: 'GRANT',
      amount: 2,
      expiresInDays: 20,
    });
    await credits.reserve({
      organizationId,
      actionKey: 'post.publish',
      quantity: 5,
      idempotencyKey: key(),
    });
    const remaining = async (id: string) =>
      (await worker.creditBucket.findUniqueOrThrow({ where: { id } }))
        .remaining;
    expect(await remaining(soon.id)).toBe(0);
    expect(await remaining(later.id)).toBe(0);
    expect(await remaining(never.id)).toBe(9);
    await expectConsistent(accountId);
  });

  it('refunds into a new bucket when the source bucket expired', async () => {
    const { accountId, organizationId } = await workspace();
    const { bucket } = await credits.grant(accountId, {
      type: 'GRANT',
      amount: 3,
      expiresInDays: 1,
    });
    const scheduled = key();
    await credits.reserve({
      organizationId,
      actionKey: 'post.publish',
      quantity: 3,
      idempotencyKey: scheduled,
    });
    await worker.creditBucket.update({
      where: { id: bucket.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await credits.release(scheduled, organizationId);

    const refund = await worker.creditBucket.findFirstOrThrow({
      where: { accountId, type: 'REFUND' },
    });
    expect(refund.remaining).toBe(3);
    expect(refund.expiresAt!.getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 3600 * 1000
    );
    expect((await credits.balance(organizationId)).available).toBe(3);
    await expectConsistent(accountId);
  });

  it('commits the actual cost of a variable action and returns the rest', async () => {
    const { accountId, organizationId } = await workspace();
    await credits.grant(accountId, { type: 'GRANT', amount: 100 });
    const video = key();
    await credits.reserve({
      organizationId,
      actionKey: 'ai.video.per_second',
      quantity: 30, // estimate: 30 s
      idempotencyKey: video,
    });
    expect((await credits.balance(organizationId)).available).toBe(40);

    await credits.commit(video, 2 * 12, organizationId); // rendered 12 s
    expect(await credits.balance(organizationId)).toEqual({
      available: 76,
      reserved: 0,
    });
    await expect(credits.commit(key(), 1, organizationId)).rejects.toThrow(
      'No reservation'
    );
    await expectConsistent(accountId);
  });

  it('keeps the price snapshot and applies plan overrides', async () => {
    const { accountId, organizationId } = await workspace();
    await credits.grant(accountId, { type: 'GRANT', amount: 100 });
    const planKey = 'PRO-' + randomUUID();
    await prisma.account.update({ where: { id: accountId }, data: { planKey } });
    await prisma.creditPlanOverride.create({
      data: { planKey, actionKey: 'ai.image', cost: 3 },
    });

    const image = key();
    const ledger = await credits.reserve({
      organizationId,
      actionKey: 'ai.image',
      idempotencyKey: image,
    });
    expect(ledger.unitCost).toBe(3);

    await prisma.creditPlanOverride.update({
      where: { planKey_actionKey: { planKey, actionKey: 'ai.image' } },
      data: { cost: 50 },
    });
    const committed = await credits.commit(image, undefined, organizationId);
    expect(committed.committed).toBe(3);
    await expectConsistent(accountId);
  });

  it('blocks new spends while the balance is negative', async () => {
    const { accountId, organizationId } = await workspace();
    await credits.grant(accountId, { type: 'GRANT', amount: 5 });
    // A reversed payment that was already partly spent
    await worker.creditBucket.create({
      data: { accountId, type: 'TOPUP', initial: 0, remaining: -8 },
    });
    await expect(
      credits.reserve({
        organizationId,
        actionKey: 'post.publish',
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(InsufficientCreditsException);
  });

  it('logs free actions without touching buckets', async () => {
    const { accountId, organizationId } = await workspace();
    const free = key();
    await credits.reserve({
      organizationId,
      actionKey: 'channel.connect',
      idempotencyKey: free,
    });
    const ledger = await credits.commit(free, undefined, organizationId);
    expect(ledger.committed).toBe(0);
    await expectConsistent(accountId);
  });

  it('spend() releases when the action throws', async () => {
    const { accountId, organizationId } = await workspace();
    await credits.grant(accountId, { type: 'GRANT', amount: 2 });
    await expect(
      credits.spend(
        { organizationId, actionKey: 'ai.text', idempotencyKey: key() },
        async () => {
          throw new Error('model down');
        }
      )
    ).rejects.toThrow('model down');
    expect(await credits.balance(organizationId)).toEqual({
      available: 2,
      reserved: 0,
    });
    await credits.spend(
      { organizationId, actionKey: 'ai.text', idempotencyKey: key() },
      async () => 'ok'
    );
    expect((await credits.balance(organizationId)).available).toBe(1);
    await expectConsistent(accountId);
  });
});
