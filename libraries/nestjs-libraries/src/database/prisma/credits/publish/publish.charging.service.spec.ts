// Publish charging: scheduling holds post.publish credits per channel, a
// publish commits them, a delete, removed channel or permanent failure releases them.
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
import { PublishChargePreviewDto } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charge.preview.dto';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { PublishChargeController } from '@gitroom/backend/api/routes/publish.charge.controller';
import { HttpException, ValidationPipe } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import dayjs from 'dayjs';

// Modules that pull ESM-only packages ts-jest cannot load; PostsService only names
// them as dependencies, and the charging paths never reach them
jest.mock('file-type', () => ({}));
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service',
  () => ({ AiCaptionsService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);
jest.mock('@gitroom/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (value: string) => value,
  postContentPlainText: (value: string) => value,
}));

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// Direct reads of the money tables use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

interface Services {
  credits: CreditsService;
  charging: PublishChargingService;
  posts: PostsService;
}

// A workflow start the posts service asked Temporal for, with the reservation as it was then.
interface Started {
  name: string;
  args: any;
  ledgerStatus: string | undefined;
}

describeDb('PublishChargingService (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let unit: number;
  const roles: Record<'api' | 'worker', Services> = {} as any;
  const started: Started[] = [];
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  const publishKey = (postId: string, integrationId: string, n = 1) =>
    `post:${postId}:integration:${integrationId}:publish${n === 1 ? '' : `:${n}`}`;

  const ledgerOf = (key: string) =>
    worker.creditLedger.findUnique({ where: { idempotencyKey: key } });

  // Temporal as PostsService uses it: no running workflows, starts are recorded.
  const temporal = {
    client: {
      getRawClient: () => ({
        workflow: {
          list: () => (async function* () {})(),
          start: async (name: string, options: any) => {
            const [args] = options.args;
            const post = await worker.post.findUnique({
              where: { id: args.postId },
            });
            const ledger = await ledgerOf(
              publishKey(args.postId, post!.integrationId)
            );
            started.push({ name, args, ledgerStatus: ledger?.status });
          },
        },
      }),
      getWorkflowHandle: async () => null,
    },
  };

  // The charging, credits and posts services on a given client, wired as the database module wires them.
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
    const posts = new PostsService(
      new PostsRepository(repo, repo, repo, repo, repo, repo),
      { getSocialIntegration: () => undefined } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      temporal as any,
      {} as any,
      charging,
      { assertNotPurged: async () => undefined } as any,
      // Runs provider code as is; the workspace's app keys are not under test here.
      { runWithWorkspace: (_orgId: string, fn: () => Promise<unknown>) => fn() } as any
    );
    return { credits, charging, posts };
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

  // A user with a workspace billed to the user's own account, holding credits in one bucket.
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
    return { organizationId: org.id, accountId };
  };

  // A connected channel of a workspace.
  const channel = async (organizationId: string) =>
    (
      await worker.integration.create({
        data: {
          organizationId,
          internalId: randomUUID(),
          name: 'channel-' + randomUUID(),
          picture: '/no-picture.jpg',
          providerIdentifier: 'bluesky',
          type: 'social',
          token: 'token',
        },
      })
    ).id;

  const future = (days = 3) =>
    dayjs().add(days, 'day').format('YYYY-MM-DDTHH:mm:00');

  // A createPost request: one entry per channel, each with the given thread values.
  const request = (
    type: 'draft' | 'schedule' | 'now' | 'update',
    entries: {
      integrationId: string;
      group?: string;
      values?: { id?: string; content?: string }[];
    }[],
    date = future()
  ) =>
    ({
      type,
      date,
      shortLink: false,
      tags: [],
      posts: entries.map((e) => ({
        integration: { id: e.integrationId },
        group: e.group,
        settings: { __type: 'bluesky' },
        value: (e.values || [{}]).map((v) => ({
          ...(v.id ? { id: v.id } : {}),
          content: v.content || '<p>hello</p>',
          image: [],
        })),
      })),
    }) as any;

  // Waits until the posts service has started n more workflows than before.
  const startsAfter = async (before: number, n: number) => {
    for (let i = 0; i < 100 && started.length < before + n; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return started.slice(before);
  };

  // Live first row of a channel in a workspace.
  const firstRowOf = (organizationId: string, integrationId: string) =>
    worker.post.findFirstOrThrow({
      where: {
        organizationId,
        integrationId,
        parentPostId: null,
        deletedAt: null,
      },
    });

  const statusOf = (err: unknown) => {
    expect(err).toBeInstanceOf(HttpException);
    return (err as HttpException).getStatus();
  };

  const bodyOf = (err: unknown) => (err as HttpException).getResponse() as any;

  describe('publishKey', () => {
    const charging = () => roles.api.charging;

    it('is the key for occurrence 1 or none, and appends :n from occurrence 2', () => {
      expect(charging().publishKey('p1', 'i1')).toBe(
        'post:p1:integration:i1:publish'
      );
      expect(charging().publishKey('p1', 'i1', 1)).toBe(
        'post:p1:integration:i1:publish'
      );
      expect(charging().publishKey('p1', 'i1', 2)).toBe(
        'post:p1:integration:i1:publish:2'
      );
      expect(charging().publishKey('p1', 'i1', 12)).toBe(
        'post:p1:integration:i1:publish:12'
      );
    });

    it.each([0, -1, 1.5, NaN])('rejects occurrence %p with 400', (n) => {
      let err: unknown;
      try {
        charging().publishKey('p1', 'i1', n);
      } catch (e) {
        err = e;
      }
      expect(statusOf(err)).toBe(400);
    });
  });

  describe('POST /posts/charge-preview', () => {
    // The captions service as the controller uses it: 1 credit per whole minute of speech.
    const captions = {
      costOfSeconds: jest.fn(async (_org: string, seconds: number) =>
        Math.floor(seconds / 60)
      ),
    };
    beforeEach(() => captions.costOfSeconds.mockClear());

    it('answers 200 and hands the workspace and body to the service', async () => {
      expect(
        Reflect.getMetadata(
          HTTP_CODE_METADATA,
          PublishChargeController.prototype.chargePreview
        )
      ).toBe(200);
      const ws = await workspace(0);
      const a = await channel(ws.organizationId);
      const controller = new PublishChargeController(
        roles.api.charging,
        captions as any
      );
      expect(
        await controller.chargePreview({ id: ws.organizationId } as any, {
          integrationIds: [a],
        })
      ).toEqual({ amount: unit, newChannels: [a], releasedChannels: [] });
      expect(captions.costOfSeconds).not.toHaveBeenCalled();
    });

    it('adds what the AI captions of aiCaptionsSeconds cost, leaving amount as it is (ai.video-captions)', async () => {
      const ws = await workspace(0);
      const a = await channel(ws.organizationId);
      const controller = new PublishChargeController(
        roles.api.charging,
        captions as any
      );
      expect(
        await controller.chargePreview({ id: ws.organizationId } as any, {
          integrationIds: [a],
          aiCaptionsSeconds: 150,
        })
      ).toEqual({
        amount: unit,
        newChannels: [a],
        releasedChannels: [],
        aiCaptions: 2,
      });
      expect(captions.costOfSeconds).toHaveBeenCalledWith(ws.organizationId, 150);
    });

    it.each([
      [{}],
      [{ integrationIds: 'a' }],
      [{ integrationIds: [1] }],
      [{ integrationIds: [''] }],
      [{ integrationIds: ['a'], group: 5 }],
    ])('answers 400 for the body %j', async (body) => {
      const pipe = new ValidationPipe({ transform: true });
      let err: unknown;
      try {
        await pipe.transform(body, {
          type: 'body',
          metatype: PublishChargePreviewDto,
        });
      } catch (e) {
        err = e;
      }
      expect(statusOf(err)).toBe(400);
    });
  });

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    const credits = () => roles[role].credits;
    const charging = () => roles[role].charging;
    const posts = () => roles[role].posts;

    const balance = (organizationId: string) => credits().balance(organizationId);

    // Schedules one post per channel; returns the first rows by channel.
    const schedule = async (
      organizationId: string,
      integrationIds: string[],
      type: 'schedule' | 'now' | 'draft' = 'schedule'
    ) => {
      await posts().createPost(
        organizationId,
        request(
          type,
          integrationIds.map((integrationId) => ({ integrationId }))
        ),
        'WEB'
      );
      return Promise.all(
        integrationIds.map((i) => firstRowOf(organizationId, i))
      );
    };

    describe('schedule and post now', () => {
      it('reserves occurrence 1 per channel, with its metadata, before any workflow starts', async () => {
        const ws = await workspace(10 * unit);
        const channels = [
          await channel(ws.organizationId),
          await channel(ws.organizationId),
          await channel(ws.organizationId),
        ];
        const date = future(5);
        const before = started.length;

        const output = await posts().createPost(
          ws.organizationId,
          request(
            'schedule',
            channels.map((integrationId) => ({ integrationId })),
            date
          ),
          'WEB'
        );

        expect(output).toHaveLength(3);
        for (const integrationId of channels) {
          const row = await firstRowOf(ws.organizationId, integrationId);
          const ledger = await ledgerOf(publishKey(row.id, integrationId));
          expect(ledger).toMatchObject({
            status: 'RESERVED',
            actionKey: 'post.publish',
            reserved: unit,
            organizationId: ws.organizationId,
            accountId: ws.accountId,
          });
          expect(ledger!.metadata).toEqual({
            postId: row.id,
            integrationId,
            group: row.group,
            occurrence: 1,
            publishDate: dayjs(date).toISOString(),
          });
        }
        expect(await balance(ws.organizationId)).toEqual({
          available: 7 * unit,
          reserved: 3 * unit,
        });

        const starts = await startsAfter(before, 3);
        expect(starts).toHaveLength(3);
        for (const start of starts) {
          expect(start.name).toBe('postWorkflowV114');
          expect(start.args.organizationId).toBe(ws.organizationId);
          expect(start.args.occurrence ?? 1).toBe(1);
          expect(start.ledgerStatus).toBe('RESERVED');
        }
      });

      it('post now reserves like schedule', async () => {
        const ws = await workspace(unit);
        const a = await channel(ws.organizationId);

        const [row] = await schedule(ws.organizationId, [a], 'now');

        expect((await ledgerOf(publishKey(row.id, a)))!.status).toBe(
          'RESERVED'
        );
        expect(await balance(ws.organizationId)).toEqual({
          available: 0,
          reserved: unit,
        });
      });

      it('charges thread follow-ups nothing: one reservation per channel', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);

        await posts().createPost(
          ws.organizationId,
          request('schedule', [
            { integrationId: a, values: [{}, {}, {}] },
          ]),
          'WEB'
        );

        const rows = await worker.post.findMany({
          where: { organizationId: ws.organizationId, deletedAt: null },
        });
        expect(rows).toHaveLength(3);
        const ledgers = await worker.creditLedger.findMany({
          where: { accountId: ws.accountId },
        });
        expect(ledgers).toHaveLength(1);
        expect(ledgers[0].idempotencyKey).toBe(
          publishKey(rows.find((r) => !r.parentPostId)!.id, a)
        );
        expect(await balance(ws.organizationId)).toEqual({
          available: 4 * unit,
          reserved: unit,
        });
      });

      it('402 INSUFFICIENT_CREDITS for the whole request: no post row created, nothing held, no workflow', async () => {
        const ws = await workspace(2 * unit);
        const channels = [
          await channel(ws.organizationId),
          await channel(ws.organizationId),
          await channel(ws.organizationId),
        ];
        const before = started.length;

        let err: unknown;
        try {
          await posts().createPost(
            ws.organizationId,
            request(
              'schedule',
              channels.map((integrationId) => ({ integrationId }))
            ),
            'WEB'
          );
        } catch (e) {
          err = e;
        }

        expect(statusOf(err)).toBe(402);
        expect(bodyOf(err)).toMatchObject({
          code: 'INSUFFICIENT_CREDITS',
          required: 3 * unit,
          available: 2 * unit,
        });
        expect(
          await worker.post.count({ where: { organizationId: ws.organizationId } })
        ).toBe(0);
        expect(
          await worker.creditLedger.count({
            where: { accountId: ws.accountId, status: 'RESERVED' },
          })
        ).toBe(0);
        expect(await balance(ws.organizationId)).toEqual({
          available: 2 * unit,
          reserved: 0,
        });
        await new Promise((r) => setTimeout(r, 200));
        expect(started.length).toBe(before);
      });

      it('402 on an edit changes no post row', async () => {
        const ws = await workspace(unit);
        const a = await channel(ws.organizationId);
        const b = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);

        let err: unknown;
        try {
          await posts().createPost(
            ws.organizationId,
            request('schedule', [
              {
                integrationId: a,
                group: row.group,
                values: [{ id: row.id, content: '<p>changed</p>' }],
              },
              { integrationId: b, group: row.group },
            ]),
            'WEB'
          );
        } catch (e) {
          err = e;
        }

        expect(statusOf(err)).toBe(402);
        const after = await worker.post.findMany({
          where: { organizationId: ws.organizationId },
        });
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({
          id: row.id,
          content: row.content,
          group: row.group,
          deletedAt: null,
          state: 'QUEUE',
        });
        expect(await balance(ws.organizationId)).toEqual({
          available: 0,
          reserved: unit,
        });
      });
    });

    describe('draft', () => {
      it('reserves nothing; draft to scheduled reserves', async () => {
        const ws = await workspace(unit);
        const a = await channel(ws.organizationId);

        const [row] = await schedule(ws.organizationId, [a], 'draft');
        expect(row.state).toBe('DRAFT');
        expect(await ledgerOf(publishKey(row.id, a))).toBeNull();
        expect(await balance(ws.organizationId)).toEqual({
          available: unit,
          reserved: 0,
        });

        await posts().createPost(
          ws.organizationId,
          request('schedule', [
            { integrationId: a, group: row.group, values: [{ id: row.id }] },
          ]),
          'WEB'
        );

        expect((await ledgerOf(publishKey(row.id, a)))!.status).toBe(
          'RESERVED'
        );
        expect(await balance(ws.organizationId)).toEqual({
          available: 0,
          reserved: unit,
        });
      });

      it('changePostStatus to schedule reserves (402 leaves it a draft); to draft releases', async () => {
        const ws = await workspace(0);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a], 'draft');

        let err: unknown;
        try {
          await posts().changePostStatus(ws.organizationId, row.id, 'schedule');
        } catch (e) {
          err = e;
        }
        expect(statusOf(err)).toBe(402);
        expect(
          (await worker.post.findUniqueOrThrow({ where: { id: row.id } })).state
        ).toBe('DRAFT');

        await roles.worker.credits.grant(ws.accountId, {
          type: 'GRANT',
          amount: unit,
        });
        await posts().changePostStatus(ws.organizationId, row.id, 'schedule');
        expect((await ledgerOf(publishKey(row.id, a)))!.status).toBe(
          'RESERVED'
        );

        await posts().changePostStatus(ws.organizationId, row.id, 'draft');
        expect((await ledgerOf(publishKey(row.id, a)))!.status).toBe(
          'RELEASED'
        );
        expect(await balance(ws.organizationId)).toEqual({
          available: unit,
          reserved: 0,
        });
      });
    });

    describe('edit', () => {
      it('a kept channel keeps its reservation; date and content changes reserve nothing', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);
        const reserved = await ledgerOf(publishKey(row.id, a));

        await posts().createPost(
          ws.organizationId,
          request(
            'schedule',
            [
              {
                integrationId: a,
                group: row.group,
                values: [{ id: row.id, content: '<p>edited</p>' }],
              },
            ],
            future(9)
          ),
          'WEB'
        );
        await posts().changeDate(
          ws.organizationId,
          row.id,
          future(12),
          'schedule'
        );
        await posts().changeDate(ws.organizationId, row.id, future(13), 'update');

        const after = await worker.creditLedger.findMany({
          where: { accountId: ws.accountId },
        });
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({
          id: reserved!.id,
          status: 'RESERVED',
          reserved: unit,
        });
        expect(await balance(ws.organizationId)).toEqual({
          available: 4 * unit,
          reserved: unit,
        });
      });

      it('a removed channel releases, an added one reserves', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const b = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);

        await posts().createPost(
          ws.organizationId,
          request('schedule', [{ integrationId: b, group: row.group }]),
          'WEB'
        );

        expect((await ledgerOf(publishKey(row.id, a)))!.status).toBe(
          'RELEASED'
        );
        const added = await firstRowOf(ws.organizationId, b);
        expect((await ledgerOf(publishKey(added.id, b)))!.status).toBe(
          'RESERVED'
        );
        expect(await balance(ws.organizationId)).toEqual({
          available: 4 * unit,
          reserved: unit,
        });
      });

      it('a first row turned into a thread follow-up releases its reservation', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);

        await posts().createPost(
          ws.organizationId,
          request('schedule', [
            {
              integrationId: a,
              group: row.group,
              values: [{}, { id: row.id }],
            },
          ]),
          'WEB'
        );

        expect((await ledgerOf(publishKey(row.id, a)))!.status).toBe(
          'RELEASED'
        );
        const first = await firstRowOf(ws.organizationId, a);
        expect(first.id).not.toBe(row.id);
        expect((await ledgerOf(publishKey(first.id, a)))!.status).toBe(
          'RESERVED'
        );
        expect(await balance(ws.organizationId)).toEqual({
          available: 4 * unit,
          reserved: unit,
        });
      });

      it('an update-type save reserves only a channel it adds', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const b = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);

        await posts().createPost(
          ws.organizationId,
          request(
            'update',
            [
              { integrationId: a, group: row.group, values: [{ id: row.id }] },
              { integrationId: b },
            ]
          ),
          'WEB',
          true
        );

        expect((await ledgerOf(publishKey(row.id, a)))!.status).toBe(
          'RESERVED'
        );

        expect(
          await worker.creditLedger.count({
            where: { accountId: ws.accountId, status: 'RESERVED' },
          })
        ).toBe(2);
        expect(await balance(ws.organizationId)).toEqual({
          available: 3 * unit,
          reserved: 2 * unit,
        });
      });

      it('metadata is a snapshot: group and date as sent when reserved, kept as is by a later edit; postId names the live row', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const b = await channel(ws.organizationId);
        const firstDate = future(4);
        await posts().createPost(
          ws.organizationId,
          request('schedule', [{ integrationId: a }], firstDate),
          'WEB'
        );
        const row = await firstRowOf(ws.organizationId, a);
        const kept = await ledgerOf(publishKey(row.id, a));

        const editDate = future(8);
        await posts().createPost(
          ws.organizationId,
          request(
            'schedule',
            [
              { integrationId: a, group: row.group, values: [{ id: row.id }] },
              { integrationId: b, group: row.group },
            ],
            editDate
          ),
          'WEB'
        );

        const keptAfter = await ledgerOf(publishKey(row.id, a));
        expect(keptAfter!.id).toBe(kept!.id);
        expect(keptAfter!.metadata).toEqual({
          postId: row.id,
          integrationId: a,
          group: row.group,
          occurrence: 1,
          publishDate: dayjs(firstDate).toISOString(),
        });
        expect((await firstRowOf(ws.organizationId, a)).id).toBe(row.id);

        const added = await firstRowOf(ws.organizationId, b);
        expect((await ledgerOf(publishKey(added.id, b)))!.metadata).toEqual({
          postId: added.id,
          integrationId: b,
          group: row.group,
          occurrence: 1,
          publishDate: dayjs(editDate).toISOString(),
        });
      });

      it('a key reopened by an edit records the group and date sent with that edit', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);
        await charging().releaseOccurrence(row.id, a, 1);
        await worker.post.update({
          where: { id: row.id },
          data: { state: 'ERROR' },
        });

        const editDate = future(6);
        await posts().createPost(
          ws.organizationId,
          request(
            'schedule',
            [{ integrationId: a, group: row.group, values: [{ id: row.id }] }],
            editDate
          ),
          'WEB'
        );

        const reopened = await ledgerOf(publishKey(row.id, a));
        expect(reopened!.status).toBe('RESERVED');
        expect(reopened!.metadata).toEqual({
          postId: row.id,
          integrationId: a,
          group: row.group,
          occurrence: 1,
          publishDate: dayjs(editDate).toISOString(),
        });
      });
    });

    describe('delete', () => {
      it('releases every reservation of the group: balance back to before scheduling', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const before = await balance(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);
        await charging().reserveOccurrence(ws.organizationId, row.id, a, 2);
        expect((await balance(ws.organizationId)).reserved).toBe(2 * unit);

        await posts().deletePost(ws.organizationId, row.group);

        expect((await ledgerOf(publishKey(row.id, a)))!.status).toBe(
          'RELEASED'
        );
        expect((await ledgerOf(publishKey(row.id, a, 2)))!.status).toBe(
          'RELEASED'
        );
        expect(await balance(ws.organizationId)).toEqual(before);
        expect(await credits().reconcile(ws.accountId)).toEqual({
          buckets: [],
          ledgers: [],
        });
      });

      it('after the post published changes nothing already committed', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);
        await charging().commitOccurrence(row.id, a, 1);
        const after = await balance(ws.organizationId);

        await posts().deletePost(ws.organizationId, row.group);

        expect(await ledgerOf(publishKey(row.id, a))).toMatchObject({
          status: 'COMMITTED',
          committed: unit,
        });
        expect(await balance(ws.organizationId)).toEqual(after);
        expect(after).toEqual({ available: 4 * unit, reserved: 0 });
      });

      it('leaves other groups of the workspace reserved', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const b = await channel(ws.organizationId);
        const [ra, rb] = await schedule(ws.organizationId, [a, b]);
        expect(ra.group).not.toBe(rb.group);

        await posts().deletePost(ws.organizationId, ra.group);

        expect((await ledgerOf(publishKey(rb.id, b)))!.status).toBe(
          'RESERVED'
        );
      });
    });

    describe('reschedule after a release', () => {
      it('reserves again under the same key at today\'s price', async () => {
        const ws = await workspace(10 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);
        const key = publishKey(row.id, a);
        const first = await ledgerOf(key);
        await charging().releaseOccurrence(row.id, a, 1);
        await worker.post.update({
          where: { id: row.id },
          data: { state: 'ERROR' },
        });

        const action = await worker.creditAction.findUniqueOrThrow({
          where: { key: 'post.publish' },
        });
        await worker.creditAction.update({
          where: { key: 'post.publish' },
          data: { cost: action.cost + 1, version: action.version + 1 },
        });
        try {
          await posts().changeDate(
            ws.organizationId,
            row.id,
            future(4),
            'schedule'
          );
        } finally {
          await worker.creditAction.update({
            where: { key: 'post.publish' },
            data: { cost: action.cost, version: action.version },
          });
        }

        expect(await ledgerOf(key)).toMatchObject({
          id: first!.id,
          status: 'RESERVED',
          unitCost: unit + 1,
          reserved: unit + 1,
          actionVersion: action.version + 1,
        });
        expect(await balance(ws.organizationId)).toEqual({
          available: 10 * unit - (unit + 1),
          reserved: unit + 1,
        });
        expect(await credits().reconcile(ws.accountId)).toEqual({
          buckets: [],
          ledgers: [],
        });
      });

      it('402 leaves the post as it was', async () => {
        const ws = await workspace(unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);
        await charging().releaseOccurrence(row.id, a, 1);
        await roles.worker.credits.spend(
          {
            organizationId: ws.organizationId,
            actionKey: 'post.publish',
            idempotencyKey: 'drain:' + randomUUID(),
          },
          async () => true
        );
        await worker.post.update({
          where: { id: row.id },
          data: { state: 'ERROR' },
        });

        let err: unknown;
        try {
          await posts().changeDate(
            ws.organizationId,
            row.id,
            future(8),
            'schedule'
          );
        } catch (e) {
          err = e;
        }

        expect(statusOf(err)).toBe(402);
        const after = await worker.post.findUniqueOrThrow({
          where: { id: row.id },
        });
        expect(after.state).toBe('ERROR');
        expect(after.publishDate.getTime()).toBe(row.publishDate.getTime());
        expect((await ledgerOf(publishKey(row.id, a)))!.status).toBe(
          'RELEASED'
        );
      });
    });

    describe('reserveOccurrence', () => {
      it('holds one occurrence under its key with the publish metadata; idempotent', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);

        const ledger = await charging().reserveOccurrence(
          ws.organizationId,
          row.id,
          a,
          2
        );
        const again = await charging().reserveOccurrence(
          ws.organizationId,
          row.id,
          a,
          2
        );

        expect(ledger).toMatchObject({
          idempotencyKey: publishKey(row.id, a, 2),
          status: 'RESERVED',
          reserved: unit,
        });
        expect(ledger.metadata).toEqual({
          postId: row.id,
          integrationId: a,
          group: row.group,
          occurrence: 2,
          publishDate: expect.any(String),
        });
        expect(again.id).toBe(ledger.id);
        expect(await balance(ws.organizationId)).toEqual({
          available: 3 * unit,
          reserved: 2 * unit,
        });
      });

      it('402 INSUFFICIENT_CREDITS when unaffordable, nothing held', async () => {
        const ws = await workspace(unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);

        let err: unknown;
        try {
          await charging().reserveOccurrence(ws.organizationId, row.id, a, 2);
        } catch (e) {
          err = e;
        }

        expect(statusOf(err)).toBe(402);
        expect(bodyOf(err).code).toBe('INSUFFICIENT_CREDITS');
        expect(await ledgerOf(publishKey(row.id, a, 2))).toBeNull();
      });

      it('rejects an unknown post (404), another channel (400) and a bad occurrence (400)', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const b = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);
        const other = await workspace(5 * unit);

        const statusFor = async (fn: () => Promise<unknown>) => {
          try {
            await fn();
          } catch (e) {
            return statusOf(e);
          }
          return 200;
        };

        expect(
          await statusFor(() =>
            charging().reserveOccurrence(ws.organizationId, randomUUID(), a, 1)
          )
        ).toBe(404);
        expect(
          await statusFor(() =>
            charging().reserveOccurrence(other.organizationId, row.id, a, 2)
          )
        ).toBe(404);
        expect(
          await statusFor(() =>
            charging().reserveOccurrence(ws.organizationId, row.id, b, 2)
          )
        ).toBe(400);
        expect(
          await statusFor(() =>
            charging().reserveOccurrence(ws.organizationId, row.id, a, 0)
          )
        ).toBe(400);
      });
    });

    describe('commitOccurrence and releaseOccurrence', () => {
      it('commit charges once, however often it runs (worker resumed)', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);

        const first = await charging().commitOccurrence(row.id, a, 1);
        const second = await charging().commitOccurrence(row.id, a, 1);

        expect(first).toMatchObject({ status: 'COMMITTED', committed: unit });
        expect(second.id).toBe(first.id);
        expect(await balance(ws.organizationId)).toEqual({
          available: 4 * unit,
          reserved: 0,
        });
        expect(
          await worker.creditEntry.count({ where: { ledgerId: first.id } })
        ).toBe(1);
      });

      it('release refunds in full and is idempotent', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);

        const released = await charging().releaseOccurrence(row.id, a, 1);
        const again = await charging().releaseOccurrence(row.id, a, 1);

        expect(released).toMatchObject({ status: 'RELEASED' });
        expect(again!.id).toBe(released!.id);
        expect(await balance(ws.organizationId)).toEqual({
          available: 5 * unit,
          reserved: 0,
        });
      });

      it('release of a committed occurrence leaves the charge', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);
        await charging().commitOccurrence(row.id, a, 1);

        const result = await charging().releaseOccurrence(row.id, a, 1);

        expect(result).toMatchObject({ status: 'COMMITTED', committed: unit });
        expect(await balance(ws.organizationId)).toEqual({
          available: 4 * unit,
          reserved: 0,
        });
      });

      it('release of an occurrence never reserved is null', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);

        expect(await charging().releaseOccurrence(row.id, a, 3)).toBeNull();
      });

      it('commit after a release is a ledger-state 409', async () => {
        const ws = await workspace(5 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);
        await charging().releaseOccurrence(row.id, a, 1);

        let err: unknown;
        try {
          await charging().commitOccurrence(row.id, a, 1);
        } catch (e) {
          err = e;
        }
        expect(statusOf(err)).toBe(409);
      });
    });

    describe('preview', () => {
      it('a new post: every channel costs, nothing released; equals what saving reserves', async () => {
        const ws = await workspace(10 * unit);
        const a = await channel(ws.organizationId);
        const b = await channel(ws.organizationId);

        const preview = await charging().preview(ws.organizationId, {
          integrationIds: [a, b, a],
        });
        expect(preview).toEqual({
          amount: 2 * unit,
          newChannels: [a, b],
          releasedChannels: [],
        });

        await schedule(ws.organizationId, [a, b]);
        expect((await balance(ws.organizationId)).reserved).toBe(
          preview.amount
        );
      });

      it('an edit: a kept channel costs nothing, a removed one is released, an added one costs', async () => {
        const ws = await workspace(10 * unit);
        const a = await channel(ws.organizationId);
        const b = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);

        expect(
          await charging().preview(ws.organizationId, {
            group: row.group,
            integrationIds: [a],
          })
        ).toEqual({ amount: 0, newChannels: [], releasedChannels: [] });
        expect(
          await charging().preview(ws.organizationId, {
            group: row.group,
            integrationIds: [b],
          })
        ).toEqual({ amount: unit, newChannels: [b], releasedChannels: [a] });
      });

      it('a kept channel whose reservation was released costs again', async () => {
        const ws = await workspace(10 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);
        await charging().releaseOccurrence(row.id, a, 1);

        expect(
          await charging().preview(ws.organizationId, {
            group: row.group,
            integrationIds: [a],
          })
        ).toEqual({ amount: unit, newChannels: [a], releasedChannels: [] });
      });

      it('another workspace\'s group is not seen', async () => {
        const ws = await workspace(10 * unit);
        const a = await channel(ws.organizationId);
        const [row] = await schedule(ws.organizationId, [a]);
        const other = await workspace(0);

        expect(
          await charging().preview(other.organizationId, {
            group: row.group,
            integrationIds: [],
          })
        ).toEqual({ amount: 0, newChannels: [], releasedChannels: [] });
      });

      it('rejects an invalid request with 400', async () => {
        const ws = await workspace(0);
        let err: unknown;
        try {
          await charging().preview(ws.organizationId, {
            integrationIds: [5 as any],
          });
        } catch (e) {
          err = e;
        }
        expect(statusOf(err)).toBe(400);
      });
    });

    describe('CreditsService.reserve reopenReleased', () => {
      const reserveKey = (organizationId: string, idempotencyKey: string) =>
        credits().reserve({
          organizationId,
          actionKey: 'post.publish',
          idempotencyKey,
        });

      it('by default a released key returns the released row and reserves nothing', async () => {
        const ws = await workspace(5 * unit);
        const key = 'test:' + randomUUID();
        await reserveKey(ws.organizationId, key);
        await credits().release(key, ws.organizationId);

        const again = await reserveKey(ws.organizationId, key);

        expect(again.status).toBe('RELEASED');
        expect(await balance(ws.organizationId)).toEqual({
          available: 5 * unit,
          reserved: 0,
        });
      });

      it('a reopened reservation gives back to the buckets it took from, not the first ones', async () => {
        const ws = await workspace(0);
        const key = 'test:' + randomUUID();
        // The first reservation can only take the never-expiring bucket
        const lasting = await roles.worker.credits.grant(ws.accountId, {
          type: 'TOPUP',
          amount: unit,
        });
        await reserveKey(ws.organizationId, key);
        await credits().release(key, ws.organizationId);
        // The reopened one takes the expiring bucket (earliest expiry first)
        const expiring = await roles.worker.credits.grant(ws.accountId, {
          type: 'GRANT',
          amount: unit,
          expiresInDays: 30,
        });

        const reopened = await credits().reserve(
          {
            organizationId: ws.organizationId,
            actionKey: 'post.publish',
            idempotencyKey: key,
          },
          { reopenReleased: true }
        );
        const bucket = (id: string) =>
          worker.creditBucket.findUniqueOrThrow({ where: { id } });
        expect(reopened.status).toBe('RESERVED');
        expect((await bucket(expiring.bucket.id)).remaining).toBe(0);
        await credits().release(key, ws.organizationId);

        expect((await bucket(expiring.bucket.id)).remaining).toBe(unit);
        expect((await bucket(lasting.bucket.id)).remaining).toBe(unit);
        expect(await credits().reconcile(ws.accountId)).toEqual({
          buckets: [],
          ledgers: [],
        });
      });

      it('402 leaves the key released and takes nothing', async () => {
        const ws = await workspace(unit);
        const key = 'test:' + randomUUID();
        await reserveKey(ws.organizationId, key);
        await credits().release(key, ws.organizationId);
        await roles.worker.credits.spend(
          {
            organizationId: ws.organizationId,
            actionKey: 'post.publish',
            idempotencyKey: 'drain:' + randomUUID(),
          },
          async () => true
        );

        let err: unknown;
        try {
          await credits().reserve(
            {
              organizationId: ws.organizationId,
              actionKey: 'post.publish',
              idempotencyKey: key,
            },
            { reopenReleased: true }
          );
        } catch (e) {
          err = e;
        }

        expect(statusOf(err)).toBe(402);
        expect((await ledgerOf(key))!.status).toBe('RELEASED');
        expect(await credits().reconcile(ws.accountId)).toEqual({
          buckets: [],
          ledgers: [],
        });
      });
    });
  });
});
