// api.scoped-keys: MCP authenticates through the key service and accepts only a key
// holding every scope. Runs the real `startMcp` (its auth routes) in a real Nest app against a real
// Postgres and the real key service. Only what sits behind authentication is a stand-in: the MCP
// protocol server (`@mastra/mcp`), the agent and its tools, and the OAuth-app lookup of `pos_` tokens.
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import {
  PrismaRepository,
  PrismaService,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ApiKeysRepository } from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.repository';
import {
  API_SCOPES,
  ApiKeysService,
  ApiScope,
} from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { OrganizationRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';
import { MastraService } from '@gitroom/nestjs-libraries/chat/mastra.service';
import { LoadToolsService } from '@gitroom/nestjs-libraries/chat/load.tools.service';
import { startMcp } from '@gitroom/nestjs-libraries/chat/start.mcp';

// Modules that pull ESM-only packages ts-jest cannot load; nothing here calls them
jest.mock('file-type', () => ({}));
jest.mock('@gitroom/nestjs-libraries/chat/mastra.service', () => ({
  MastraService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/chat/load.tools.service', () => ({
  LoadToolsService: class {},
}));
// The MCP protocol server: answers 200 naming the workspace the tools would act in (the one the
// request context holds), which proves it was reached
jest.mock('@mastra/mcp', () => {
  const { getAuth } = jest.requireActual(
    '@gitroom/nestjs-libraries/chat/async.storage'
  );
  // Answers as the protocol server would once a request got past authentication.
  const reached = ({ res }: any) => {
    res.status(200).json({ reached: true, orgId: getAuth()?.id ?? null });
  };
  return {
    MCPServer: class {
      // Handles a streamable-HTTP MCP request.
      startHTTP = async (options: any) => reached(options);
      // Handles an SSE or message MCP request.
      startSSE = async (options: any) => reached(options);
    },
  };
});

const url = process.env.TEST_DATABASE_URL;
const apiUrl = process.env.TEST_DATABASE_API_URL;
const describeDb = url && apiUrl ? describe : describe.skip;

// The organization a `pos_` token names, set per test; the stand-in `OAuthService` answers with it.
const oauth: { token?: string; organization?: any } = {};

// A module with nothing in it, so the app exists to host the MCP routes.
@Controller('/health')
class HealthController {
  // Answers that the app is up.
  @Get()
  health() {
    return { ok: true };
  }
}

describeDb('api.scoped-keys: MCP (Postgres)', () => {
  let worker: PrismaClient;
  let apiPrisma: PrismaService;
  let apiKeys: ApiKeysService;
  let app: any;
  let base: string;
  const saved: Record<string, string | undefined> = {};
  const envNames = ['DATABASE_URL', 'NEXT_PUBLIC_BACKEND_URL', 'FRONTEND_URL'];

  beforeAll(async () => {
    for (const name of envNames) {
      saved[name] = process.env[name];
    }
    process.env.DATABASE_URL = apiUrl;
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:3000';
    process.env.FRONTEND_URL = 'http://localhost:4200';
    apiPrisma = new PrismaService();
    await apiPrisma.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    const repo = new PrismaRepository<any>(apiPrisma);
    const organizations = new OrganizationService(
      new OrganizationRepository(repo, repo, repo),
      {
        // The email provider stand-in: none is configured.
        hasEmailProvider: () => false,
      } as any,
      new AccountsService(new AccountsRepository(repo, repo, repo))
    );
    apiKeys = new ApiKeysService(new ApiKeysRepository(repo));

    @Module({
      controllers: [HealthController],
      providers: [
        {
          provide: MastraService,
          useValue: {
            // The agent runtime, with an agent that has no tools.
            mastra: async () => ({
              // The agent with no tools.
              getAgent: () => ({
                // Lists no tools.
                listTools: async () => ({}),
              }),
            }),
          },
        },
        {
          provide: LoadToolsService,
          useValue: {
            // No MCP-only tools.
            loadTools: async () => ({}),
          },
        },
        { provide: OrganizationService, useValue: organizations },
        { provide: ApiKeysService, useValue: apiKeys },
        {
          provide: OAuthService,
          useValue: {
            // The authorization a `pos_` token names, or null when it is not the one the test registered.
            getOrgByOAuthToken: async (token: string) =>
              token === oauth.token ? { organization: oauth.organization } : null,
          },
        },
      ],
    })
    // The Nest app MCP is mounted on, wired to the real key and workspace services.
    class AppModule {}
    app = await NestFactory.create(AppModule, { logger: false });
    await startMcp(app);
    await app.listen(0);
    base = await app.getUrl();
  });

  afterAll(async () => {
    for (const name of envNames) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    await app.close();
    await apiPrisma.$disconnect();
    await worker.$disconnect();
  });

  beforeEach(() => {
    delete oauth.token;
    delete oauth.organization;
  });

  // A workspace with one SUPERADMIN member.
  const newWorkspace = async () => {
    const user = await worker.user.create({
      data: {
        email: randomUUID() + '@test.local',
        providerName: 'LOCAL',
        password: 'x',
        activated: true,
        timezone: 0,
      },
    });
    const org = await worker.organization.create({
      data: {
        name: 'ws-' + randomUUID(),
        users: { create: { role: 'SUPERADMIN', userId: user.id } },
      },
    });
    return { userId: user.id, orgId: org.id };
  };

  // A key for the workspace with the given scopes.
  const keyFor = async (
    orgId: string,
    userId: string,
    scopes: ApiScope[] = [...API_SCOPES]
  ) => apiKeys.create(orgId, userId, { name: 'mcp-' + randomUUID(), scopes });

  // One request to the MCP routes; the answer with its parsed body.
  const call = async (route: string, authorization?: string) => {
    const res = await fetch(base + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {}),
      },
      body: '{}',
    });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: res.status, text, body };
  };

  // The scopes a key lacks to hold every scope.
  const missingFrom = (held: ApiScope[]) =>
    API_SCOPES.filter((scope) => !held.includes(scope));

  describe.each([['/sse'], ['/message']])(
    'the key in the URL (%s/:id)',
    (prefix) => {
      it('a key with every scope reaches the server, acting in its workspace', async () => {
        const { userId, orgId } = await newWorkspace();
        const key = await keyFor(orgId, userId);

        const res = await call(`${prefix}/${key.key}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ reached: true, orgId });
      });

      it('a key without some scope answers 403 SCOPE_FORBIDDEN naming the scopes it lacks', async () => {
        const { userId, orgId } = await newWorkspace();
        const held = API_SCOPES.filter((scope) => scope !== 'ai:use');
        const key = await keyFor(orgId, userId, [...held]);

        const res = await call(`${prefix}/${key.key}`);

        expect(res.status).toBe(403);
        expect(res.body).toEqual({
          statusCode: 403,
          code: 'SCOPE_FORBIDDEN',
          required: ['ai:use'],
        });
      });

      it('a read-only key is refused with every other scope listed', async () => {
        const { userId, orgId } = await newWorkspace();
        const key = await keyFor(orgId, userId, ['posts:read']);

        const res = await call(`${prefix}/${key.key}`);

        expect(res.status).toBe(403);
        expect(res.body.required).toEqual(missingFrom(['posts:read']));
      });

      it('a revoked key, an unknown key and an OAuth-app token are refused with 400', async () => {
        const { userId, orgId } = await newWorkspace();
        const key = await keyFor(orgId, userId);
        await apiKeys.revoke(orgId, key.id);
        oauth.token = 'pos_' + randomUUID();
        oauth.organization = await worker.organization.findUniqueOrThrow({
          where: { id: orgId },
        });

        for (const value of [key.key, 'nsk_aaaaaaaa_' + 'b'.repeat(32), oauth.token]) {
          const res = await call(`${prefix}/${value}`);
          expect(res.status).toBe(400);
          expect(res.text).toBe('Invalid API Key');
        }
      });

      it('a migrated legacy value, which holds every scope, still opens it', async () => {
        const { orgId } = await newWorkspace();
        const held = 'mcp-held-by-a-client-' + randomUUID();
        await worker.apiKey.create({
          data: {
            organizationId: orgId,
            name: 'Legacy key',
            prefix: 'legacy-' + orgId,
            secretHash: createHash('sha256').update(held).digest('hex'),
            scopes: [...API_SCOPES],
          },
        });

        const res = await call(`${prefix}/${held}`);

        expect(res.status).toBe(200);
        expect(res.body.orgId).toBe(orgId);
      });
    }
  );

  describe('/mcp/:id', () => {
    it('a key with every scope reaches the server, acting in its workspace', async () => {
      const { userId, orgId } = await newWorkspace();
      const key = await keyFor(orgId, userId);

      const res = await call(`/mcp/${key.key}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reached: true, orgId });
    });

    it('a narrower key answers 403 SCOPE_FORBIDDEN and an unknown key 400', async () => {
      const { userId, orgId } = await newWorkspace();
      const narrow = await keyFor(orgId, userId, ['posts:read', 'posts:write']);

      const refused = await call(`/mcp/${narrow.key}`);
      const unknown = await call('/mcp/nsk_aaaaaaaa_' + 'b'.repeat(32));

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'SCOPE_FORBIDDEN' });
      expect(unknown.status).toBe(400);
    });

    it('a revoked key is refused on its next request', async () => {
      const { userId, orgId } = await newWorkspace();
      const key = await keyFor(orgId, userId);
      expect((await call(`/mcp/${key.key}`)).status).toBe(200);
      await apiKeys.revoke(orgId, key.id);

      expect((await call(`/mcp/${key.key}`)).status).toBe(400);
    });

    it('a migrated legacy value, which holds every scope, still opens it', async () => {
      const { orgId } = await newWorkspace();
      const held = 'mcp-legacy-' + randomUUID();
      await worker.apiKey.create({
        data: {
          organizationId: orgId,
          name: 'Legacy key',
          prefix: 'legacy-' + orgId,
          secretHash: createHash('sha256').update(held).digest('hex'),
          scopes: [...API_SCOPES],
        },
      });

      const res = await call(`/mcp/${held}`);

      expect(res.status).toBe(200);
      expect(res.body.orgId).toBe(orgId);
    });
  });

  describe('the bearer routes', () => {
    it('/mcp with a Bearer key that holds every scope reaches the server', async () => {
      const { userId, orgId } = await newWorkspace();
      const key = await keyFor(orgId, userId);

      const res = await call('/mcp', `Bearer ${key.key}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reached: true, orgId });
    });

    it('/mcp with a Bearer key that lacks a scope answers 403 SCOPE_FORBIDDEN', async () => {
      const { userId, orgId } = await newWorkspace();
      const key = await keyFor(orgId, userId, ['posts:read']);

      const res = await call('/mcp', `Bearer ${key.key}`);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        statusCode: 403,
        code: 'SCOPE_FORBIDDEN',
        required: missingFrom(['posts:read']),
      });
    });

    it('/mcp answers 401 for a missing header, an unknown key and a revoked key', async () => {
      const { userId, orgId } = await newWorkspace();
      const key = await keyFor(orgId, userId);
      await apiKeys.revoke(orgId, key.id);

      expect((await call('/mcp')).status).toBe(401);
      expect((await call('/mcp', 'Bearer nsk_aaaaaaaa_' + 'b'.repeat(32))).status).toBe(401);
      expect((await call('/mcp', `Bearer ${key.key}`)).status).toBe(401);
    });

    it('/mcp still accepts an OAuth-app token', async () => {
      const { orgId } = await newWorkspace();
      oauth.token = 'pos_' + randomUUID();
      oauth.organization = await worker.organization.findUniqueOrThrow({
        where: { id: orgId },
      });

      const res = await call('/mcp', `Bearer ${oauth.token}`);

      expect(res.status).toBe(200);
      expect(res.body.orgId).toBe(orgId);
    });

    it('the OAuth-protected path takes a key the same way: all scopes pass, fewer answer 403', async () => {
      const { userId, orgId } = await newWorkspace();
      const full = await keyFor(orgId, userId);
      const narrow = await keyFor(orgId, userId, ['posts:read']);

      const passed = await call('/mcp-oauth-dynamic', `Bearer ${full.key}`);
      const refused = await call('/mcp-oauth-dynamic', `Bearer ${narrow.key}`);

      expect(passed.status).toBe(200);
      expect(passed.body.orgId).toBe(orgId);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'SCOPE_FORBIDDEN' });
    });
  });
});
