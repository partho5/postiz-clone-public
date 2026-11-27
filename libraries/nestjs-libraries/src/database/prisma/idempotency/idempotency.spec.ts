// Idempotency-Key: a mutation sent twice with one key has the effect of one, and the retry gets
// the first answer. Runs the real middleware, service and repository in a real Nest app behind
// `compression`, as the backend runs, against a real Postgres on both database roles. Only the
// authentication in front of it is a stand-in: it sets `req.user` and `req.org` as AuthMiddleware and
// PublicAuthMiddleware do (tenancy.workspace-routing), from test headers.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  NestModule,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import { json } from 'express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  PrismaRepository,
  PrismaService,
  selectWorkerDatabase,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { IdempotencyRepository } from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.repository';
import {
  ANSWER_TTL_MS,
  IdempotencyService,
  MAX_REPLAY_BYTES,
  RUNNING_LEASE_MS,
} from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.service';
import { IdempotencyMiddleware } from '@gitroom/backend/services/idempotency/idempotency.middleware';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

// What the handlers count and hold, reset before every test.
const probe = {
  calls: new Map<string, number>(),
  gate: undefined as undefined | Promise<void>,
  started: undefined as undefined | (() => void),
};
// Counts how many times the handler named `name` has run since the last reset, and returns the count.
const called = (name: string) => {
  const n = (probe.calls.get(name) ?? 0) + 1;
  probe.calls.set(name, n);
  return n;
};

// Sets the principal as the authentication middlewares do: a session user, or only the workspace
// (the public API, whose principal is the credential).
class StubAuth implements NestMiddleware {
  use(req: any, _res: any, next: () => void) {
    const user = req.headers['x-test-user'];
    const org = req.headers['x-test-org'];
    if (user) {
      req.user = { id: user };
    }
    if (org) {
      req.org = { id: org };
    }
    next();
  }
}

@Controller('probe')
class ProbeController {
  @Post('echo')
  echo(@Body() body: any, @Req() req: any) {
    return { n: called(String(req.headers['x-probe'] ?? 'echo')), body };
  }
  @Put('echo')
  put(@Req() req: any) {
    return { n: called('put-' + req.headers['x-probe']) };
  }
  @Patch('echo')
  patch(@Req() req: any) {
    return { n: called('patch-' + req.headers['x-probe']) };
  }
  @Delete('echo')
  remove(@Req() req: any) {
    return { n: called('delete-' + req.headers['x-probe']) };
  }
  @Get('echo')
  get(@Req() req: any) {
    return { n: called('get-' + req.headers['x-probe']) };
  }
  @Post('early')
  early(@Body() body: any, @Req() req: any) {
    return { n: called(String(req.headers['x-probe'])), body };
  }
  @Post('slow')
  async slow(@Req() req: any) {
    const n = called(String(req.headers['x-probe']));
    probe.started?.();
    await probe.gate;
    return { n };
  }
  @Post('fail')
  fail(@Req() req: any, @Res() res: any) {
    called(String(req.headers['x-probe']));
    res.status(503).json({ failed: true });
  }
  @Post('throw')
  throws(@Req() req: any) {
    called(String(req.headers['x-probe']));
    throw new Error('boom');
  }
  @Post('bad')
  bad(@Req() req: any) {
    const n = called(String(req.headers['x-probe']));
    throw new HttpException({ statusCode: 400, code: 'NOPE', n }, 400);
  }
  @Post('empty')
  empty(@Req() req: any, @Res() res: any) {
    called(String(req.headers['x-probe']));
    res.status(204).end();
  }
  @Post('text')
  text(@Req() req: any, @Res() res: any) {
    const n = called(String(req.headers['x-probe']));
    res
      .status(201)
      .type('text/plain; charset=utf-8')
      .send(`créé ✓ ${n} ${'x'.repeat(2000)}`);
  }
  @Post('stream')
  stream(@Req() req: any, @Res() res: any) {
    called(String(req.headers['x-probe']));
    res.status(200).type('text/event-stream');
    res.write('data: one\n\n');
    res.write('data: two\n\n');
    res.end();
  }
  @Post('big')
  big(@Req() req: any, @Res() res: any) {
    called(String(req.headers['x-probe']));
    res
      .status(200)
      .type('text/plain')
      .send('b'.repeat(MAX_REPLAY_BYTES + 1));
  }
  @Post('upload')
  upload(@Req() req: any) {
    // reads the stream as a file upload handler would, after the middleware
    return new Promise((resolve) => {
      const n = called(String(req.headers['x-probe']));
      req.on('data', () => undefined);
      req.on('end', () => resolve({ n }));
    });
  }
}

// A Nest app on a free port whose module provides the middleware's service.
const startApp = async (service: IdempotencyService) => {
  @Module({
    controllers: [ProbeController],
    providers: [StubAuth, { provide: IdempotencyService, useValue: service }],
  })
  class Module_ implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer
        .apply(StubAuth, IdempotencyMiddleware)
        .forRoutes(ProbeController);
    }
  }
  const app = await NestFactory.create(Module_, {
    rawBody: true,
    logger: false,
  });
  app.use(compression());
  // as main.ts does for /posts: wrapped, so Nest still registers its own parsers
  app.use('/probe/early', (req: any, res: any, next: any) =>
    json({ limit: '50mb' })(req, res, next)
  );
  await app.listen(0);
  return { app, base: await app.getUrl() };
};

describeDb('Idempotency-Key (Postgres)', () => {
  let apiService: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  const apps: Record<string, { app: any; base: string }> = {};
  const services: Record<string, IdempotencyService> = {};
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    apiService = new PrismaService();
    await apiService.$connect();
    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    workerService = new PrismaService();
    await workerService.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    for (const [role, prisma] of [
      ['api', apiService],
      ['worker', workerService],
    ] as const) {
      services[role] = new IdempotencyService(
        new IdempotencyRepository(new PrismaRepository<any>(prisma))
      );
      apps[role] = await startApp(services[role]);
    }
  });

  afterAll(async () => {
    await Promise.all(Object.values(apps).map(({ app }) => app.close()));
    await apiService?.$disconnect();
    await workerService?.$disconnect();
    await worker?.$disconnect();
    if (savedWorkerUrl === undefined) {
      delete process.env.DATABASE_WORKER_URL;
    } else {
      process.env.DATABASE_WORKER_URL = savedWorkerUrl;
    }
  });

  beforeEach(() => {
    probe.calls.clear();
    probe.gate = undefined;
    probe.started = undefined;
  });

  // One request to the probe controller as a session user acting in a workspace.
  const send = (
    role: string,
    path: string,
    init: {
      method?: string;
      key?: string;
      user?: string;
      org?: string;
      probe: string;
      body?: unknown;
      headers?: Record<string, string>;
      raw?: string;
    }
  ) =>
    fetch(apps[role].base + '/probe/' + path, {
      method: init.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        'x-probe': init.probe,
        ...(init.user ?? 'user-1'
          ? { 'x-test-user': init.user ?? 'user-1' }
          : {}),
        'x-test-org': init.org ?? 'org-1',
        ...(init.key !== undefined ? { 'idempotency-key': init.key } : {}),
        ...init.headers,
      },
      ...((init.method ?? 'POST') === 'GET' || (init.method ?? '') === 'DELETE'
        ? {}
        : {
            body:
              init.raw ??
              JSON.stringify(init.body === undefined ? { a: 1 } : init.body),
          }),
    });

  // The stored idempotency record for a key, read straight from the table.
  const record = (key: string) =>
    worker.idempotencyRecord.findFirst({ where: { key } });

  describe.each(['api', 'worker'])('on the %s role', (role) => {
    it('processes a request with no key normally and stores nothing', async () => {
      const name = randomUUID();
      const first = await (await send(role, 'echo', { probe: name })).json();
      const second = await (await send(role, 'echo', { probe: name })).json();

      expect([first.n, second.n]).toEqual([1, 2]);
    });

    it('runs the handler once for a new key and stores the final status and body for 24 hours', async () => {
      const key = randomUUID();
      const before = Date.now();
      const answer = await send(role, 'echo', { probe: key, key });
      const body = await answer.json();

      expect(answer.status).toBe(201);
      expect(answer.headers.get('idempotent-replayed')).toBeNull();
      expect(body.n).toBe(1);
      const stored = await record(key);
      expect(stored?.state).toBe('DONE');
      expect(stored?.statusCode).toBe(201);
      expect(JSON.parse(Buffer.from(stored!.responseBody!).toString())).toEqual(
        body
      );
      const ttl = stored!.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(ANSWER_TTL_MS - 60_000);
      expect(ttl).toBeLessThanOrEqual(ANSWER_TTL_MS + 60_000);
    });

    it('answers a finished key with the stored status and body, marked as a replay, without running the handler', async () => {
      const key = randomUUID();
      const first = await send(role, 'text', { probe: key, key });
      const firstBytes = Buffer.from(await first.arrayBuffer());
      const retry = await send(role, 'text', { probe: key, key });
      const retryBytes = Buffer.from(await retry.arrayBuffer());

      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(retry.headers.get('content-type')).toBe(
        first.headers.get('content-type')
      );
      expect(retryBytes.equals(firstBytes)).toBe(true);
      expect(retryBytes.toString()).toContain('créé ✓ 1 ');
      expect(probe.calls.get(key)).toBe(1);
    });

    it('replays a 4xx answer and an empty answer, and runs the handler once', async () => {
      const bad = randomUUID();
      const empty = randomUUID();
      const first = await send(role, 'bad', { probe: bad, key: bad });
      const retry = await send(role, 'bad', { probe: bad, key: bad });
      const e1 = await send(role, 'empty', { probe: empty, key: empty });
      const e2 = await send(role, 'empty', { probe: empty, key: empty });

      expect(first.status).toBe(400);
      expect(retry.status).toBe(400);
      expect(await retry.json()).toEqual(await first.json());
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(e1.status).toBe(204);
      expect(e2.status).toBe(204);
      expect(e2.headers.get('idempotent-replayed')).toBe('true');
      expect(probe.calls.get(bad)).toBe(1);
      expect(probe.calls.get(empty)).toBe(1);
    });

    it('covers POST, PUT, PATCH and DELETE and never GET', async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const key = randomUUID();
        const a = await send(role, 'echo', { method, probe: key, key });
        const b = await send(role, 'echo', { method, probe: key, key });
        expect(b.headers.get('idempotent-replayed')).toBe('true');
        expect((await b.json()).n).toBe((await a.json()).n);
      }
      const key = randomUUID();
      await send(role, 'echo', { method: 'GET', probe: key, key });
      const again = await send(role, 'echo', {
        method: 'GET',
        probe: key,
        key,
      });
      expect(again.headers.get('idempotent-replayed')).toBeNull();
      expect(probe.calls.get('get-' + key)).toBe(2);
      expect(await record(key)).toBeNull();
    });

    it('refuses a running key with 409 IDEMPOTENCY_IN_PROGRESS and never runs two handlers at once', async () => {
      const key = randomUUID();
      let release!: () => void;
      probe.gate = new Promise<void>((r) => (release = r));
      const started = new Promise<void>((r) => (probe.started = r));
      const first = send(role, 'slow', { probe: key, key });
      await started;

      const second = await send(role, 'slow', { probe: key, key });
      expect(second.status).toBe(409);
      expect((await second.json()).code).toBe('IDEMPOTENCY_IN_PROGRESS');

      release();
      const done = await first;
      const retry = await send(role, 'slow', { probe: key, key });
      expect(done.status).toBe(201);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(await retry.json()).toEqual(await done.json());
      expect(probe.calls.get(key)).toBe(1);
    });

    it('runs the handler once when twenty requests with the same key arrive together', async () => {
      const key = randomUUID();
      const answers = await Promise.all(
        Array.from({ length: 20 }, () =>
          send(role, 'echo', { probe: key, key })
        )
      );
      const statuses = answers.map((a) => a.status);

      expect(probe.calls.get(key)).toBe(1);
      expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(
        1
      );
      expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    });

    it('refuses the same key for a different request with 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = randomUUID();
      await send(role, 'echo', { probe: key, key, body: { a: 1 } });

      const otherBody = await send(role, 'echo', {
        probe: key,
        key,
        body: { a: 2 },
      });
      const otherPath = await send(role, 'early', {
        probe: key,
        key,
        body: { a: 1 },
      });
      const otherMethod = await send(role, 'echo', {
        method: 'PUT',
        probe: key,
        key,
      });

      for (const answer of [otherBody, otherPath, otherMethod]) {
        expect(answer.status).toBe(422);
        expect((await answer.json()).code).toBe('IDEMPOTENCY_KEY_REUSED');
      }
      expect(probe.calls.get(key)).toBe(1);
    });

    it('refuses a different request even while the first one still runs', async () => {
      const key = randomUUID();
      let release!: () => void;
      probe.gate = new Promise<void>((r) => (release = r));
      const started = new Promise<void>((r) => (probe.started = r));
      const first = send(role, 'slow', { probe: key, key, body: { a: 1 } });
      await started;

      const other = await send(role, 'slow', {
        probe: key,
        key,
        body: { a: 2 },
      });
      release();
      await first;

      expect(other.status).toBe(422);
      expect((await other.json()).code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('stores nothing when the handler answered 5xx or threw, and a retry runs the handler again', async () => {
      for (const path of ['fail', 'throw']) {
        const key = randomUUID();
        const first = await send(role, path, { probe: key, key });
        const retry = await send(role, path, { probe: key, key });

        expect(first.status).toBeGreaterThanOrEqual(500);
        expect(retry.status).toBeGreaterThanOrEqual(500);
        expect(retry.headers.get('idempotent-replayed')).toBeNull();
        expect(probe.calls.get(key)).toBe(2);
        expect(await record(key)).toBeNull();
      }
    });

    it('treats a streamed answer as not replayable: a retry after it finished gets 409 IDEMPOTENCY_KEY_USED', async () => {
      const key = randomUUID();
      const first = await send(role, 'stream', { probe: key, key });
      expect(await first.text()).toBe('data: one\n\ndata: two\n\n');

      const retry = await send(role, 'stream', { probe: key, key });
      expect(retry.status).toBe(409);
      expect((await retry.json()).code).toBe('IDEMPOTENCY_KEY_USED');
      expect(probe.calls.get(key)).toBe(1);
    });

    it('treats an answer too long to keep as not replayable', async () => {
      const key = randomUUID();
      const first = await send(role, 'big', { probe: key, key });
      expect((await first.text()).length).toBe(MAX_REPLAY_BYTES + 1);

      const retry = await send(role, 'big', { probe: key, key });
      expect(retry.status).toBe(409);
      expect((await retry.json()).code).toBe('IDEMPOTENCY_KEY_USED');
    });

    it.each([
      ['empty', ''],
      ['with a space', 'a b'],
      ['non-ASCII', 'clé'],
      ['256 characters', 'k'.repeat(256)],
    ])(
      'refuses a key that is %s with 400 IDEMPOTENCY_KEY_INVALID',
      async (_n, key) => {
        const name = randomUUID();
        const answer = await send(role, 'echo', { probe: name, key });

        expect(answer.status).toBe(400);
        expect((await answer.json()).code).toBe('IDEMPOTENCY_KEY_INVALID');
        expect(probe.calls.get(name)).toBeUndefined();
      }
    );

    it.each([
      ['1 character', 'k'],
      ['255 characters', 'k'.repeat(255)],
      ['punctuation', '!~:/_-=@'],
    ])('accepts a key of %s', async (_n, key) => {
      await worker.idempotencyRecord.deleteMany({ where: { key } });
      const answer = await send(role, 'echo', { probe: randomUUID(), key });

      expect(answer.status).toBe(201);
      await worker.idempotencyRecord.deleteMany({ where: { key } });
    });

    it('never lets one user, one API credential or one workspace use another one’s key', async () => {
      const key = randomUUID();
      await send(role, 'echo', {
        probe: key,
        key,
        user: 'user-A',
        org: 'org-1',
      });
      const otherUser = await send(role, 'echo', {
        probe: key,
        key,
        user: 'user-B',
        org: 'org-1',
      });
      const otherOrg = await send(role, 'echo', {
        probe: key,
        key,
        user: 'user-A',
        org: 'org-2',
      });
      const credA = await send(role, 'echo', {
        probe: key,
        key,
        user: '',
        org: 'org-1',
        headers: { authorization: 'key-A' },
      });
      const credB = await send(role, 'echo', {
        probe: key,
        key,
        user: '',
        org: 'org-1',
        headers: { authorization: 'key-B' },
      });
      const credAagain = await send(role, 'echo', {
        probe: key,
        key,
        user: '',
        org: 'org-1',
        headers: { authorization: 'key-A' },
      });

      for (const answer of [otherUser, otherOrg, credA, credB]) {
        expect(answer.headers.get('idempotent-replayed')).toBeNull();
        expect(answer.status).toBe(201);
      }
      expect(credAagain.headers.get('idempotent-replayed')).toBe('true');
      expect(probe.calls.get(key)).toBe(5);
    });

    it('never stores the API credential itself', async () => {
      const key = randomUUID();
      await send(role, 'echo', {
        probe: key,
        key,
        user: '',
        headers: { authorization: 'secret-credential-value' },
      });

      const stored = await record(key);
      expect(stored?.principal).not.toContain('secret-credential-value');
      expect(stored?.principal.startsWith('key:')).toBe(true);
    });

    it('leaves a request with no authenticated principal alone', async () => {
      const key = randomUUID();
      const call = () =>
        fetch(apps[role].base + '/probe/echo', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-probe': key,
            'idempotency-key': key,
          },
          body: '{}',
        });
      await call();
      const second = await call();

      expect(second.headers.get('idempotent-replayed')).toBeNull();
      expect(probe.calls.get(key)).toBe(2);
      expect(await record(key)).toBeNull();
    });

    it('counts a record past its expiry as absent', async () => {
      const key = randomUUID();
      await send(role, 'echo', { probe: key, key });
      await worker.idempotencyRecord.updateMany({
        where: { key },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const again = await send(role, 'echo', { probe: key, key });
      expect(again.headers.get('idempotent-replayed')).toBeNull();
      expect((await again.json()).n).toBe(2);
      expect((await record(key))?.expiresAt.getTime()).toBeGreaterThan(
        Date.now()
      );
    });

    it('holds a running key only for a lease, so a handler that never finished frees it', async () => {
      const key = randomUUID();
      let release!: () => void;
      probe.gate = new Promise<void>((r) => (release = r));
      const started = new Promise<void>((r) => (probe.started = r));
      const first = send(role, 'slow', { probe: key, key });
      await started;
      const running = await record(key);
      expect(running?.state).toBe('RUNNING');
      const lease = running!.expiresAt.getTime() - Date.now();
      expect(lease).toBeGreaterThan(RUNNING_LEASE_MS - 60_000);
      expect(lease).toBeLessThanOrEqual(RUNNING_LEASE_MS);

      await worker.idempotencyRecord.updateMany({
        where: { key },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      release();
      await first;
      const retry = await send(role, 'slow', { probe: key, key });
      expect(retry.status).toBe(201);
    });

    it('fingerprints the same bytes the same whether Nest kept the raw body or an earlier parser took it', async () => {
      const key = randomUUID();
      const raw = '{"b":2,  "a":[1,2,3], "text":"é"}';
      const first = await send(role, 'early', { probe: key, key, raw });
      const retry = await send(role, 'early', { probe: key, key, raw });
      const other = await send(role, 'early', {
        probe: key,
        key,
        raw: '{"b":3,  "a":[1,2,3], "text":"é"}',
      });

      expect(first.status).toBe(201);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(other.status).toBe(422);
      expect(probe.calls.get(key)).toBe(1);
    });

    it('fingerprints an upload by its content headers without reading the stream first', async () => {
      const key = randomUUID();
      const upload = (size: number) =>
        send(role, 'upload', {
          probe: key,
          key,
          headers: { 'content-type': 'multipart/form-data; boundary=x' },
          raw: 'x'.repeat(size),
        });
      const first = await upload(10);
      const retry = await upload(10);
      const other = await upload(11);

      expect(first.status).toBe(201);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(other.status).toBe(422);
      expect(probe.calls.get(key)).toBe(1);
    });

    it('deletes only the expired records, and says how many', async () => {
      const principal = 'cleanup-' + randomUUID();
      const make = (key: string, expiresAt: Date) => ({
        principal,
        workspaceId: 'w',
        key,
        fingerprint: 'f',
        state: 'DONE' as const,
        expiresAt,
      });
      await worker.idempotencyRecord.createMany({
        data: [
          make('old-1', new Date(Date.now() - 60_000)),
          make('old-2', new Date(Date.now() - 3_600_000)),
          make('live', new Date(Date.now() + 3_600_000)),
        ],
      });

      const { deleted } = await services[role].deleteExpired();

      expect(deleted).toBeGreaterThanOrEqual(2);
      const left = await worker.idempotencyRecord.findMany({
        where: { principal },
      });
      expect(left.map((r) => r.key)).toEqual(['live']);
      await worker.idempotencyRecord.deleteMany({ where: { principal } });
    });
  });

  it('keeps one record per scope and key even when claimed from both roles at once', async () => {
    const key = randomUUID();
    const scope = { principal: 'user:race', workspaceId: 'w', key };
    const results = await Promise.all([
      services.api.begin(scope, 'f').catch((e) => e),
      services.worker.begin(scope, 'f').catch((e) => e),
    ]);

    expect(results.filter((r) => r?.kind === 'run')).toHaveLength(1);
    expect(await worker.idempotencyRecord.count({ where: { key } })).toBe(1);
  });
});
