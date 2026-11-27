// api.scoped-keys: a key over HTTP. Runs the real `PublicAuthMiddleware`, `ScopeGuard`,
// `ApiKeysController`, key service, failed-attempt limiter, token service, `AuthMiddleware` and
// idempotency middleware in a real Nest app against a real Postgres and a real Redis, on the API
// role as the backend runs; the real `EnterpriseController` is called directly. Only `OAuthService`
// (the one call the `pos_` branch makes) and the enterprise controller's channel services, which are
// upstream code, are stand-ins.
import {
  Body,
  Controller,
  Get,
  MiddlewareConsumer,
  Module,
  NestModule,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { DeviceSessionsRepository } from '@gitroom/nestjs-libraries/database/prisma/device-sessions/device.sessions.repository';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { OrganizationRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersRepository } from '@gitroom/nestjs-libraries/database/prisma/users/users.repository';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';
import { IdempotencyRepository } from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.repository';
import { IdempotencyService } from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.service';
import { ApiKeysRepository } from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.repository';
import {
  API_SCOPES,
  ApiKeysService,
  ApiScope,
} from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.service';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { HttpExceptionFilter } from '@gitroom/nestjs-libraries/services/exception.filter';
import { AuthTokenController } from '@gitroom/backend/api/routes/auth.token.controller';
import { WebHandoffService } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.service';
import { EmailOtpService } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.service';
import { ApiKeysController } from '@gitroom/backend/api/routes/api-keys.controller';
import { EnterpriseController } from '@gitroom/backend/api/routes/enterprise.controller';
import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';
import { PublicAuthMiddleware } from '@gitroom/backend/services/auth/public.auth.middleware';
import { IdempotencyMiddleware } from '@gitroom/backend/services/idempotency/idempotency.middleware';
import { RequireScope } from '@gitroom/backend/services/auth/scopes/require.scope';
import { ScopeGuard } from '@gitroom/backend/services/auth/scopes/scope.guard';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';
import { TokenGrantsService } from '@gitroom/backend/services/auth/tokens/token.grants.service';
import { AuthAttemptLimiter } from '@gitroom/backend/services/auth/tokens/auth.attempt.limiter';

// Modules that pull ESM-only packages ts-jest cannot load; nothing here calls them
jest.mock('file-type', () => ({}));
jest.mock('@gitroom/nestjs-libraries/chat/mastra.service', () => ({
  MastraService: class {},
}));
// The enterprise controller's channel services are replaced by the stand-ins below; their real
// modules pull in the channel providers
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);
// The limiter and the enterprise state live in a real Redis, the one the test run is given
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => {
  const { Redis } = jest.requireActual('ioredis');
  return {
    ioRedis: process.env.TEST_REDIS_URL
      ? new Redis(process.env.TEST_REDIS_URL)
      : {},
  };
});

const url = process.env.TEST_DATABASE_URL;
const describeDb = url && process.env.TEST_REDIS_URL ? describe : describe.skip;

// The organization a `pos_` token names, set per test; the stand-in `OAuthService` answers with it.
const oauth: { token?: string; organization?: any } = {};

// Stands in for `OAuthService`: answers `getOrgByOAuthToken` as declared, `null` for an unknown token.
class StubOAuthService {
  // The authorization a `pos_` token names, or null when it is not the one the test registered.
  async getOrgByOAuthToken(token: string) {
    return token === oauth.token ? { organization: oauth.organization } : null;
  }
}

// How many times the handler named by `x-probe` has run, reset before every test.
const runs = new Map<string, number>();

// What the public middleware set on the request.
const principalOf = (req: any) => ({
  orgId: req.org?.id,
  role: req.org?.users?.[0]?.role ?? req.org?.users?.[0]?.users?.role,
  authOrgId: req.authOrgId,
  isOAuthApp: req.isOAuthApp,
  userId: req.user?.id ?? null,
  apiKeyId: req.apiKeyId ?? null,
  scopes: req.apiKeyScopes ?? null,
});

// Public routes of every scope, as the real controller declares them, plus one that names none.
@Controller('/public/v1')
@UseGuards(ScopeGuard)
class PublicProbeController {
  // A route that needs `posts:read`.
  @Get('posts')
  @RequireScope('posts:read')
  readPosts(@Req() req: any) {
    return principalOf(req);
  }

  // A route that needs `posts:write`, counting its runs.
  @Post('posts')
  @RequireScope('posts:write')
  writePosts(@Req() req: any, @Body() body: unknown) {
    const name = `${req.org.id}:${String(req.headers['x-probe'])}`;
    const n = (runs.get(name) ?? 0) + 1;
    runs.set(name, n);
    return { n, ...principalOf(req) };
  }

  // A route that needs `media:write`.
  @Post('upload')
  @RequireScope('media:write')
  upload(@Req() req: any) {
    return principalOf(req);
  }

  // A route that needs `channels:read`.
  @Get('integrations')
  @RequireScope('channels:read')
  integrations(@Req() req: any) {
    return principalOf(req);
  }

  // A route that needs `channels:write`.
  @Post('integration-trigger')
  @RequireScope('channels:write')
  trigger(@Req() req: any) {
    return principalOf(req);
  }

  // A route that needs `ai:use`.
  @Post('generate-video')
  @RequireScope('ai:use')
  video(@Req() req: any) {
    return principalOf(req);
  }

  // A route that needs `account:read`.
  @Get('notifications')
  @RequireScope('account:read')
  notifications(@Req() req: any) {
    return principalOf(req);
  }

  // A route nobody gave a scope: a key must never reach it.
  @Get('unscoped')
  unscoped(@Req() req: any) {
    return principalOf(req);
  }
}

// The app's own route, behind `AuthMiddleware`, to watch that it does not touch the legacy key.
@Controller('/probe')
class AppProbeController {
  // The workspace `AuthMiddleware` resolved for the request.
  @Get('me')
  me(@Req() req: any) {
    return { orgId: req.org?.id };
  }
}

// Whether a route's handler ran: GET routes answer 200 and POST routes 201.
const reached = (status: number) => status === 200 || status === 201;

// The scope each probe route needs, for the matrix test.
const routes: { method: string; path: string; scope: ApiScope }[] = [
  { method: 'GET', path: '/public/v1/posts', scope: 'posts:read' },
  { method: 'POST', path: '/public/v1/posts', scope: 'posts:write' },
  { method: 'POST', path: '/public/v1/upload', scope: 'media:write' },
  { method: 'GET', path: '/public/v1/integrations', scope: 'channels:read' },
  {
    method: 'POST',
    path: '/public/v1/integration-trigger',
    scope: 'channels:write',
  },
  { method: 'POST', path: '/public/v1/generate-video', scope: 'ai:use' },
  { method: 'GET', path: '/public/v1/notifications', scope: 'account:read' },
];

describeDb('api.scoped-keys over HTTP (Postgres, Redis)', () => {
  let worker: PrismaClient;
  let apiPrisma: PrismaService;
  let apiKeys: ApiKeysService;
  let organizations: OrganizationService;
  let redis: any;
  let app: any;
  let base: string;
  const saved: Record<string, string | undefined> = {};
  const envNames = [
    'DATABASE_URL',
    'JWT_SECRET',
    'FRONTEND_URL',
    'NOT_SECURED',
    'NEXT_PUBLIC_BACKEND_URL',
    'REDIS_URL',
    'YOUTUBE_CLIENT_ID',
    'AUTH_FAIL_LIMIT',
    'AUTH_FAIL_WINDOW_SECONDS',
  ];

  beforeAll(async () => {
    for (const name of envNames) {
      saved[name] = process.env[name];
    }
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    process.env.JWT_SECRET = 'scoped-keys-spec-secret';
    process.env.FRONTEND_URL = 'http://localhost:4200';
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    process.env.YOUTUBE_CLIENT_ID = 'scoped-keys-spec-client';
    // empty, not deleted: Prisma loads the root .env into any variable that is unset
    process.env.NOT_SECURED = '';
    process.env.NEXT_PUBLIC_BACKEND_URL = '';
    apiPrisma = new PrismaService();
    await apiPrisma.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    redis = (await import('@gitroom/nestjs-libraries/redis/redis.service'))
      .ioRedis;

    const repo = new PrismaRepository<any>(apiPrisma);
    const organizationRepository = new OrganizationRepository(repo, repo, repo);
    const notifications = {
      // Reports no email provider.
      hasEmailProvider: () => false,
    } as any;
    organizations = new OrganizationService(
      organizationRepository,
      notifications,
      new AccountsService(new AccountsRepository(repo, repo, repo))
    );
    apiKeys = new ApiKeysService(new ApiKeysRepository(repo));
    const users = new UsersService(
      new UsersRepository(repo, new PrismaTransaction(apiPrisma)),
      organizationRepository,
      {} as any,
      notifications
    );

    // The app under test: the token and key controllers, the probe routes and the real middlewares.
    @Module({
      controllers: [
        AuthTokenController,
        ApiKeysController,
        PublicProbeController,
        AppProbeController,
      ],
      providers: [
        TokenService,
        TokenGrantsService,
        AuthAttemptLimiter,
        AuthMiddleware,
        // the email_otp grant is not under test here: the controller only needs the service to be built
        { provide: EmailOtpService, useValue: {} },
        { provide: WebHandoffService, useValue: {} },
        PublicAuthMiddleware,
        IdempotencyMiddleware,
        {
          provide: DeviceSessionsRepository,
          useValue: new DeviceSessionsRepository(repo),
        },
        {
          provide: IdempotencyService,
          useValue: new IdempotencyService(new IdempotencyRepository(repo)),
        },
        { provide: UsersService, useValue: users },
        { provide: OrganizationService, useValue: organizations },
        { provide: ApiKeysService, useValue: apiKeys },
        { provide: OAuthService, useClass: StubOAuthService },
      ],
    })
    class AppModule implements NestModule {
      // Puts the public middlewares on the public routes and `AuthMiddleware` on the app's own routes.
      configure(consumer: MiddlewareConsumer) {
        consumer
          .apply(PublicAuthMiddleware, IdempotencyMiddleware)
          .forRoutes(PublicProbeController);
        consumer
          .apply(AuthMiddleware, IdempotencyMiddleware)
          .forRoutes(ApiKeysController, AppProbeController);
      }
    }
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
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
    await redis.quit();
  });

  beforeEach(() => {
    runs.clear();
    delete oauth.token;
    delete oauth.organization;
  });

  afterEach(() => {
    delete process.env.AUTH_FAIL_LIMIT;
    delete process.env.AUTH_FAIL_WINDOW_SECONDS;
  });

  const password = 'correct-horse-' + randomUUID();
  // A client address of its own, so the limiter's counts never leak between tests
  const address = () =>
    `10.${Math.floor(Math.random() * 250)}.${Math.floor(
      Math.random() * 250
    )}.${Math.floor(Math.random() * 250)}`;

  // An activated email-and-password user who is the SUPERADMIN of a workspace of their own.
  const newUser = async () => {
    const user = await worker.user.create({
      data: {
        email: randomUUID() + '@test.local',
        providerName: 'LOCAL',
        password: AuthService.hashPassword(password),
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
    return { user, orgId: org.id };
  };

  // Makes the user a member of a new workspace with the given role.
  const joinWorkspace = async (userId: string, role: 'ADMIN' | 'USER') => {
    const org = await worker.organization.create({
      data: {
        name: 'ws-' + randomUUID(),
        users: { create: { role, userId } },
      },
    });
    return org.id;
  };

  // One request to the app from an address; the answer with its parsed body.
  const call = async (
    method: string,
    route: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      ip?: string;
    } = {}
  ) => {
    const res = await fetch(base + route, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': options.ip ?? address(),
        ...options.headers,
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text,
      body: text ? JSON.parse(text) : undefined,
    };
  };

  // A public API call carrying `Authorization` and any extra headers.
  const publicCall = (
    authorization: string | undefined,
    headers: Record<string, string> = {},
    ip?: string,
    route = '/public/v1/posts',
    method = 'GET'
  ) =>
    call(method, route, {
      ip,
      body: method === 'GET' ? undefined : {},
      headers: {
        ...(authorization === undefined ? {} : { authorization }),
        ...headers,
      },
    });

  // A key for the workspace with the given scopes.
  const keyFor = async (
    orgId: string,
    userId: string,
    scopes: ApiScope[] = [...API_SCOPES]
  ) => apiKeys.create(orgId, userId, { name: 'k-' + randomUUID(), scopes });

  // Opens a session for the user as a sign-in does (`TokenService.issue`), and returns the Bearer header value.
  const bearerFor = async (user: { id: string }) =>
    `Bearer ${
      (
        await app
          .get(TokenService)
          .issue(user.id, { name: 'Pixel', ip: address() })
      ).access_token
    }`;

  // A call to the key routes as the signed-in user in the given workspace.
  const manage = (
    bearer: string,
    method: string,
    route: string,
    workspaceId: string,
    options: { body?: unknown; headers?: Record<string, string> } = {}
  ) =>
    call(method, route, {
      body: options.body,
      headers: {
        authorization: bearer,
        'x-workspace-id': workspaceId,
        ...options.headers,
      },
    });

  // The failed attempts the shared counter holds for an address and a kind of attempt.
  const failures = (ip: string, kind: string) =>
    redis
      .get(`auth:fail:${kind}:${ip}`)
      .then((value: string | null) => Number(value ?? 0));

  describe('a key authenticates', () => {
    it('its workspace, acting as the forced SUPERADMIN of a key, with its id and scopes on the request', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id, ['posts:read']);

      const res = await publicCall(key.key);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        orgId,
        authOrgId: orgId,
        role: 'SUPERADMIN',
        isOAuthApp: false,
        userId: null,
        apiKeyId: key.id,
        scopes: ['posts:read'],
      });
    });

    it('only when sent as the bare Authorization value: a Bearer-prefixed key is a device token and fails as one', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id);

      const res = await publicCall(`Bearer ${key.key}`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid API key' });
    });

    it('a key of workspace X acts in X and never in Y, whatever the request names', async () => {
      const x = await newUser();
      const y = await newUser();
      const keyX = await keyFor(x.orgId, x.user.id);

      const plain = await publicCall(keyX.key);
      const own = await publicCall(keyX.key, { 'x-workspace-id': x.orgId });
      const other = await publicCall(keyX.key, { 'x-workspace-id': y.orgId });
      const missing = await publicCall(keyX.key, {
        'x-workspace-id': randomUUID(),
      });

      expect(plain.body.orgId).toBe(x.orgId);
      expect(own.status).toBe(200);
      expect(own.body.orgId).toBe(x.orgId);
      for (const refused of [other, missing]) {
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({
          statusCode: 403,
          code: 'WORKSPACE_FORBIDDEN',
        });
        expect(refused.text).not.toContain(y.orgId);
      }
    });

    it('x-postiz-org is refused with 403 WORKSPACE_FORBIDDEN, even naming its own workspace, and switches nothing', async () => {
      const first = await newUser();
      await worker.user.update({
        where: { id: first.user.id },
        data: { isSuperAdmin: true },
      });
      const second = await newUser();
      const key = await keyFor(first.orgId, first.user.id);

      for (const target of [second.orgId, first.orgId, randomUUID()]) {
        const res = await publicCall(key.key, { 'x-postiz-org': target });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
      }
    });

    it('an unauthenticated caller learns nothing from x-postiz-org: a wrong key still answers 401', async () => {
      const res = await publicCall(
        `nsk_${'a'.repeat(8)}_${'b'.repeat(32)}`,
        { 'x-postiz-org': randomUUID() }
      );

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid API key' });
    });

    it('a workspace deleted after the key was made refuses it', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id);
      await worker.organization.update({
        where: { id: orgId },
        data: { deletedAt: new Date() },
      });

      const res = await publicCall(key.key);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid API key' });
    });

    it('no Authorization header answers 401 No API Key found', async () => {
      const res = await publicCall(undefined);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'No API Key found' });
    });
  });

  describe('a key works only for its scopes', () => {
    it.each(API_SCOPES)(
      'a key with only %s reaches the routes of that scope and is refused on every other',
      async (scope) => {
        const { user, orgId } = await newUser();
        const key = await keyFor(orgId, user.id, [scope]);

        for (const route of routes) {
          const res = await publicCall(
            key.key,
            {},
            undefined,
            route.path,
            route.method
          );
          if (route.scope === scope) {
            expect(reached(res.status)).toBe(true);
          } else {
            expect(res.status).toBe(403);
            expect(res.body).toEqual({
              statusCode: 403,
              code: 'SCOPE_FORBIDDEN',
              required: route.scope,
            });
          }
        }
      }
    );

    it('a key with every scope reaches every route', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id);

      for (const route of routes) {
        const res = await publicCall(
          key.key,
          {},
          undefined,
          route.path,
          route.method
        );
        expect(reached(res.status)).toBe(true);
      }
    });

    it('a route that names no scope is refused to a key, so a new route is closed by default', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id);

      const res = await publicCall(key.key, {}, undefined, '/public/v1/unscoped');

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'SCOPE_FORBIDDEN' });
    });

    it('a refused scope never runs the handler', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id, ['posts:read']);

      const res = await publicCall(
        key.key,
        { 'x-probe': 'refused' },
        undefined,
        '/public/v1/posts',
        'POST'
      );

      expect(res.status).toBe(403);
      expect(runs.size).toBe(0);
    });
  });

  describe('the other credentials keep working', () => {
    it('a device Bearer access token passes every scope check and acts with the user real role', async () => {
      const { user, orgId } = await newUser();
      const bearer = await bearerFor(user);

      for (const route of [
        ...routes,
        { method: 'GET', path: '/public/v1/unscoped', scope: 'posts:read' },
      ]) {
        const res = await publicCall(bearer, {}, undefined, route.path, route.method);
        expect(reached(res.status)).toBe(true);
        expect(res.body).toMatchObject({
          orgId,
          userId: user.id,
          role: 'SUPERADMIN',
          scopes: null,
          apiKeyId: null,
        });
      }
    });

    it('a pos_ OAuth-app token passes the scope checks as before and still refuses x-postiz-org', async () => {
      const { orgId } = await newUser();
      oauth.token = 'pos_' + randomUUID();
      oauth.organization = await worker.organization.findUniqueOrThrow({
        where: { id: orgId },
      });

      const read = await publicCall(oauth.token);
      const write = await publicCall(oauth.token, {}, undefined, '/public/v1/posts', 'POST');
      const switched = await publicCall(oauth.token, { 'x-postiz-org': orgId });

      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ orgId, isOAuthApp: true, scopes: null });
      expect(reached(write.status)).toBe(true);
      expect(switched.status).toBe(403);
      expect(switched.body).toEqual({ msg: 'Unauthorized' });
    });

    it('an unknown pos_ token answers 401 Invalid OAuth token', async () => {
      const res = await publicCall('pos_unknown');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid OAuth token' });
    });
  });

  describe('revoking', () => {
    it('a revoked key gets 401 on its next request, with the same body as an unknown or malformed key', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id);
      expect((await publicCall(key.key)).status).toBe(200);
      await apiKeys.revoke(orgId, key.id);

      const revoked = await publicCall(key.key);
      const unknown = await publicCall(`nsk_${'a'.repeat(8)}_${'b'.repeat(32)}`);
      const malformed = await publicCall('not-a-key');

      for (const res of [revoked, unknown, malformed]) {
        expect(res.status).toBe(401);
        expect(res.text).toBe(revoked.text);
      }
      expect(revoked.body).toEqual({ msg: 'Invalid API key' });
    });

    it('revoking one key leaves the workspace other keys working', async () => {
      const { user, orgId } = await newUser();
      const a = await keyFor(orgId, user.id);
      const b = await keyFor(orgId, user.id);

      await apiKeys.revoke(orgId, a.id);

      expect((await publicCall(a.key)).status).toBe(401);
      expect((await publicCall(b.key)).status).toBe(200);
    });
  });

  describe('keys that existed before the change', () => {
    // The statements of the migration's data part.
    const dataStatements = () => {
      const sql = fs.readFileSync(
        path.resolve(
          __dirname,
          '../migrations/20261009120000_api_key/migration.sql'
        ),
        'utf8'
      );
      return sql
        .slice(sql.indexOf('-- LegacyKeys'))
        .split('\n')
        .filter((line) => !line.startsWith('--'))
        .join('\n')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
    };

    it('the value a client held authenticates the same workspace with every scope after the migration, and acts like any key', async () => {
      const { orgId } = await newUser();
      const held = 'held-by-a-client-' + randomUUID();
      await worker.organization.update({
        where: { id: orgId },
        data: { apiKey: held },
      });
      await worker.$transaction(
        dataStatements().map((statement) => worker.$executeRawUnsafe(statement))
      );

      for (const route of routes) {
        const res = await publicCall(held, {}, undefined, route.path, route.method);
        expect(reached(res.status)).toBe(true);
        expect(res.body.orgId).toBe(orgId);
      }
      const switched = await publicCall(held, { 'x-postiz-org': orgId });
      expect(switched.status).toBe(403);
      expect(switched.body).toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
    });

    it('a value left in the legacy column and never migrated no longer authenticates', async () => {
      const { orgId } = await newUser();
      const held = 'never-migrated-' + randomUUID();
      await worker.organization.update({
        where: { id: orgId },
        data: { apiKey: held },
      });

      const res = await publicCall(held);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid API key' });
    });

    it('the authentication middleware no longer fills an empty legacy column', async () => {
      const { user, orgId } = await newUser();
      const bearer = await bearerFor(user);

      const res = await call('GET', '/probe/me', {
        headers: { authorization: bearer, 'x-workspace-id': orgId },
      });

      expect(res.status).toBe(200);
      const org = await worker.organization.findUniqueOrThrow({ where: { id: orgId } });
      expect(org.apiKey).toBeNull();
    });
  });

  describe('the failed-attempt limit', () => {
    it('a wrong key and a malformed key each record an api_key failure for the address', async () => {
      const ip = address();

      await publicCall(`nsk_${'a'.repeat(8)}_${'b'.repeat(32)}`, {}, ip);
      await publicCall('not-a-key', {}, ip);

      expect(await failures(ip, 'api_key')).toBe(2);
    });

    it('a valid key records no failure', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id);
      const ip = address();

      await publicCall(key.key, {}, ip);
      await publicCall(key.key, {}, ip);

      expect(await failures(ip, 'api_key')).toBe(0);
    });

    it('a key refused for its scope or workspace is not a guess and records no failure', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id, ['posts:read']);
      const ip = address();

      await publicCall(key.key, {}, ip, '/public/v1/upload', 'POST');
      await publicCall(key.key, { 'x-workspace-id': randomUUID() }, ip);

      expect(await failures(ip, 'api_key')).toBe(0);
    });

    it('wrong keys over the limit lock the address: the next call answers 429 with Retry-After, even for a good key', async () => {
      process.env.AUTH_FAIL_LIMIT = '3';
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id);
      const ip = address();

      for (let i = 0; i < 3; i += 1) {
        expect((await publicCall(`wrong-${i}`, {}, ip)).status).toBe(401);
      }
      const locked = await publicCall(key.key, {}, ip);
      const elsewhere = await publicCall(key.key, {}, address());

      expect(locked.status).toBe(429);
      expect(locked.body).toMatchObject({ statusCode: 429, code: 'AUTH_RATE_LIMITED' });
      expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(elsewhere.status).toBe(200);
    });

    it('a locked address is refused before any lookup, so the answer cannot tell whether a key is right', async () => {
      process.env.AUTH_FAIL_LIMIT = '2';
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id);
      const ip = address();
      await publicCall('wrong-1', {}, ip);
      await publicCall('wrong-2', {}, ip);

      const good = await publicCall(key.key, {}, ip);
      const bad = await publicCall('wrong-3', {}, ip);

      expect(good.status).toBe(429);
      expect(bad.status).toBe(429);
      expect(good.text).toBe(bad.text);
    });

    it('parallel wrong keys from one address cannot all pass the check before the first is counted', async () => {
      process.env.AUTH_FAIL_LIMIT = '3';
      const ip = address();

      const answers = await Promise.all(
        Array.from({ length: 12 }, (_, i) => publicCall(`parallel-${i}`, {}, ip))
      );

      expect(answers.filter((a) => a.status === 401)).toHaveLength(3);
      expect(answers.filter((a) => a.status === 429)).toHaveLength(9);
    });
  });

  describe('idempotency for a key principal', () => {
    it('the same Idempotency-Key sent twice with one key runs the handler once and replays the answer', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id);
      const headers = { 'x-probe': 'p1', 'idempotency-key': 'k-' + randomUUID() };

      const first = await publicCall(key.key, headers, undefined, '/public/v1/posts', 'POST');
      const second = await publicCall(key.key, headers, undefined, '/public/v1/posts', 'POST');

      expect(first.body.n).toBe(1);
      expect(second.body.n).toBe(1);
      expect(runs.get(`${orgId}:p1`)).toBe(1);
    });
  });

  describe('POST /workspace-keys, GET /workspace-keys, DELETE /workspace-keys/:id', () => {
    it('create answers 201 with the view and the key, which then authenticates; list shows it without a secret', async () => {
      const { user, orgId } = await newUser();
      const bearer = await bearerFor(user);

      const created = await manage(bearer, 'POST', '/workspace-keys', orgId, {
        body: { name: 'Zapier', scopes: ['posts:read', 'posts:write'] },
      });
      const listed = await manage(bearer, 'GET', '/workspace-keys', orgId);

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: 'Zapier',
        scopes: ['posts:read', 'posts:write'],
        revokedAt: null,
        lastUsedAt: null,
      });
      expect(created.body.key).toMatch(/^nsk_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/);
      expect((await publicCall(created.body.key)).body.orgId).toBe(orgId);
      expect(listed.status).toBe(200);
      expect(listed.body.map((k: any) => k.id)).toEqual([created.body.id]);
      expect(listed.text).not.toContain(created.body.key.split('_')[2]);
    });

    it('delete answers 204 and the key stops working on its next request', async () => {
      const { user, orgId } = await newUser();
      const bearer = await bearerFor(user);
      const created = await manage(bearer, 'POST', '/workspace-keys', orgId, {
        body: { name: 'Zapier', scopes: ['posts:read'] },
      });
      expect((await publicCall(created.body.key)).status).toBe(200);

      const deleted = await manage(
        bearer,
        'DELETE',
        `/workspace-keys/${created.body.id}`,
        orgId
      );

      expect(deleted.status).toBe(204);
      expect((await publicCall(created.body.key)).status).toBe(401);
      const listed = await manage(bearer, 'GET', '/workspace-keys', orgId);
      expect(listed.body[0].revokedAt).not.toBeNull();
    });

    it('only an ADMIN or SUPERADMIN of the workspace manages keys; a USER gets 403 on all three routes', async () => {
      const { user } = await newUser();
      const memberOf = await joinWorkspace(user.id, 'USER');
      const adminOf = await joinWorkspace(user.id, 'ADMIN');
      const bearer = await bearerFor(user);
      const existing = await keyFor(memberOf, user.id);

      const create = await manage(bearer, 'POST', '/workspace-keys', memberOf, {
        body: { name: 'k', scopes: ['posts:read'] },
      });
      const list = await manage(bearer, 'GET', '/workspace-keys', memberOf);
      const revoke = await manage(bearer, 'DELETE', `/workspace-keys/${existing.id}`, memberOf);
      const admin = await manage(bearer, 'POST', '/workspace-keys', adminOf, {
        body: { name: 'k', scopes: ['posts:read'] },
      });

      for (const res of [create, list, revoke]) {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'ADMIN_REQUIRED' });
      }
      expect(await worker.apiKey.count({ where: { organizationId: memberOf } })).toBe(1);
      expect((await publicCall(existing.key)).status).toBe(200);
      expect(admin.status).toBe(201);
    });

    it('answers 400 for a bad body and stores nothing', async () => {
      const { user, orgId } = await newUser();
      const bearer = await bearerFor(user);

      for (const body of [
        { name: '', scopes: ['posts:read'] },
        { name: 'x'.repeat(61), scopes: ['posts:read'] },
        { name: 'k', scopes: [] },
        { name: 'k', scopes: ['posts:read', 'root'] },
        { name: 'k' },
        { scopes: ['posts:read'] },
      ]) {
        const res = await manage(bearer, 'POST', '/workspace-keys', orgId, { body });
        expect(res.status).toBe(400);
      }
      expect(await worker.apiKey.count({ where: { organizationId: orgId } })).toBe(0);
    });

    it("keys are the calling workspace's: another workspace's list and key are out of reach", async () => {
      const { user, orgId } = await newUser();
      const second = await joinWorkspace(user.id, 'ADMIN');
      const bearer = await bearerFor(user);
      const inFirst = await keyFor(orgId, user.id);
      const inSecond = await keyFor(second, user.id);

      const listFirst = await manage(bearer, 'GET', '/workspace-keys', orgId);
      const listSecond = await manage(bearer, 'GET', '/workspace-keys', second);
      const crossRevoke = await manage(bearer, 'DELETE', `/workspace-keys/${inSecond.id}`, orgId);

      expect(listFirst.body.map((k: any) => k.id)).toEqual([inFirst.id]);
      expect(listSecond.body.map((k: any) => k.id)).toEqual([inSecond.id]);
      expect(crossRevoke.status).toBe(404);
      expect(crossRevoke.text).not.toContain(second);
      expect((await publicCall(inSecond.key)).status).toBe(200);
    });

    it('answers 404 for an unknown key id', async () => {
      const { user, orgId } = await newUser();
      const bearer = await bearerFor(user);

      const res = await manage(bearer, 'DELETE', `/workspace-keys/${randomUUID()}`, orgId);

      expect(res.status).toBe(404);
    });

    it('a key cannot manage keys: the routes need a signed-in user', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id);

      const res = await call('POST', '/workspace-keys', {
        body: { name: 'k', scopes: ['posts:read'] },
        headers: { authorization: key.key, 'x-workspace-id': orgId },
      });

      expect(res.status).not.toBe(201);
      expect(await worker.apiKey.count({ where: { organizationId: orgId } })).toBe(1);
    });

    it('the secret never reaches the idempotency record: the answer is written in pieces, kept with no body, and a retry gets 409', async () => {
      const { user, orgId } = await newUser();
      const bearer = await bearerFor(user);
      const idempotencyKey = 'create-' + randomUUID();
      const headers = { 'idempotency-key': idempotencyKey };

      const first = await manage(bearer, 'POST', '/workspace-keys', orgId, {
        body: { name: 'once', scopes: ['posts:read'] },
        headers,
      });
      const retry = await manage(bearer, 'POST', '/workspace-keys', orgId, {
        body: { name: 'once', scopes: ['posts:read'] },
        headers,
      });

      expect(first.status).toBe(201);
      expect(retry.status).toBe(409);
      expect(retry.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_USED' });
      expect(retry.text).not.toContain(first.body.key.split('_')[2]);
      const records = await worker.idempotencyRecord.findMany({
        where: { workspaceId: orgId, key: idempotencyKey },
      });
      expect(records).toHaveLength(1);
      expect(records[0].responseBody).toBeNull();
      expect(JSON.stringify(records[0])).not.toContain(first.body.key.split('_')[2]);
      expect(await worker.apiKey.count({ where: { organizationId: orgId } })).toBe(1);
    });
  });

  describe('enterprise endpoints', () => {
    const redirectUrl = 'https://partner.example/return';

    // The real enterprise controller over the real organization and key services, with the channel
    // services (upstream code) standing in and recording what they were asked.
    const enterprise = () => {
      const deleted: { orgId: string; id: string }[] = [];
      const states: string[] = [];
      const controller = new EnterpriseController(
        {
          // Allows every provider.
          getAllowedSocialsIntegrations: () => ['x'],
          // A provider whose auth URL names a fresh state.
          getSocialIntegration: () => ({
            // The auth URL a connect would start from.
            generateAuthUrl: async () => {
              const state = 'state-' + randomUUID();
              states.push(state);
              return { codeVerifier: 'verifier', state, url: `https://idp.example/${state}` };
            },
          }),
        } as any,
        organizations,
        {
          // No posts to remove.
          getPostsForChannel: async () => [],
          // Records the channel that was deleted.
          deleteChannel: async (orgId: string, id: string) => {
            deleted.push({ orgId, id });
          },
        } as any,
        {} as any,
        apiKeys,
        {
          // Every provider has its app keys; the key's workspace check is what is under test.
          assertConfigured: async () => undefined,
          // Runs the provider call as is.
          runWithWorkspace: (_orgId: string, fn: () => Promise<unknown>) => fn(),
        } as any
      );
      return { controller, deleted, states };
    };

    // An enterprise-signed body naming a key.
    const params = (payload: object) => AuthService.signJWT(payload);

    it('delete-channel deletes in the workspace of a key that holds channels:write', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id, ['channels:write']);
      const { controller, deleted } = enterprise();

      const res = await controller.deleteChannel(params({ apiKey: key.key, id: 'c1' }));

      expect(res).toEqual({ success: true });
      expect(deleted).toEqual([{ orgId, id: 'c1' }]);
    });

    it('delete-channel refuses a key without channels:write, a revoked key and an unknown key, deleting nothing', async () => {
      const { user, orgId } = await newUser();
      const narrow = await keyFor(orgId, user.id, [...API_SCOPES].filter((s) => s !== 'channels:write'));
      const revoked = await keyFor(orgId, user.id);
      await apiKeys.revoke(orgId, revoked.id);
      const { controller, deleted } = enterprise();

      for (const apiKey of [narrow.key, revoked.key, 'unknown-key']) {
        expect(await controller.deleteChannel(params({ apiKey, id: 'c1' }))).toEqual({
          success: false,
        });
      }
      expect(deleted).toEqual([]);
    });

    it('a migrated legacy value with every scope still opens delete-channel', async () => {
      const { orgId } = await newUser();
      const held = 'enterprise-held-' + randomUUID();
      await worker.apiKey.create({
        data: {
          organizationId: orgId,
          name: 'Legacy key',
          prefix: 'legacy-' + orgId,
          secretHash: require('crypto').createHash('sha256').update(held).digest('hex'),
          scopes: [...API_SCOPES],
        },
      });
      const { controller, deleted } = enterprise();

      const res = await controller.deleteChannel(params({ apiKey: held, id: 'c2' }));

      expect(res).toEqual({ success: true });
      expect(deleted).toEqual([{ orgId, id: 'c2' }]);
    });

    it('url binds the connect state to the key workspace and answers the provider URL', async () => {
      const { user, orgId } = await newUser();
      const key = await keyFor(orgId, user.id, ['channels:write']);
      const { controller, states } = enterprise();

      const res = await controller.redirectParams(
        params({ apiKey: key.key, redirectUrl, provider: 'x', webhookUrl: 'https://partner.example/hook' })
      );

      expect(res).toBe(`https://idp.example/${states[0]}`);
      expect(await redis.get(`organization:${states[0]}`)).toBe(orgId);
    });

    it('url answers no URL and starts no connect for a key without channels:write or an unknown key', async () => {
      const { user, orgId } = await newUser();
      const narrow = await keyFor(orgId, user.id, ['channels:read']);
      const { controller, states } = enterprise();

      for (const apiKey of [narrow.key, 'unknown-key']) {
        const res = await controller.redirectParams(
          params({ apiKey, redirectUrl, provider: 'x', webhookUrl: 'https://partner.example/hook' })
        );
        expect(res).toBeUndefined();
      }
      expect(states).toEqual([]);
    });
  });
});
