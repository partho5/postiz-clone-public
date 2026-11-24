// AI charging: the text and picture entry points — copilot chat and agent, the post generator
// and its pictures, separate-posts and autopost — go through AiChargingService. Each is driven through
// its real controller or service against a real Postgres, with only the AI providers stubbed: with too
// few credits nothing is generated or charged, a failed generation leaves no committed charge.
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
import { CopilotController } from '@gitroom/backend/api/routes/copilot.controller';
import { PostsController } from '@gitroom/backend/api/routes/posts.controller';
import { AgentGraphService } from '@gitroom/nestjs-libraries/agent/agent.graph.service';
import { AutopostService } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.service';
import { AutopostActivity } from '../../../../../../../apps/orchestrator/src/activities/autopost.activity';
import { AbstractAgent, EventType } from '@ag-ui/client';
import { HttpException } from '@nestjs/common';
import express, { json, urlencoded } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { Observable } from 'rxjs';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';

// Only what a unit that cannot load under ts-jest (ESM-only packages, the provider SDKs) needs to be
// imported: the providers answer what the test sets, nothing else is replaced.
const mockDalle = jest.fn();
const mockModel = jest.fn();
const mockRuntimeHandler = jest.fn();
// The runtime tests that must see the real CopilotKit runtime switch this on; the others stub its handler.
let mockUseRealRuntime = false;
const mockLocalAgents = jest.fn(() => ({}));
jest.mock('file-type', () => ({}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock(
  '@gitroom/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);
jest.mock('jsdom', () => ({ JSDOM: class {} }));
jest.mock('@copilotkit/runtime', () => {
  const actual = jest.requireActual('@copilotkit/runtime');
  return {
    ...actual,
    copilotRuntimeNodeHttpEndpoint: (options: unknown) => {
      const real = actual.copilotRuntimeNodeHttpEndpoint(options);
      return (...args: unknown[]) =>
        mockUseRealRuntime ? real(...args) : mockRuntimeHandler(...args);
    },
  };
});
jest.mock('@ag-ui/mastra', () => ({
  MastraAgent: { getLocalAgents: () => mockLocalAgents() },
}));
jest.mock('@gitroom/nestjs-libraries/chat/mastra.service', () => ({
  MastraService: class {},
}));
jest.mock('@mastra/core/di', () => ({
  RequestContext: class {
    set() {}
  },
}));
jest.mock('@langchain/openai', () => {
  const { RunnableLambda } = jest.requireActual('@langchain/core/runnables');
  return {
    ChatOpenAI: class {
      withStructuredOutput() {
        return RunnableLambda.from(async () => mockModel());
      }
    },
    DallEAPIWrapper: class {
      invoke(prompt: string) {
        return mockDalle(prompt);
      }
    },
  };
});

// An agent standing in for the Mastra agent: it answers a run and tells the test that a model was reached.
class CountingAgent extends AbstractAgent {
  // static because the runtime clones an agent for each request
  static onRun: () => void = () => undefined;
  run(input: { threadId: string; runId: string }) {
    return new Observable<any>((subscriber) => {
      CountingAgent.onRun();
      const ids = { threadId: input.threadId, runId: input.runId };
      subscriber.next({ type: EventType.RUN_STARTED, ...ids });
      subscriber.next({ type: EventType.RUN_FINISHED, ...ids });
      subscriber.complete();
    });
  }
}

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// Direct reads of the money tables use the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('AI text and picture entry points (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let text: number;
  let image: number;
  let credits: CreditsService;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;
  const savedOpenAiKey = process.env.OPENAI_API_KEY;

  const ledgers = (accountId: string) =>
    worker.creditLedger.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    });
  const balance = (organizationId: string) => credits.balance(organizationId);
  // Waits for a condition that a call still settling in the background makes true.
  const until = async (condition: () => Promise<boolean>) => {
    for (let i = 0; i < 50 && !(await condition()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  // The credits and AI services on a given client, wired as the database module wires them.
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
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    api = new PrismaService();
    await api.$connect();
    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    workerService = new PrismaService();
    await workerService.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    process.env.OPENAI_API_KEY = 'sk-test';

    const repo = new PrismaRepository<any>(api);
    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    credits = chargingOn(api).credits;
    await new PricingService(
      new PricingRepository(new PrismaTransaction(api), repo, repo),
      credits,
      accounts
    ).sync();
    text = (await credits.quote('ai.text', 1, 'PRO')).unitCost;
    image = (await credits.quote('ai.image', 1, 'PRO')).unitCost;
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
    if (savedOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = savedOpenAiKey;
    }
  });

  beforeEach(() => {
    mockDalle.mockReset();
    mockModel.mockReset();
    mockRuntimeHandler.mockReset();
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

  describe.each(['api', 'worker'] as const)('on the %s role', (role) => {
    const wired = () => chargingOn(role === 'api' ? api : workerService);

    describe('copilot chat and agent (POST /copilot/chat, /copilot/agent)', () => {
      const controller = () =>
        new CopilotController(wired().ai, wired().credits, {
          mastra: async () => ({}),
        } as any);
      // a request express parsed as a JSON envelope
      const jsonRequest = (method: string) =>
        ({ is: () => 'json', body: { method } }) as any;
      const call = (
        route: 'chat' | 'agent',
        ws: { org: any },
        method: string
      ) =>
        route === 'chat'
          ? controller().chatAgent(jsonRequest(method), {} as any, ws.org)
          : controller().agent(jsonRequest(method), {} as any, ws.org);

      it.each(['chat', 'agent'] as const)(
        '%s: an agent/run is one ai.text, charged before the runtime handles it',
        async (route) => {
          const ws = await workspace(10 * text);
          let heldWhileRunning: unknown;
          mockRuntimeHandler.mockImplementation(async () => {
            heldWhileRunning = await balance(ws.org.id);
          });

          await call(route, ws, 'agent/run');

          expect(mockRuntimeHandler).toHaveBeenCalledTimes(1);
          expect(heldWhileRunning).toEqual({
            available: 9 * text,
            reserved: text,
          });
          const [ledger] = await ledgers(ws.accountId);
          expect(ledger).toMatchObject({
            actionKey: 'ai.text',
            status: 'COMMITTED',
            committed: text,
            metadata: { kind: 'text', route: `copilot.${route}` },
          });
          expect(await balance(ws.org.id)).toEqual({
            available: 9 * text,
            reserved: 0,
          });
        }
      );

      it.each(['chat', 'agent'] as const)(
        '%s: zero balance is a 402 before the runtime opens anything, and the ledger is unchanged',
        async (route) => {
          const ws = await workspace(0);

          const err = await call(route, ws, 'agent/run').catch((e) => e);

          expect(err.getStatus()).toBe(402);
          expect(err.getResponse()).toMatchObject({
            code: 'INSUFFICIENT_CREDITS',
          });
          expect(mockRuntimeHandler).not.toHaveBeenCalled();
          expect(await ledgers(ws.accountId)).toHaveLength(0);
        }
      );

      it.each(['info', 'agent/connect', 'agent/stop'])(
        'the runtime call %s generates nothing and is free',
        async (method) => {
          const ws = await workspace(0);

          await call('agent', ws, method);

          expect(mockRuntimeHandler).toHaveBeenCalledTimes(1);
          expect(await ledgers(ws.accountId)).toHaveLength(0);
        }
      );

      it('a runtime that throws leaves no committed charge', async () => {
        const ws = await workspace(10 * text);
        mockRuntimeHandler.mockRejectedValue(new Error('runtime down'));

        await expect(call('agent', ws, 'agent/run')).rejects.toThrow(
          'runtime down'
        );

        expect(await balance(ws.org.id)).toEqual({
          available: 10 * text,
          reserved: 0,
        });
        expect((await ledgers(ws.accountId))[0].status).toBe('RELEASED');
      });

      it("GET /copilot/credits answers the account's available credits", async () => {
        const ws = await workspace(7 * text);
        await wired().ai.reserve({
          organizationId: ws.org.id,
          kind: 'text',
          idempotencyKey: `ai:${randomUUID()}`,
        });

        await expect(controller().calculateCredits(ws.org)).resolves.toEqual({
          credits: 6 * text,
        });
      });

      // The controllers behind a real HTTP server and the real CopilotKit runtime: only the model is
      // replaced (a counting OpenAI endpoint for /copilot/chat, a counting agent for /copilot/agent), so
      // which single-route methods reach a model is the runtime's own answer, not this test's assumption.
      describe('every method of the real CopilotKit runtime', () => {
        const generating = ['agent/run', 'agent/suggest'];
        const free = [
          'agent/connect',
          'agent/stop',
          'info',
          'inspector/metadata',
          'inspector/learning',
          'transcribe',
          'resource/request',
        ];
        const input = () => ({
          threadId: randomUUID(),
          runId: randomUUID(),
          messages: [{ id: randomUUID(), role: 'user', content: 'hello' }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        });
        const envelope = (method: string) => ({
          method,
          params: {
            agentId: 'default',
            threadId: 'thread',
            path: '/threads',
            httpMethod: 'GET',
          },
          body: input(),
        });

        let modelCalls = 0;
        let current: { route: 'chat' | 'agent'; org: unknown };
        let modelServer: http.Server;
        let appServer: http.Server;
        let appUrl: string;
        const savedBaseUrl = process.env.OPENAI_BASE_URL;

        beforeAll(async () => {
          modelServer = http.createServer((req, res) => {
            modelCalls++;
            const chunk = (delta: object, finish: string | null) => ({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-4.1',
              choices: [{ index: 0, delta, finish_reason: finish }],
            });
            res.setHeader('content-type', 'text/event-stream');
            res.write(
              `data: ${JSON.stringify(chunk({ role: 'assistant', content: 'hi' }, null))}\n\n`
            );
            res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
            res.end('data: [DONE]\n\n');
          });
          await new Promise<void>((resolve) =>
            modelServer.listen(0, '127.0.0.1', resolve)
          );
          process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;

          CountingAgent.onRun = () => modelCalls++;
          mockLocalAgents.mockImplementation((() => ({
            default: new CountingAgent(),
          })) as any);

          // express 5 with the body parsers the backend runs (`main.ts`'s json for /copilot, Nest's default
          // json and urlencoded), so what the controller reads is what the real backend would give it
          const app = express();
          app.use('/copilot/{*splat}', json({ limit: '50mb' }));
          app.use(json());
          app.use(urlencoded({ extended: true }));
          app.post('/copilot/:route', async (req, res) => {
            try {
              const c = controller();
              await (current.route === 'chat'
                ? c.chatAgent(req as any, res as any, current.org as any)
                : c.agent(req as any, res as any, current.org as any));
            } catch (e: any) {
              res.statusCode = e.getStatus?.() ?? 500;
              res.end(JSON.stringify(e.getResponse?.() ?? {}));
            }
          });
          appServer = http.createServer(app);
          await new Promise<void>((resolve) =>
            appServer.listen(0, '127.0.0.1', resolve)
          );
          appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
        });

        afterAll(async () => {
          mockLocalAgents.mockImplementation(() => ({}));
          if (savedBaseUrl === undefined) {
            delete process.env.OPENAI_BASE_URL;
          } else {
            process.env.OPENAI_BASE_URL = savedBaseUrl;
          }
          await new Promise((resolve) => modelServer.close(resolve));
          await new Promise((resolve) => appServer.close(resolve));
        });

        beforeEach(() => {
          modelCalls = 0;
          mockUseRealRuntime = true;
        });
        afterEach(() => {
          mockUseRealRuntime = false;
        });

        // POSTs a single-route envelope as `ws` and reads the whole answer.
        const post = async (
          route: 'chat' | 'agent',
          ws: { org: unknown },
          method: string,
          contentType = 'application/json'
        ) => {
          current = { route, org: ws.org };
          const response = await fetch(`${appUrl}/copilot/${route}`, {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: JSON.stringify(envelope(method)),
          });
          return { status: response.status, body: await response.text() };
        };

        describe.each(['chat', 'agent'] as const)('/copilot/%s', (route) => {
          it.each(generating)(
            '%s reaches a model and is one committed ai.text',
            async (method) => {
              const ws = await workspace(10 * text);

              await post(route, ws, method);
              await until(async () =>
                (await ledgers(ws.accountId)).every(
                  (l) => l.status === 'COMMITTED'
                )
              );

              expect(modelCalls).toBeGreaterThan(0);
              const rows = await ledgers(ws.accountId);
              expect(rows).toHaveLength(1);
              expect(rows[0]).toMatchObject({
                actionKey: 'ai.text',
                status: 'COMMITTED',
                committed: text,
              });
              expect(await balance(ws.org.id)).toEqual({
                available: 9 * text,
                reserved: 0,
              });
            }
          );

          it.each(generating)(
            '%s at zero balance is a 402, no model is called and the ledger is unchanged',
            async (method) => {
              const ws = await workspace(0);

              const { status, body } = await post(route, ws, method);

              expect(status).toBe(402);
              expect(JSON.parse(body)).toMatchObject({
                code: 'INSUFFICIENT_CREDITS',
              });
              expect(modelCalls).toBe(0);
              expect(await ledgers(ws.accountId)).toHaveLength(0);
            }
          );

          it.each(free)(
            '%s reaches no model and costs nothing, even at zero balance',
            async (method) => {
              const ws = await workspace(0);

              const { status } = await post(route, ws, method);

              expect(status).not.toBe(402);
              expect(modelCalls).toBe(0);
              expect(await ledgers(ws.accountId)).toHaveLength(0);
            }
          );

          // The runtime accepts any Content-Type that contains application/json and reads the raw stream
          // when express parsed nothing, so the body the charge is decided on must be the one it executes.
          describe.each([
            'text/plain; x=application/json',
            'text/plain;application/json',
            'application/x-www-form-urlencoded; a=application/json',
          ])('a JSON envelope sent as %s', (contentType) => {
            it.each([...generating, ...free])(
              '%s reaches no model and is refused, funded or not, with nothing charged',
              async (method) => {
                for (const amount of [0, 10 * text]) {
                  const ws = await workspace(amount);

                  const { status } = await post(route, ws, method, contentType);

                  expect(status).toBe(400);
                  expect(modelCalls).toBe(0);
                  expect(await ledgers(ws.accountId)).toHaveLength(0);
                }
              }
            );
          });

          it('a method the runtime does not know is refused with nothing charged', async () => {
            const ws = await workspace(10 * text);

            const { status } = await post(route, ws, 'agent/unknown');

            expect(status).toBe(400);
            expect(modelCalls).toBe(0);
            expect(await ledgers(ws.accountId)).toHaveLength(0);
          });
        });
      });
    });

    describe('post generator and separate-posts (PostsController)', () => {
      const response = () => ({
        setHeader: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      });
      const controller = (graph: unknown, posts: unknown = {}) =>
        new PostsController(posts as any, graph as any, {} as any, wired().ai);

      it('POST /posts/generator: one ai.text, held before the stream opens and committed when it ends, the request key given to the graph', async () => {
        const ws = await workspace(10 * text);
        const res = response();
        let started: unknown[] = [];
        let heldAtOpen: unknown;
        res.setHeader.mockImplementation(async () => undefined);
        const graph = {
          start: async function* (...args: unknown[]) {
            started = args;
            heldAtOpen = await balance(ws.org.id);
            yield { name: 'agent' };
            yield { name: 'done' };
          },
        };

        await controller(graph).generatePosts(
          ws.org,
          { research: 'x' } as any,
          res as any
        );

        expect(res.write).toHaveBeenCalledTimes(2);
        expect(res.end).toHaveBeenCalledTimes(1);
        const [ledger] = await ledgers(ws.accountId);
        expect(ledger).toMatchObject({
          actionKey: 'ai.text',
          status: 'COMMITTED',
          committed: text,
          metadata: { kind: 'text', route: 'posts.generator' },
        });
        expect(started).toEqual([
          ws.org.id,
          { research: 'x' },
          ledger.idempotencyKey,
        ]);
        expect(heldAtOpen).toEqual({ available: 9 * text, reserved: text });
      });

      it('POST /posts/generator: zero balance is a 402 before the stream opens, nothing is generated', async () => {
        const ws = await workspace(0);
        const res = response();
        const start = jest.fn();

        const err = await controller({ start })
          .generatePosts(ws.org, { research: 'x' } as any, res as any)
          .catch((e) => e);

        expect(err.getStatus()).toBe(402);
        expect(res.setHeader).not.toHaveBeenCalled();
        expect(res.write).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(await ledgers(ws.accountId)).toHaveLength(0);
      });

      it('POST /posts/generator: a generation that fails ends the stream with an error event and gives the credits back', async () => {
        const ws = await workspace(10 * text);
        const res = response();
        const graph = {
          // eslint-disable-next-line require-yield
          start: async function* () {
            throw new HttpException('The AI safety system rejected it', 422);
          },
        };

        await controller(graph).generatePosts(
          ws.org,
          { research: 'x' } as any,
          res as any
        );

        expect(JSON.parse(res.write.mock.calls[0][0])).toEqual({
          name: 'error',
          error: true,
          message: 'The AI safety system rejected it',
        });
        expect(res.end).toHaveBeenCalledTimes(1);
        expect((await ledgers(ws.accountId))[0].status).toBe('RELEASED');
        expect(await balance(ws.org.id)).toEqual({
          available: 10 * text,
          reserved: 0,
        });
      });

      it('POST /posts/separate-posts: one ai.text; zero balance is a 402 and nothing runs; a failure is released', async () => {
        const ws = await workspace(2 * text);
        const separate = jest.fn(async () => ({ posts: ['a', 'b'] }));
        const c = controller({}, { separatePosts: separate });

        await expect(
          c.separatePosts(ws.org, { content: 'x', len: 100 })
        ).resolves.toEqual({
          posts: ['a', 'b'],
        });
        expect(separate).toHaveBeenCalledWith('x', 100);
        expect((await ledgers(ws.accountId))[0]).toMatchObject({
          actionKey: 'ai.text',
          status: 'COMMITTED',
          metadata: { kind: 'text', route: 'posts.separate-posts' },
        });

        separate.mockRejectedValueOnce(new Error('down'));
        await expect(
          c.separatePosts(ws.org, { content: 'x', len: 100 })
        ).rejects.toThrow('down');
        expect(await balance(ws.org.id)).toEqual({
          available: text,
          reserved: 0,
        });

        const broke = await workspace(0);
        separate.mockClear();
        const err = await c
          .separatePosts(broke.org, { content: 'x', len: 100 })
          .catch((e) => e);
        expect(err.getStatus()).toBe(402);
        expect(separate).not.toHaveBeenCalled();
        expect(await ledgers(broke.accountId)).toHaveLength(0);
      });

      it('POST /posts/generator/draft calls no AI provider and is not charged', async () => {
        const ws = await workspace(0);
        const generatePostsDraft = jest.fn(async () => undefined);

        await controller({}, { generatePostsDraft }).generatePostsDraft(
          ws.org,
          {} as any
        );

        expect(generatePostsDraft).toHaveBeenCalledTimes(1);
        expect(await ledgers(ws.accountId)).toHaveLength(0);
      });
    });

    describe('post generator pictures (AgentGraphService.generatePictures)', () => {
      const graph = () =>
        new AgentGraphService({} as any, {} as any, wired().ai);
      const state = (
        ws: { org: any },
        n: number,
        extra: Record<string, unknown> = {}
      ) =>
        ({
          orgId: ws.org.id,
          requestKey: `ai:${randomUUID()}`,
          isPicture: true,
          content: Array.from({ length: n }, (_, i) => ({
            content: `post ${i}`,
            prompt: `prompt ${i}`,
          })),
          ...extra,
        } as any);

      it('one ai.image per picture, held as each is generated, keyed by the request and the post', async () => {
        const ws = await workspace(5 * image);
        mockDalle.mockImplementation(async (p: string) => `image of ${p}`);
        const s = state(ws, 3);

        const out: any = await graph().generatePictures(s);

        expect(out.content.map((c: any) => c.image)).toEqual([
          'image of prompt 0',
          'image of prompt 1',
          'image of prompt 2',
        ]);
        expect(out.picturesSkipped).toBe(0);
        const held = await ledgers(ws.accountId);
        expect(held.map((l) => l.idempotencyKey).sort()).toEqual(
          [0, 1, 2].map((i) => `${s.requestKey}:image:${i}`)
        );
        expect(
          held.every(
            (l) => l.actionKey === 'ai.image' && l.status === 'COMMITTED'
          )
        ).toBe(true);
        expect(await balance(ws.org.id)).toEqual({
          available: 2 * image,
          reserved: 0,
        });
      });

      it('a picture that cannot be paid for is left out and counted, the ones that can are made, the ledger is unchanged for it', async () => {
        const ws = await workspace(2 * image);
        mockDalle.mockImplementation(async (p: string) => `image of ${p}`);
        const s = state(ws, 3);

        const out: any = await graph().generatePictures(s);

        expect(out.picturesSkipped).toBe(1);
        expect(out.content.filter((c: any) => c.image)).toHaveLength(2);
        expect(out.content.filter((c: any) => !c.image)).toHaveLength(1);
        expect(mockDalle).toHaveBeenCalledTimes(2);
        expect(await ledgers(ws.accountId)).toHaveLength(2);
        expect(await balance(ws.org.id)).toEqual({ available: 0, reserved: 0 });
      });

      it('no pictures asked for: nothing is charged', async () => {
        const ws = await workspace(5 * image);

        await expect(
          graph().generatePictures(state(ws, 2, { isPicture: false }))
        ).resolves.toEqual({});

        expect(await ledgers(ws.accountId)).toHaveLength(0);
      });

      it('a provider failure leaves no committed charge', async () => {
        const ws = await workspace(5 * image);
        mockDalle.mockRejectedValue(new Error('provider down'));

        await expect(
          graph().generatePictures(state(ws, 2))
        ).rejects.toBeDefined();

        // the pictures run side by side: the first failure ends the call while the other one is
        // still being released, so wait until nothing is held any more
        await until(async () => (await balance(ws.org.id)).reserved === 0);
        expect(await balance(ws.org.id)).toEqual({
          available: 5 * image,
          reserved: 0,
        });
        expect(
          (await ledgers(ws.accountId)).every((l) => l.status === 'RELEASED')
        ).toBe(true);
      });
    });

    describe('autopost (AutopostService)', () => {
      const service = () =>
        new AutopostService(
          {} as any,
          {} as any,
          {} as any,
          {} as any,
          wired().ai
        );
      const itemKey = (id: string, url: string, part: string) =>
        `ai:autopost:${id}:${createHash('sha1')
          .update(url)
          .digest('hex')}:${part}`;
      const state = (ws: { org: any }, extra: Record<string, unknown> = {}) => {
        const id = randomUUID();
        return {
          id,
          messages: [],
          integrations: [],
          image: '',
          description: 'a short post',
          body: {
            organizationId: ws.org.id,
            generateContent: true,
            addPicture: true,
          },
          load: {
            date: '',
            url: `https://feed.test/${id}`,
            description: 'the feed item',
          },
          ...extra,
        } as any;
      };

      it("the generated post is one ai.text on the autopost's workspace, keyed by the autopost and the feed item", async () => {
        const ws = await workspace(5 * text);
        mockModel.mockResolvedValue({ socialMediaPostContent: 'generated' });
        const s = state(ws);

        const out: any = await service().generateDescription(s);

        expect(out.description).toBe('generated');
        const [ledger] = await ledgers(ws.accountId);
        expect(ledger).toMatchObject({
          idempotencyKey: itemKey(s.id, s.load.url, 'text'),
          actionKey: 'ai.text',
          status: 'COMMITTED',
          organizationId: ws.org.id,
          metadata: { kind: 'text', route: 'autopost' },
        });
      });

      it('a run retried for the same feed item never charges it twice', async () => {
        const ws = await workspace(5 * text);
        mockModel.mockResolvedValue({ socialMediaPostContent: 'generated' });
        const s = state(ws);

        await service().generateDescription(s);
        await service().generateDescription(s);

        expect(await ledgers(ws.accountId)).toHaveLength(1);
        expect(await balance(ws.org.id)).toEqual({
          available: 4 * text,
          reserved: 0,
        });
      });

      it('a feed item that cannot be paid for is a 402 and nothing is generated or charged', async () => {
        const ws = await workspace(0);
        const s = state(ws);

        const err = await service()
          .generateDescription(s)
          .catch((e) => e);

        expect(err.getStatus()).toBe(402);
        expect(mockModel).not.toHaveBeenCalled();
        expect(await ledgers(ws.accountId)).toHaveLength(0);
      });

      it('an autopost that only posts the feed text calls no provider and is not charged', async () => {
        const ws = await workspace(0);
        const s = state(ws, {
          body: {
            organizationId: ws.org.id,
            generateContent: false,
            content: 'as is',
          },
        });

        const out: any = await service().generateDescription(s);

        expect(out.description).toBe('as is');
        expect(await ledgers(ws.accountId)).toHaveLength(0);
      });

      it('the picture is one ai.image, keyed by the autopost and the feed item, on top of the text', async () => {
        const ws = await workspace(5 * image);
        mockModel.mockResolvedValue({
          generatedTextToBeSentToDallE: 'a prompt',
        });
        mockDalle.mockResolvedValue('https://images.test/1.png');
        const s = state(ws);

        const out: any = await service().generatePicture(s);

        expect(out.image).toBe('https://images.test/1.png');
        expect(mockDalle).toHaveBeenCalledWith('a prompt');
        const [ledger] = await ledgers(ws.accountId);
        expect(ledger).toMatchObject({
          idempotencyKey: itemKey(s.id, s.load.url, 'image'),
          actionKey: 'ai.image',
          status: 'COMMITTED',
          organizationId: ws.org.id,
        });
      });

      it('a picture that cannot be paid for is a 402 with the text already paid for kept, and nothing is generated for it', async () => {
        const ws = await workspace(text);
        mockModel.mockResolvedValueOnce({
          socialMediaPostContent: 'generated',
        });
        const s = state(ws);
        await service().generateDescription(s);

        const err = await service()
          .generatePicture(s)
          .catch((e) => e);

        expect(err.getStatus()).toBe(402);
        expect(mockDalle).not.toHaveBeenCalled();
        const held = await ledgers(ws.accountId);
        expect(held).toHaveLength(1);
        expect(held[0]).toMatchObject({
          actionKey: 'ai.text',
          status: 'COMMITTED',
        });
      });

      it('a provider failure leaves no committed charge', async () => {
        const ws = await workspace(5 * image);
        mockModel.mockResolvedValue({
          generatedTextToBeSentToDallE: 'a prompt',
        });
        mockDalle.mockRejectedValue(new Error('provider down'));

        await expect(
          service().generatePicture(state(ws))
        ).rejects.toBeDefined();

        expect(await balance(ws.org.id)).toEqual({
          available: 5 * image,
          reserved: 0,
        });
      });
    });
  });

  describe('autopost activity', () => {
    it('a 402 from the run is the non-retryable insufficient_credits failure', async () => {
      const activity = new AutopostActivity({
        startAutopost: async () => {
          throw new HttpException('This needs 1 credits and you have 0.', 402);
        },
      } as any);

      const err = await activity.autoPost('autopost-1').catch((e) => e);

      expect(err).toMatchObject({
        type: 'insufficient_credits',
        nonRetryable: true,
        message: 'This needs 1 credits and you have 0.',
      });
    });

    it('any other failure keeps its own error and stays retryable', async () => {
      const boom = new Error('network');
      const activity = new AutopostActivity({
        startAutopost: async () => {
          throw boom;
        },
      } as any);

      await expect(activity.autoPost('autopost-1')).rejects.toBe(boom);
    });
  });
});
