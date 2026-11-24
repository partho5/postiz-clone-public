// AI charging: every AI request reserves credits before it generates, commits what it used
// and gives the rest back; with too few credits nothing is generated or charged; the free plan has a
// monthly cap of AI credits that parallel requests cannot pass together.
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
import {
  AiChargeRequest,
  AiChargingService,
} from '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service';
import { AiQuoteDto } from '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.quote.dto';
import { AiQuoteController } from '@gitroom/backend/api/routes/ai.quote.controller';
import { Seedance } from '@gitroom/nestjs-libraries/videos/seedance/seedance';
import { VideoManager } from '@gitroom/nestjs-libraries/videos/video.manager';
import { HttpException, RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { PrismaClient } from '@prisma/client';
import { validate } from 'class-validator';
import { randomUUID } from 'crypto';

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// Direct reads of the money tables use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

// Video types as the video manager's contract declares them: a type and the longest video it makes.
const VIDEO_SECONDS: Record<string, number> = {
  seedance: 8,
  'image-text-slides': 30,
};
const videoManager = {
  getAllVideos: () =>
    Object.keys(VIDEO_SECONDS).map((identifier) => ({ identifier })),
  getVideoByName: (identifier: string) => ({
    identifier,
    instance: { maxSeconds: () => VIDEO_SECONDS[identifier] },
  }),
} as unknown as VideoManager;

interface Services {
  credits: CreditsService;
  ai: AiChargingService;
}

describeDb('AiChargingService (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let pricing: PricingService;
  let text: number;
  let image: number;
  let second: number;
  let minute: number;
  let captionMinute: number;
  let editBasic: number;
  let editStandard: number;
  let editHeavy: number;
  let cap: number;
  const roles: Record<'api' | 'worker', Services> = {} as any;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  const key = () => `ai:${randomUUID()}`;
  const ledgerOf = (k: string) =>
    worker.creditLedger.findUnique({ where: { idempotencyKey: k } });
  const balance = (organizationId: string) =>
    roles.api.credits.balance(organizationId);

  // The credits and AI services on a given client, wired as the database module wires them.
  const servicesOn = (prisma: PrismaService): Services => {
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
    const credits = new CreditsService(
      creditsRepository,
      accountsService,
      moneyScope
    );
    const pricingService = new PricingService(
      new PricingRepository(new PrismaTransaction(prisma), repo, repo),
      credits,
      accountsService
    );
    return {
      credits,
      ai: new AiChargingService(
        credits,
        creditsRepository,
        accountsService,
        pricingService,
        videoManager
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
    expect(api.role).toBe('api');
    expect(workerService.role).toBe('worker');
    await workerService.$connect();
    worker = new PrismaClient({ datasourceUrl: url });

    const repo = new PrismaRepository<any>(api);
    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    roles.api = servicesOn(api);
    roles.worker = servicesOn(workerService);
    pricing = new PricingService(
      new PricingRepository(new PrismaTransaction(api), repo, repo),
      roles.api.credits,
      accounts
    );
    await pricing.sync();
    const price = async (actionKey: string) =>
      (await roles.api.credits.quote(actionKey, 1, 'FREE')).unitCost;
    text = await price('ai.text');
    image = await price('ai.image');
    second = await price('ai.video.per_second');
    minute = await price('ai.clip.per_minute');
    captionMinute = await price('ai.captions.per_minute');
    editBasic = await price('ai.edit.basic');
    editStandard = await price('ai.edit.standard');
    editHeavy = await price('ai.edit.heavy');
    cap = await pricing.freeMonthlyAiCap();
    expect(image).toBeGreaterThan(0);
    expect(cap).toBeGreaterThanOrEqual(3 * image);
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
  const workspace = async (credits: number, planKey = 'FREE') => {
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
    if (credits > 0) {
      await roles.worker.credits.grant(accountId, {
        type: 'GRANT',
        amount: credits,
      });
    }
    return { organizationId: org.id, accountId };
  };

  const request = (
    ws: { organizationId: string },
    extra: Partial<AiChargeRequest> = {}
  ): AiChargeRequest => ({
    organizationId: ws.organizationId,
    kind: 'text',
    idempotencyKey: key(),
    metadata: { route: 'test' },
    ...extra,
  });

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    const s = () => roles[role];

    it('charge: reserves before running, commits after, and records the kind and route', async () => {
      const ws = await workspace(10 * image);
      const req = request(ws, { kind: 'image', quantity: 2 });
      let heldWhileRunning: { available: number; reserved: number } | undefined;

      const result = await s().ai.charge(req, async () => {
        heldWhileRunning = await balance(ws.organizationId);
        return 'picture';
      });

      expect(result).toBe('picture');
      expect(heldWhileRunning).toEqual({
        available: 8 * image,
        reserved: 2 * image,
      });
      expect(await ledgerOf(req.idempotencyKey)).toMatchObject({
        actionKey: 'ai.image',
        quantity: 2,
        unitCost: image,
        reserved: 2 * image,
        committed: 2 * image,
        status: 'COMMITTED',
        organizationId: ws.organizationId,
        metadata: { kind: 'image', route: 'test' },
      });
      expect(await balance(ws.organizationId)).toEqual({
        available: 8 * image,
        reserved: 0,
      });
    });

    it('charge: too few credits is a 402 INSUFFICIENT_CREDITS, nothing runs and the ledger is unchanged', async () => {
      const ws = await workspace(image - 1);
      const req = request(ws, { kind: 'image' });
      const run = jest.fn();

      const err = await s()
        .ai.charge(req, run)
        .catch((e) => e);

      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(402);
      expect(err.getResponse()).toMatchObject({
        statusCode: 402,
        code: 'INSUFFICIENT_CREDITS',
        required: image,
        available: image - 1,
      });
      expect(run).not.toHaveBeenCalled();
      expect(await ledgerOf(req.idempotencyKey)).toBeNull();
      expect(await balance(ws.organizationId)).toEqual({
        available: image - 1,
        reserved: 0,
      });
    });

    it('charge: zero balance refuses every kind with 402 and leaves the ledger empty', async () => {
      const ws = await workspace(0);
      for (const req of [
        request(ws, { kind: 'text' }),
        request(ws, { kind: 'image' }),
        request(ws, { kind: 'video', videoType: 'seedance', videoParams: {} }),
        request(ws, { kind: 'clip', quantity: 1 }),
      ]) {
        const run = jest.fn();
        const err = await s()
          .ai.charge(req, run)
          .catch((e) => e);
        expect(err.getStatus()).toBe(402);
        expect(run).not.toHaveBeenCalled();
      }
      expect(
        await worker.creditLedger.count({ where: { accountId: ws.accountId } })
      ).toBe(0);
    });

    it('charge: a run that throws releases everything and its own error comes back', async () => {
      const ws = await workspace(3 * image);
      const req = request(ws, { kind: 'image' });
      const boom = new Error('provider down');

      await expect(
        s().ai.charge(req, async () => {
          throw boom;
        })
      ).rejects.toBe(boom);

      expect((await ledgerOf(req.idempotencyKey))!.status).toBe('RELEASED');
      expect(await balance(ws.organizationId)).toEqual({
        available: 3 * image,
        reserved: 0,
      });
    });

    it('charge: actualUnits commits less and gives the rest back; more than reserved is held to the reservation', async () => {
      const ws = await workspace(20 * image);
      const fewer = request(ws, { kind: 'image', quantity: 5 });
      await s().ai.charge(
        fewer,
        async () => 'x',
        () => 2
      );
      expect(await ledgerOf(fewer.idempotencyKey)).toMatchObject({
        reserved: 5 * image,
        committed: 2 * image,
        status: 'COMMITTED',
      });

      const more = request(ws, { kind: 'image', quantity: 2 });
      await s().ai.charge(
        more,
        async () => 'x',
        () => 9
      );
      expect((await ledgerOf(more.idempotencyKey))!.committed).toBe(2 * image);

      expect(await balance(ws.organizationId)).toEqual({
        available: 20 * image - 2 * image - 2 * image,
        reserved: 0,
      });
    });

    it('prices each kind: text one call, images by count, clips by source minute rounded up, captions by whole minute, video by the longest the type makes', async () => {
      const ws = await workspace(1000);
      const cases: [Partial<AiChargeRequest>, string, number, number][] = [
        [{ kind: 'text' }, 'ai.text', 1, text],
        [{ kind: 'image', quantity: 3 }, 'ai.image', 3, 3 * image],
        [{ kind: 'image' }, 'ai.image', 1, image],
        [{ kind: 'clip', quantity: 2.2 }, 'ai.clip.per_minute', 3, 3 * minute],
        [
          { kind: 'captions', quantity: 3 },
          'ai.captions.per_minute',
          3,
          3 * captionMinute,
        ],
        [
          { kind: 'video', videoType: 'seedance', videoParams: {} },
          'ai.video.per_second',
          8,
          8 * second,
        ],
        [
          { kind: 'video', videoType: 'image-text-slides', videoParams: {} },
          'ai.video.per_second',
          30,
          30 * second,
        ],
      ];
      for (const [extra, actionKey, quantity, reserved] of cases) {
        const paid = await workspace(1000, 'PRO');
        const req = request(paid, extra);
        const ledger = await s().ai.reserve(req);
        expect(ledger).toMatchObject({
          actionKey,
          quantity,
          reserved,
          status: 'RESERVED',
        });
      }
      expect(ws.organizationId).toBeTruthy();
    });

    it('a video commits at the rendered seconds and the rest is returned', async () => {
      const ws = await workspace(100 * second, 'PRO');
      const req = request(ws, {
        kind: 'video',
        videoType: 'image-text-slides',
        videoParams: {},
      });

      await s().ai.charge(
        req,
        async () => 'url',
        () => 12
      );

      expect(await ledgerOf(req.idempotencyKey)).toMatchObject({
        reserved: 30 * second,
        committed: 12 * second,
        status: 'COMMITTED',
      });
      expect(await balance(ws.organizationId)).toEqual({
        available: 100 * second - 12 * second,
        reserved: 0,
      });
    });

    it('reserve holds the credits; finish commits them at the units used, or releases them, and repeating it changes nothing', async () => {
      const ws = await workspace(10 * image, 'PRO');
      const kept = request(ws, { kind: 'image', quantity: 4 });
      const dropped = request(ws, { kind: 'image', quantity: 2 });
      await s().ai.reserve(kept);
      await s().ai.reserve(dropped);
      expect(await balance(ws.organizationId)).toEqual({
        available: 4 * image,
        reserved: 6 * image,
      });

      await s().ai.finish(
        kept.idempotencyKey,
        { ok: true, actualUnits: 3 },
        ws.organizationId
      );
      await s().ai.finish(
        kept.idempotencyKey,
        { ok: true, actualUnits: 3 },
        ws.organizationId
      );
      await s().ai.finish(
        dropped.idempotencyKey,
        { ok: false },
        ws.organizationId
      );
      await s().ai.finish(
        dropped.idempotencyKey,
        { ok: false },
        ws.organizationId
      );

      expect(await ledgerOf(kept.idempotencyKey)).toMatchObject({
        status: 'COMMITTED',
        committed: 3 * image,
      });
      expect((await ledgerOf(dropped.idempotencyKey))!.status).toBe('RELEASED');
      expect(await balance(ws.organizationId)).toEqual({
        available: 7 * image,
        reserved: 0,
      });
    });

    it('finish without units commits the whole reservation; releasing a key never reserved is a no-op', async () => {
      const ws = await workspace(5 * image, 'PRO');
      const req = request(ws, { kind: 'image', quantity: 2 });
      await s().ai.reserve(req);

      await s().ai.finish(req.idempotencyKey, { ok: true }, ws.organizationId);
      await expect(
        s().ai.finish(key(), { ok: false }, ws.organizationId)
      ).resolves.toBeUndefined();

      expect((await ledgerOf(req.idempotencyKey))!.committed).toBe(2 * image);
    });

    it('finish rejects units that are not a number with 400 and changes nothing', async () => {
      const ws = await workspace(5 * image, 'PRO');
      const req = request(ws, { kind: 'image' });
      await s().ai.reserve(req);

      const err = await s()
        .ai.finish(
          req.idempotencyKey,
          { ok: true, actualUnits: NaN },
          ws.organizationId
        )
        .catch((e) => e);

      expect(err.getStatus()).toBe(400);
      expect((await ledgerOf(req.idempotencyKey))!.status).toBe('RESERVED');
    });

    it('one key charges once: a repeated charge reserves and commits nothing more', async () => {
      const ws = await workspace(5 * image, 'PRO');
      const req = request(ws, { kind: 'image' });

      await s().ai.charge(req, async () => 'a');
      await s().ai.charge(req, async () => 'b');

      expect(
        await worker.creditLedger.count({ where: { accountId: ws.accountId } })
      ).toBe(1);
      expect(await balance(ws.organizationId)).toEqual({
        available: 4 * image,
        reserved: 0,
      });
    });

    it('a retry of a request whose first attempt was released holds the credits again under the same key', async () => {
      const ws = await workspace(5 * image, 'PRO');
      const req = request(ws, { kind: 'image' });
      await s()
        .ai.charge(req, async () => {
          throw new Error('first attempt');
        })
        .catch(() => undefined);

      await s().ai.charge(req, async () => 'second attempt');

      expect(await ledgerOf(req.idempotencyKey)).toMatchObject({
        status: 'COMMITTED',
        committed: image,
      });
      expect(await balance(ws.organizationId)).toEqual({
        available: 4 * image,
        reserved: 0,
      });
    });

    it("another account's key is a 409 whatever this account can afford", async () => {
      const owner = await workspace(5 * image, 'PRO');
      const other = await workspace(0);
      const req = request(owner, { kind: 'image' });
      await s().ai.reserve(req);

      const err = await s()
        .ai.reserve({ ...req, organizationId: other.organizationId })
        .catch((e) => e);

      expect(err.getStatus()).toBe(409);
    });

    it.each([
      ['an unknown kind', { kind: 'audio' as any }],
      ['zero images', { kind: 'image' as const, quantity: 0 }],
      ['a fractional image count', { kind: 'image' as const, quantity: 1.5 }],
      ['a clip of no minutes', { kind: 'clip' as const, quantity: 0 }],
      ['captions of no minutes', { kind: 'captions' as const, quantity: 0 }],
      [
        'a fractional caption minute count',
        { kind: 'captions' as const, quantity: 2.5 },
      ],
      ['a video without a type', { kind: 'video' as const }],
      [
        'a video type that does not exist',
        { kind: 'video' as const, videoType: 'nope' },
      ],
    ])('rejects %s with 400 and holds nothing', async (_name, extra) => {
      const ws = await workspace(50);
      const req = request(ws, extra);

      const err = await s()
        .ai.reserve(req)
        .catch((e) => e);

      expect(err.getStatus()).toBe(400);
      expect(await ledgerOf(req.idempotencyKey)).toBeNull();
    });

    describe('free-plan cap', () => {
      it('counts reserved and committed ai.* credits: up to the cap is allowed, one more is 402 AI_CAP_REACHED and changes nothing', async () => {
        const ws = await workspace(cap + 10 * image);
        const fill = request(ws, {
          kind: 'image',
          quantity: Math.floor(cap / image),
        });
        await s().ai.charge(fill, async () => 'x');
        const used = Math.floor(cap / image) * image;
        const over = request(ws, {
          kind: 'image',
          quantity: Math.floor((cap - used) / image) + 1,
        });
        const before = await balance(ws.organizationId);
        const run = jest.fn();

        const err = await s()
          .ai.charge(over, run)
          .catch((e) => e);

        expect(err.getStatus()).toBe(402);
        expect(err.getResponse()).toMatchObject({
          statusCode: 402,
          code: 'AI_CAP_REACHED',
          cap,
          used,
        });
        expect(run).not.toHaveBeenCalled();
        expect(await ledgerOf(over.idempotencyKey)).toBeNull();
        expect(await balance(ws.organizationId)).toEqual(before);
      });

      it('text, images, video and clips count together against the one cap', async () => {
        const ws = await workspace(1000);
        const spend = 2 * image + text;
        await s().ai.charge(
          request(ws, { kind: 'image', quantity: 2 }),
          async () => 'x'
        );
        await s().ai.charge(request(ws, { kind: 'text' }), async () => 'x');

        const estimate = await s().ai.estimate(ws.organizationId, {
          kind: 'text',
        });

        expect(estimate.cap).toEqual({ limit: cap, used: spend });
      });

      it('only what was committed counts: units given back and released requests free the cap again', async () => {
        const ws = await workspace(1000);
        await s().ai.charge(
          request(ws, { kind: 'image', quantity: 3 }),
          async () => 'x',
          () => 1
        );
        await s()
          .ai.charge(request(ws, { kind: 'image', quantity: 2 }), async () => {
            throw new Error('down');
          })
          .catch(() => undefined);

        expect(
          (await s().ai.estimate(ws.organizationId, { kind: 'text' })).cap
        ).toEqual({
          limit: cap,
          used: image,
        });
      });

      it('actions that are not AI, other accounts and earlier months do not count', async () => {
        const ws = await workspace(1000);
        const other = await workspace(1000);
        await s().credits.spend(
          {
            organizationId: ws.organizationId,
            actionKey: 'post.publish',
            idempotencyKey: key(),
          },
          async () => 'posted'
        );
        await s().ai.charge(request(other, { kind: 'image' }), async () => 'x');
        const lastMonth = request(ws, { kind: 'image' });
        await s().ai.charge(lastMonth, async () => 'x');
        await worker.creditLedger.update({
          where: { idempotencyKey: lastMonth.idempotencyKey },
          data: { createdAt: new Date(Date.UTC(2020, 0, 15)) },
        });

        expect(
          (await s().ai.estimate(ws.organizationId, { kind: 'text' })).cap
        ).toEqual({
          limit: cap,
          used: 0,
        });
      });

      it('parallel requests cannot pass the cap together', async () => {
        const ws = await workspace(1000);
        const fit = Math.floor(cap / image);

        const results = await Promise.all(
          Array.from({ length: fit + 6 }, () =>
            s()
              .ai.reserve(request(ws, { kind: 'image' }))
              .then(
                () => 'held',
                (err) => err.getResponse?.().code
              )
          )
        );

        expect(results.filter((r) => r === 'held')).toHaveLength(fit);
        expect(results.filter((r) => r === 'AI_CAP_REACHED')).toHaveLength(6);
        expect(
          (await s().ai.estimate(ws.organizationId, { kind: 'text' })).cap!.used
        ).toBe(fit * image);
      });

      it('a reserved key that was released is held again only if the cap has room', async () => {
        const ws = await workspace(1000);
        const first = request(ws, {
          kind: 'image',
          quantity: Math.floor(cap / image),
        });
        await s().ai.reserve(first);
        await s().ai.finish(
          first.idempotencyKey,
          { ok: false },
          ws.organizationId
        );
        await s().ai.charge(
          request(ws, { kind: 'image', quantity: Math.floor(cap / image) }),
          async () => 'x'
        );

        const err = await s()
          .ai.reserve(first)
          .catch((e) => e);

        expect(err.getResponse()).toMatchObject({ code: 'AI_CAP_REACHED' });
        expect((await ledgerOf(first.idempotencyKey))!.status).toBe('RELEASED');
      });

      it('a paid plan has no cap', async () => {
        const ws = await workspace(cap * 20, 'PRO');
        await s().ai.charge(
          request(ws, {
            kind: 'image',
            quantity: Math.ceil((cap * 2) / image),
          }),
          async () => 'x'
        );

        expect(
          (await s().ai.estimate(ws.organizationId, { kind: 'image' })).cap
        ).toBeNull();
      });
    });

    describe('estimate', () => {
      it('gives the action, unit price, units and amount for the workspace, without holding anything', async () => {
        const ws = await workspace(100);

        expect(
          await s().ai.estimate(ws.organizationId, {
            kind: 'image',
            quantity: 3,
          })
        ).toEqual({
          actionKey: 'ai.image',
          unitCost: image,
          units: 3,
          amount: 3 * image,
          cap: { limit: cap, used: 0 },
        });
        expect(
          await s().ai.estimate(ws.organizationId, {
            kind: 'video',
            videoType: 'seedance',
            videoParams: {},
          })
        ).toMatchObject({
          actionKey: 'ai.video.per_second',
          units: 8,
          amount: 8 * second,
        });
        expect(
          await s().ai.estimate(ws.organizationId, {
            kind: 'clip',
            quantity: 4,
          })
        ).toMatchObject({
          actionKey: 'ai.clip.per_minute',
          units: 4,
          amount: 4 * minute,
        });
        expect(
          await s().ai.estimate(ws.organizationId, {
            kind: 'captions',
            quantity: 3,
          })
        ).toMatchObject({
          actionKey: 'ai.captions.per_minute',
          units: 3,
          amount: 3 * captionMinute,
        });
        expect(
          await s().ai.estimate(ws.organizationId, { kind: 'text' })
        ).toMatchObject({
          actionKey: 'ai.text',
          units: 1,
          amount: text,
        });
        expect(
          await s().ai.estimate(ws.organizationId, {
            kind: 'edit',
            editLevel: 'standard',
            quantity: 200,
          })
        ).toMatchObject({
          actionKey: 'ai.edit.standard',
          units: 2,
          amount: 2 * editStandard,
        });
        expect(
          await worker.creditLedger.count({
            where: { accountId: ws.accountId },
          })
        ).toBe(0);
      });

      it('uses the price the plan pays, and an estimate equals what a reservation then takes', async () => {
        const ws = await workspace(100, 'PRO');
        const req = request(ws, { kind: 'image', quantity: 2 });

        const estimate = await s().ai.estimate(ws.organizationId, {
          kind: 'image',
          quantity: 2,
        });
        const ledger = await s().ai.reserve(req);

        expect(ledger.reserved).toBe(estimate.amount);
        expect(estimate.cap).toBeNull();
      });

      it('prices an edit by its level per started 3 minutes, at least one block', async () => {
        const ws = await workspace(100, 'PRO');
        const cases: [string, number, number, number][] = [
          ['basic', 1, 1, editBasic],
          ['basic', 180, 1, editBasic],
          ['basic', 181, 2, 2 * editBasic],
          ['standard', 600, 4, 4 * editStandard],
          ['heavy', 360, 2, 2 * editHeavy],
        ];
        for (const [editLevel, quantity, units, amount] of cases) {
          expect(
            await s().ai.estimate(ws.organizationId, {
              kind: 'edit',
              editLevel: editLevel as any,
              quantity,
            })
          ).toMatchObject({ actionKey: `ai.edit.${editLevel}`, units, amount });
        }
        expect([editBasic, editStandard, editHeavy]).toEqual([1, 2, 3]);
      });

      it('an edit with no level, an unknown level or a length that is not whole seconds is a 400', async () => {
        const ws = await workspace(100, 'PRO');
        for (const extra of [
          { quantity: 60 },
          { editLevel: 'extreme' as any, quantity: 60 },
          { editLevel: 'basic' as const, quantity: 0 },
          { editLevel: 'basic' as const, quantity: 1.5 },
        ]) {
          const err = await s()
            .ai.estimate(ws.organizationId, { kind: 'edit', ...extra })
            .catch((e) => e);
          expect(err).toBeInstanceOf(HttpException);
          expect(err.getStatus()).toBe(400);
        }
      });

      it('an edit estimate equals what its reservation takes, under the level and blocks', async () => {
        const ws = await workspace(100, 'PRO');
        const req = request(ws, {
          kind: 'edit',
          editLevel: 'heavy',
          quantity: 400,
        });
        const estimate = await s().ai.estimate(ws.organizationId, {
          kind: 'edit',
          editLevel: 'heavy',
          quantity: 400,
        });
        const ledger = await s().ai.reserve(req);
        expect(ledger).toMatchObject({
          actionKey: 'ai.edit.heavy',
          quantity: 3,
          reserved: estimate.amount,
          metadata: { kind: 'edit', editLevel: 'heavy' },
        });
      });
    });
  });

  it('the seedance video type declares its fixed length as its longest video', () => {
    expect(new Seedance().maxSeconds()).toBe(8);
  });

  describe('POST /ai/quote', () => {
    it('is a POST on /ai/quote answering 200 with the estimate', async () => {
      const handler = AiQuoteController.prototype.quote;
      expect(Reflect.getMetadata(PATH_METADATA, AiQuoteController)).toBe('/ai');
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/quote');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.POST
      );
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);

      const ws = await workspace(100);
      const controller = new AiQuoteController(roles.api.ai);
      expect(
        await controller.quote({ id: ws.organizationId } as any, {
          kind: 'image',
          quantity: 2,
        })
      ).toEqual({
        actionKey: 'ai.image',
        unitCost: image,
        units: 2,
        amount: 2 * image,
        cap: { limit: cap, used: 0 },
      });
    });

    it.each([
      ['a kind that does not exist', { kind: 'audio' }],
      ['no kind', {}],
      ['a quantity of zero', { kind: 'image', quantity: 0 }],
      ['a fractional quantity', { kind: 'image', quantity: 1.5 }],
      ['a video type that is not text', { kind: 'video', videoType: 7 }],
      [
        'video params that are not an object',
        { kind: 'video', videoParams: 'x' },
      ],
      ['an edit with no level', { kind: 'edit', quantity: 60 }],
      ['an edit level that does not exist', { kind: 'edit', editLevel: 'max' }],
    ])('the body is refused with %s', async (_name, body) => {
      const dto = Object.assign(new AiQuoteDto(), body);
      expect((await validate(dto)).length).toBeGreaterThan(0);
    });

    it('accepts every kind with its optional fields', async () => {
      for (const body of [
        { kind: 'text' },
        { kind: 'image', quantity: 3 },
        { kind: 'clip', quantity: 12 },
        { kind: 'captions', quantity: 3 },
        { kind: 'edit', editLevel: 'basic', quantity: 118 },
        { kind: 'video', videoType: 'seedance', videoParams: { prompt: 'x' } },
      ]) {
        expect(await validate(Object.assign(new AiQuoteDto(), body))).toEqual(
          []
        );
      }
    });
  });
});
