// api.mobile-access: a signed-in device calls the public API (`/public/v1`) with its Bearer
// access token. Runs the real `PublicAuthMiddleware`, token service, failed-attempt limiter,
// `/auth/token` controller, `AuthMiddleware` (for the "same default workspace" comparison) and the
// idempotency middleware in a real Nest app against a real Postgres and a real Redis, on the API
// role as the backend runs. Only `OAuthService` is a stand-in, answering the one call the `pos_`
// branch makes (`getOrgByOAuthToken`): that branch is not this sub-module's.
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
import { ApiKeysService } from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.service';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { HttpExceptionFilter } from '@gitroom/nestjs-libraries/services/exception.filter';
import { AuthTokenController } from '@gitroom/backend/api/routes/auth.token.controller';
import { WebHandoffService } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.service';
import { EmailOtpService } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.service';
import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';
import { PublicAuthMiddleware } from '@gitroom/backend/services/auth/public.auth.middleware';
import { IdempotencyMiddleware } from '@gitroom/backend/services/idempotency/idempotency.middleware';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';
import { TokenGrantsService } from '@gitroom/backend/services/auth/tokens/token.grants.service';
import { AuthAttemptLimiter } from '@gitroom/backend/services/auth/tokens/auth.attempt.limiter';
import { RequireScope } from '@gitroom/backend/services/auth/scopes/require.scope';
import { ScopeGuard } from '@gitroom/backend/services/auth/scopes/scope.guard';
import { ThrottlerBehindProxyGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';

// Modules that pull ESM-only packages ts-jest cannot load; nothing here calls them
jest.mock('file-type', () => ({}));
jest.mock('@gitroom/nestjs-libraries/chat/mastra.service', () => ({
  MastraService: class {},
}));
// The limiter counts in a real Redis, the one the test run is given
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

// The public routes under test, answering what the middleware set on the request.
@Controller('/public/v1')
class PublicProbeController {
  // The ids and role the public middleware resolved for the request.
  @Get('who')
  who(@Req() req: any) {
    return {
      userId: req.user?.id ?? null,
      orgId: req.org?.id,
      role: req.org?.users?.[0]?.role ?? req.org?.users?.[0]?.users?.role,
      authOrgId: req.authOrgId,
      isOAuthApp: req.isOAuthApp,
      sessionId: req.sessionId ?? null,
      hasPassword: !!req.user?.password,
    };
  }

  // A mutation that counts its runs, to see the idempotency middleware replay for a device principal.
  @Post('mutate')
  mutate(@Req() req: any, @Body() body: unknown) {
    const name = `${req.org.id}:${String(req.headers['x-probe'])}`;
    const n = (runs.get(name) ?? 0) + 1;
    runs.set(name, n);
    return { n, orgId: req.org.id };
  }
}

// Public routes behind the scope guard the real public controller uses, to see which principals pass it.
@Controller('/public/v1/scoped')
@UseGuards(ScopeGuard)
class ScopedProbeController {
  // A route that needs the `posts:read` scope.
  @Get('read')
  @RequireScope('posts:read')
  read() {
    return { ok: true };
  }

  // A route that needs the `ai:use` scope.
  @Get('ai')
  @RequireScope('ai:use')
  ai() {
    return { ok: true };
  }

  // A route that names no scope.
  @Get('unscoped')
  unscoped() {
    return { ok: true };
  }
}

// Public routes that report the key the public API's throttler would count a request under.
@Controller('/public/v1/tracker')
class TrackerProbeController {
  // The throttler's key for a request to a route that is not a post route.
  @Get('other')
  other(@Req() req: any) {
    return this.trackerOf(req);
  }

  // The throttler's key for a request to a post route (the path holds `/posts`).
  @Get('posts')
  posts(@Req() req: any) {
    return this.trackerOf(req);
  }

  // Reads the key with the throttler's own tracker, as the global guard does on every request.
  private async trackerOf(req: any) {
    return {
      tracker: await (ThrottlerBehindProxyGuard.prototype as any).getTracker(
        req
      ),
    };
  }
}

// The app's own route, behind `AuthMiddleware`, to compare the default workspace with.
@Controller('/probe')
class AppProbeController {
  // The workspace `AuthMiddleware` resolved for the request.
  @Get('me')
  me(@Req() req: any) {
    return { orgId: req.org?.id };
  }
}

// Waits for the given number of milliseconds.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb('api.mobile-access (Postgres, Redis)', () => {
  let worker: PrismaClient;
  let apiPrisma: PrismaService;
  let organizations: OrganizationService;
  let apiKeys: ApiKeysService;
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
    'ACCESS_TOKEN_TTL_SECONDS',
    'AUTH_FAIL_LIMIT',
    'AUTH_FAIL_WINDOW_SECONDS',
  ];

  beforeAll(async () => {
    for (const name of envNames) {
      saved[name] = process.env[name];
    }
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    process.env.JWT_SECRET = 'mobile-access-spec-secret';
    process.env.FRONTEND_URL = 'http://localhost:4200';
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    process.env.YOUTUBE_CLIENT_ID = 'mobile-access-spec-client';
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

    // The app under test: the token controller, both probe routes and the real middlewares.
    @Module({
      controllers: [
        AuthTokenController,
        PublicProbeController,
        ScopedProbeController,
        TrackerProbeController,
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
      // Puts the public middlewares on the public routes and `AuthMiddleware` on the app's own route.
      configure(consumer: MiddlewareConsumer) {
        consumer
          .apply(PublicAuthMiddleware, IdempotencyMiddleware)
          .forRoutes(
            PublicProbeController,
            ScopedProbeController,
            TrackerProbeController
          );
        consumer.apply(AuthMiddleware).forRoutes(AppProbeController);
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
    jest.restoreAllMocks();
    delete process.env.ACCESS_TOKEN_TTL_SECONDS;
    delete process.env.AUTH_FAIL_LIMIT;
    delete process.env.AUTH_FAIL_WINDOW_SECONDS;
  });

  const password = 'correct-horse-' + randomUUID();
  // A client address of its own, so the limiter's counts never leak between tests
  const address = () =>
    `10.${Math.floor(Math.random() * 250)}.${Math.floor(
      Math.random() * 250
    )}.${Math.floor(Math.random() * 250)}`;

  // An activated email-and-password user who is the only member of a workspace of their own.
  const newUser = async (overrides: Record<string, unknown> = {}) => {
    const user = await worker.user.create({
      data: {
        email: randomUUID() + '@test.local',
        providerName: 'LOCAL',
        password: AuthService.hashPassword(password),
        activated: true,
        timezone: 0,
        ...overrides,
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
  const joinWorkspace = async (
    userId: string,
    role: 'ADMIN' | 'USER',
    disabled = false
  ) => {
    const org = await worker.organization.create({
      data: {
        name: 'ws-' + randomUUID(),
        users: { create: { role, userId, disabled } },
      },
    });
    return org.id;
  };

  // One request to the app from an address; the answer with its parsed body.
  const call = async (
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      ip?: string;
    } = {}
  ) => {
    const res = await fetch(base + path, {
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

  // Opens a session for the user as a sign-in does (`TokenService.issue`), and returns the pair.
  const signIn = async (user: { id: string }) =>
    (await app
      .get(TokenService)
      .issue(user.id, { name: 'Pixel', ip: address() })) as {
      access_token: string;
      refresh_token: string;
      session_id: string;
    };

  // A public API call carrying `Authorization` and any extra headers.
  const publicCall = (
    authorization: string | undefined,
    headers: Record<string, string> = {},
    ip?: string,
    path = '/public/v1/who'
  ) =>
    call('GET', path, {
      ip,
      headers: {
        ...(authorization === undefined ? {} : { authorization }),
        ...headers,
      },
    });

  // The failed attempts the shared counter holds for an address and a kind of attempt.
  const failures = (ip: string, kind: string) =>
    redis
      .get(`auth:fail:${kind}:${ip}`)
      .then((value: string | null) => Number(value ?? 0));

  // An access token for the user and session whose expiry is already past, signed as the service signs.
  const expiredToken = (userId: string, sessionId: string) =>
    AuthService.signJWT({
      sub: userId,
      sid: sessionId,
      iat: Math.floor(Date.now() / 1000) - 3600,
      exp: Math.floor(Date.now() / 1000) - 1800,
    });

  describe('a valid Bearer access token', () => {
    it('is accepted on a /public/v1 route and acts as the token user in their workspace', async () => {
      const { user, orgId } = await newUser();
      const pair = await signIn(user);

      const res = await publicCall(`Bearer ${pair.access_token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        userId: user.id,
        orgId,
        authOrgId: orgId,
        isOAuthApp: false,
        sessionId: pair.session_id,
      });
    });

    it('accepts the scheme in any case', async () => {
      const { user, orgId } = await newUser();
      const pair = await signIn(user);

      const res = await publicCall(`bearer ${pair.access_token}`);

      expect(res.status).toBe(200);
      expect(res.body.orgId).toBe(orgId);
    });

    it('acts with the user real role, never the SUPERADMIN a key gets', async () => {
      const { user } = await newUser();
      const adminWorkspace = await joinWorkspace(user.id, 'ADMIN');
      const userWorkspace = await joinWorkspace(user.id, 'USER');
      const pair = await signIn(user);
      const bearer = `Bearer ${pair.access_token}`;

      const admin = await publicCall(bearer, {
        'x-workspace-id': adminWorkspace,
      });
      const plain = await publicCall(bearer, {
        'x-workspace-id': userWorkspace,
      });

      expect(admin.body.role).toBe('ADMIN');
      expect(plain.body.role).toBe('USER');
      expect(plain.body.role).not.toBe('SUPERADMIN');
    });

    it('never puts the user password hash on the request', async () => {
      const { user } = await newUser();
      const pair = await signIn(user);

      const res = await publicCall(`Bearer ${pair.access_token}`);

      expect(res.body.hasPassword).toBe(false);
    });
  });

  describe('workspace', () => {
    it('without x-workspace-id is the default AuthMiddleware resolves for the same user', async () => {
      const { user } = await newUser();
      await joinWorkspace(user.id, 'ADMIN');
      await joinWorkspace(user.id, 'USER');
      const pair = await signIn(user);
      const bearer = `Bearer ${pair.access_token}`;

      const device = await publicCall(bearer);
      const app_ = await call('GET', '/probe/me', {
        headers: { authorization: bearer },
      });

      expect(app_.status).toBe(200);
      expect(device.body.orgId).toBe(app_.body.orgId);
    });

    it('x-workspace-id selects a workspace the user belongs to', async () => {
      const { user, orgId } = await newUser();
      const second = await joinWorkspace(user.id, 'ADMIN');
      const pair = await signIn(user);
      const bearer = `Bearer ${pair.access_token}`;

      const other = await publicCall(bearer, { 'x-workspace-id': second });
      const own = await publicCall(bearer, { 'x-workspace-id': orgId });

      expect(other.body.orgId).toBe(second);
      expect(other.body.authOrgId).toBe(second);
      expect(own.body.orgId).toBe(orgId);
    });

    it('x-workspace-id of a workspace the user is not in answers 403 WORKSPACE_FORBIDDEN with no data and no ids', async () => {
      const { user } = await newUser();
      const stranger = await newUser();
      const pair = await signIn(user);

      const res = await publicCall(`Bearer ${pair.access_token}`, {
        'x-workspace-id': stranger.orgId,
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        statusCode: 403,
        code: 'WORKSPACE_FORBIDDEN',
      });
      expect(res.text).not.toContain(stranger.orgId);
    });

    it("x-workspace-id of a workspace that does not exist answers the same 403 as one that is someone else's", async () => {
      const { user } = await newUser();
      const stranger = await newUser();
      const pair = await signIn(user);
      const bearer = `Bearer ${pair.access_token}`;

      const unknown = await publicCall(bearer, {
        'x-workspace-id': randomUUID(),
      });
      const foreign = await publicCall(bearer, {
        'x-workspace-id': stranger.orgId,
      });

      expect(unknown.status).toBe(403);
      expect(unknown.body).toEqual(foreign.body);
    });

    it('a workspace the user was disabled in is forbidden', async () => {
      const { user } = await newUser();
      const disabled = await joinWorkspace(user.id, 'USER', true);
      const pair = await signIn(user);

      const res = await publicCall(`Bearer ${pair.access_token}`, {
        'x-workspace-id': disabled,
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('WORKSPACE_FORBIDDEN');
    });

    it('a user in no workspace gets 403 WORKSPACE_FORBIDDEN, never another workspace', async () => {
      const { user } = await newUser();
      await worker.userOrganization.deleteMany({ where: { userId: user.id } });
      const pair = await signIn(user);

      const res = await publicCall(`Bearer ${pair.access_token}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('WORKSPACE_FORBIDDEN');
    });

    it('a workspace deleted after the token was issued is not one the user can act in', async () => {
      const { user } = await newUser();
      const gone = await joinWorkspace(user.id, 'ADMIN');
      const pair = await signIn(user);
      await worker.organization.update({
        where: { id: gone },
        data: { deletedAt: new Date() },
      });

      const res = await publicCall(`Bearer ${pair.access_token}`, {
        'x-workspace-id': gone,
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('WORKSPACE_FORBIDDEN');
    });
  });

  describe('x-postiz-org', () => {
    it('is refused with 403 for a device token, even when it names the workspace the user is in', async () => {
      const { user, orgId } = await newUser();
      const second = await joinWorkspace(user.id, 'ADMIN');
      const pair = await signIn(user);
      const bearer = `Bearer ${pair.access_token}`;

      const own = await publicCall(bearer, { 'x-postiz-org': orgId });
      const other = await publicCall(bearer, { 'x-postiz-org': second });

      expect(own.status).toBe(403);
      expect(other.status).toBe(403);
      expect(own.body).toEqual({ msg: 'Unauthorized' });
    });

    it('does not switch the workspace: x-workspace-id still does, and only for a workspace the user is in', async () => {
      const { user } = await newUser();
      const second = await joinWorkspace(user.id, 'ADMIN');
      const pair = await signIn(user);

      const res = await publicCall(`Bearer ${pair.access_token}`, {
        'x-workspace-id': second,
      });

      expect(res.status).toBe(200);
      expect(res.body.orgId).toBe(second);
    });
  });

  describe('bad tokens', () => {
    it('an expired access token answers 401 TOKEN_EXPIRED', async () => {
      const { user } = await newUser();
      const pair = await signIn(user);

      const res = await publicCall(
        `Bearer ${expiredToken(user.id, pair.session_id)}`
      );

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ statusCode: 401, code: 'TOKEN_EXPIRED' });
    });

    it('a token that expires after it was issued answers 401 TOKEN_EXPIRED on its next call', async () => {
      process.env.ACCESS_TOKEN_TTL_SECONDS = '1';
      const { user } = await newUser();
      const pair = await signIn(user);
      delete process.env.ACCESS_TOKEN_TTL_SECONDS;
      expect((await publicCall(`Bearer ${pair.access_token}`)).status).toBe(
        200
      );

      await sleep(2100);
      const res = await publicCall(`Bearer ${pair.access_token}`);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TOKEN_EXPIRED');
    });

    it('a revoked session answers 401 SESSION_REVOKED on its next call, whatever its token expiry', async () => {
      const { user } = await newUser();
      const pair = await signIn(user);
      const bearer = `Bearer ${pair.access_token}`;
      expect((await publicCall(bearer)).status).toBe(200);

      const revoked = await call('POST', '/auth/token/revoke', {
        body: { refresh_token: pair.refresh_token },
      });
      const res = await publicCall(bearer);

      expect(revoked.status).toBe(204);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ statusCode: 401, code: 'SESSION_REVOKED' });
      // the token was far from its expiry
      expect(
        JSON.parse(
          Buffer.from(pair.access_token.split('.')[1], 'base64url').toString()
        ).exp * 1000
      ).toBeGreaterThan(Date.now());
    });

    it.each([
      ['a random string', () => 'not-a-token'],
      [
        'a JWT signed with another secret',
        () => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { sign } = require('jsonwebtoken');
          return sign({ sub: 'x', sid: 'y' }, 'another-secret');
        },
      ],
      [
        'upstream one-year token with no session id',
        () => AuthService.signJWT({ id: randomUUID() }),
      ],
    ])(
      '%s answers 401 with the same body as a wrong API key',
      async (_name, make) => {
        const wrongKey = await publicCall('definitely-not-a-key');

        const res = await publicCall(`Bearer ${make()}`);

        expect(wrongKey.status).toBe(401);
        expect(res.status).toBe(401);
        expect(res.body).toEqual(wrongKey.body);
      }
    );

    it('a token for a session that does not exist, one for an unknown user and one for a deleted-activation user all answer exactly like a bad signature', async () => {
      const { user } = await newUser();
      const pair = await signIn(user);
      const claims = {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const noSession = AuthService.signJWT({
        sub: user.id,
        sid: randomUUID(),
        ...claims,
      });
      const unknownUser = AuthService.signJWT({
        sub: randomUUID(),
        sid: pair.session_id,
        ...claims,
      });
      const deactivated = await newUser();
      const deactivatedPair = await signIn(deactivated.user);
      await worker.user.update({
        where: { id: deactivated.user.id },
        data: { activated: false },
      });
      const baseline = await publicCall('Bearer garbage');

      for (const token of [
        noSession,
        unknownUser,
        deactivatedPair.access_token,
      ]) {
        const res = await publicCall(`Bearer ${token}`);
        expect(res.status).toBe(401);
        expect(res.body).toEqual(baseline.body);
        expect(res.text).not.toContain(token);
      }
    });

    it("a token whose session belongs to another user answers 401, not that user's data", async () => {
      const first = await newUser();
      const second = await newUser();
      const pair = await signIn(second.user);
      const forged = AuthService.signJWT({
        sub: first.user.id,
        sid: pair.session_id,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      });

      const res = await publicCall(`Bearer ${forged}`);

      expect(res.status).toBe(401);
      expect(res.text).not.toContain(first.orgId);
    });

    it('never echoes the token', async () => {
      const token = 'secret-looking-' + randomUUID();

      const res = await publicCall(`Bearer ${token}`);

      expect(res.text).not.toContain(token);
    });

    it('never writes a token to a log', async () => {
      const written: string[] = [];
      for (const stream of [process.stdout, process.stderr]) {
        jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
          written.push(String(chunk));
          return true;
        }) as any);
      }
      for (const method of ['log', 'warn', 'error', 'debug', 'info'] as const) {
        jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          written.push(args.map(String).join(' '));
        });
      }
      const { user } = await newUser();
      const pair = await signIn(user);
      const bad = 'secret-looking-' + randomUUID();
      const expired = expiredToken(user.id, pair.session_id);

      await publicCall(`Bearer ${pair.access_token}`);
      await publicCall(`Bearer ${bad}`);
      await publicCall(`Bearer ${expired}`);
      await publicCall(`Bearer ${pair.access_token}`, {
        'x-postiz-org': 'whatever',
      });

      const output = written.join('\n');
      for (const secret of [
        pair.access_token,
        pair.refresh_token,
        bad,
        expired,
      ]) {
        expect(output).not.toContain(secret);
      }
    });

    it('a device token sent without the Bearer scheme is read as an API key and fails like one', async () => {
      const { user } = await newUser();
      const pair = await signIn(user);

      const res = await publicCall(pair.access_token);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid API key' });
    });
  });

  describe('the failed-attempt limit', () => {
    it('a bad token records an api_key failure for the address', async () => {
      const ip = address();

      await publicCall('Bearer garbage', {}, ip);
      await publicCall('Bearer garbage-too', {}, ip);

      expect(await failures(ip, 'api_key')).toBe(2);
      expect(await failures(ip, 'sign_in')).toBe(0);
      expect(await failures(ip, 'refresh')).toBe(0);
    });

    it('a valid token records no failure', async () => {
      const { user } = await newUser();
      const pair = await signIn(user);
      const ip = address();

      await publicCall(`Bearer ${pair.access_token}`, {}, ip);

      expect(await failures(ip, 'api_key')).toBe(0);
    });

    it('an expired and a revoked token are not guesses and record no failure', async () => {
      const { user } = await newUser();
      const pair = await signIn(user);
      const ip = address();
      await publicCall(
        `Bearer ${expiredToken(user.id, pair.session_id)}`,
        {},
        ip
      );
      await call('POST', '/auth/token/revoke', {
        body: { refresh_token: pair.refresh_token },
      });
      await publicCall(`Bearer ${pair.access_token}`, {}, ip);

      expect(await failures(ip, 'api_key')).toBe(0);
    });

    it('ten wrong tokens from one address lock it: the next call answers 429 with Retry-After, even for a good token', async () => {
      const { user } = await newUser();
      const pair = await signIn(user);
      const ip = address();

      for (let i = 0; i < 10; i++) {
        const res = await publicCall(`Bearer wrong-${i}`, {}, ip);
        expect(res.status).toBe(401);
      }
      const locked = await publicCall(`Bearer ${pair.access_token}`, {}, ip);
      const stillLocked = await publicCall('Bearer wrong-again', {}, ip);

      expect(locked.status).toBe(429);
      expect(locked.body).toEqual({
        statusCode: 429,
        code: 'AUTH_RATE_LIMITED',
      });
      expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(stillLocked.status).toBe(429);
      // the lock is on the address, not on the user
      const elsewhere = await publicCall(`Bearer ${pair.access_token}`);
      expect(elsewhere.status).toBe(200);
    });

    it('a locked address is refused before the token is checked, so the answer cannot tell whether a token is right', async () => {
      process.env.AUTH_FAIL_LIMIT = '2';
      const { user } = await newUser();
      const pair = await signIn(user);
      const ip = address();
      await publicCall('Bearer a', {}, ip);
      await publicCall('Bearer b', {}, ip);

      const good = await publicCall(`Bearer ${pair.access_token}`, {}, ip);
      const bad = await publicCall('Bearer c', {}, ip);

      expect(good.status).toBe(429);
      expect(good.body).toEqual(bad.body);
      expect(await failures(ip, 'api_key')).toBe(2);
    });

    it('parallel wrong tokens from one address cannot all pass the check before the first is counted', async () => {
      process.env.AUTH_FAIL_LIMIT = '3';
      const ip = address();

      const answers = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          publicCall(`Bearer parallel-${i}`, {}, ip)
        )
      );

      expect(answers.filter((a) => a.status === 401)).toHaveLength(3);
      expect(answers.filter((a) => a.status === 429)).toHaveLength(9);
    });
  });

  describe('API keys and OAuth-app tokens', () => {
    it('a scoped API key authenticates its workspace with the forced SUPERADMIN, as before', async () => {
      const { user, orgId } = await newUser();
      const { key } = await apiKeys.create(orgId, user.id, {
        name: 'ci',
        scopes: ['posts:read'],
      });

      const res = await publicCall(key);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        orgId,
        authOrgId: orgId,
        isOAuthApp: false,
        role: 'SUPERADMIN',
        userId: null,
        sessionId: null,
      });
    });

    it('x-postiz-org on a scoped API key answers 403 WORKSPACE_FORBIDDEN and switches nothing', async () => {
      const first = await newUser({ isSuperAdmin: true });
      const second = await newUser();
      const { key } = await apiKeys.create(first.orgId, first.user.id, {
        name: 'ci',
        scopes: ['posts:read'],
      });

      const switched = await publicCall(key, { 'x-postiz-org': second.orgId });
      const unknown = await publicCall(key, { 'x-postiz-org': randomUUID() });

      expect(switched.status).toBe(403);
      expect(switched.body).toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
      expect(unknown.status).toBe(403);
      expect(unknown.body).toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
    });

    it('a wrong API key answers 401 Invalid API key', async () => {
      const res = await publicCall('no-such-key');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid API key' });
    });

    it('no Authorization header answers 401 No API Key found', async () => {
      const res = await publicCall(undefined);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'No API Key found' });
    });

    it('a pos_ OAuth-app token still authenticates through the OAuth service, not the device branch', async () => {
      const { orgId } = await newUser();
      oauth.token = 'pos_' + randomUUID();
      oauth.organization = await worker.organization.findUniqueOrThrow({
        where: { id: orgId },
      });

      const res = await publicCall(oauth.token);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        orgId,
        isOAuthApp: true,
        role: 'SUPERADMIN',
        userId: null,
      });
    });

    it('a pos_ token refuses x-postiz-org exactly as before', async () => {
      const { orgId } = await newUser();
      oauth.token = 'pos_' + randomUUID();
      oauth.organization = await worker.organization.findUniqueOrThrow({
        where: { id: orgId },
      });

      const res = await publicCall(oauth.token, { 'x-postiz-org': orgId });

      expect(res.status).toBe(403);
    });

    it('an unknown pos_ token answers 401 Invalid OAuth token', async () => {
      const res = await publicCall('pos_unknown');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid OAuth token' });
    });
  });

  describe('scopes and the throttle', () => {
    it('a device token passes a route that needs a scope, and one that names none', async () => {
      const { user } = await newUser();
      const pair = await signIn(user);
      const bearer = `Bearer ${pair.access_token}`;

      for (const route of ['read', 'ai', 'unscoped']) {
        const res = await publicCall(
          bearer,
          {},
          undefined,
          `/public/v1/scoped/${route}`
        );
        expect(res.status).toBe(200);
      }
    });

    it('the same routes refuse a key that lacks the scope, so the pass above is not an open guard', async () => {
      const { user, orgId } = await newUser();
      const { key } = await apiKeys.create(orgId, user.id, {
        name: 'ci',
        scopes: ['posts:read'],
      });

      const allowed = await publicCall(
        key,
        {},
        undefined,
        '/public/v1/scoped/read'
      );
      const refused = await publicCall(
        key,
        {},
        undefined,
        '/public/v1/scoped/ai'
      );

      expect(allowed.status).toBe(200);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'SCOPE_FORBIDDEN' });
    });

    it('a device principal is counted by the workspace it acts in, per post route and other routes', async () => {
      const { user } = await newUser();
      const second = await joinWorkspace(user.id, 'ADMIN');
      const pair = await signIn(user);
      const bearer = `Bearer ${pair.access_token}`;
      // The default workspace is the one `AuthMiddleware` resolves for this user (the contract's
      // rule); the user's workspaces come back in no fixed order, so it is read, not assumed.
      const defaultWorkspace = (
        await call('GET', '/probe/me', { headers: { authorization: bearer } })
      ).body.orgId;

      const posts = await publicCall(
        bearer,
        {},
        undefined,
        '/public/v1/tracker/posts'
      );
      const other = await publicCall(
        bearer,
        {},
        undefined,
        '/public/v1/tracker/other'
      );
      const inSecond = await publicCall(
        bearer,
        { 'x-workspace-id': second },
        undefined,
        '/public/v1/tracker/posts'
      );

      expect(posts.body.tracker).toBe(`${defaultWorkspace}_posts`);
      expect(other.body.tracker).toBe(`${defaultWorkspace}_other`);
      expect(inSecond.body.tracker).toBe(`${second}_posts`);
    });
  });

  describe('idempotency and the acting workspace', () => {
    // A mutation from a device under a key, acting in a workspace.
    const mutate = (
      accessToken: string,
      key: string,
      workspace?: string,
      probe = 'one'
    ) =>
      call('POST', '/public/v1/mutate', {
        body: { text: 'hello' },
        headers: {
          authorization: `Bearer ${accessToken}`,
          'idempotency-key': key,
          'x-probe': probe,
          ...(workspace ? { 'x-workspace-id': workspace } : {}),
        },
      });

    it('the same Idempotency-Key sent twice by a device runs the handler once and replays the answer', async () => {
      const { user, orgId } = await newUser();
      const pair = await signIn(user);
      const key = randomUUID();

      const first = await mutate(pair.access_token, key);
      const second = await mutate(pair.access_token, key);

      expect(first.status).toBe(201);
      expect(first.body).toEqual({ n: 1, orgId });
      expect(second.body).toEqual(first.body);
      expect(second.headers.get('idempotent-replayed')).toBe('true');
      expect(runs.get(`${orgId}:one`)).toBe(1);
    });

    it('the key still replays after the access token was rotated, since the principal is the user', async () => {
      const { user, orgId } = await newUser();
      const first = await signIn(user);
      const refreshed = await call('POST', '/auth/token', {
        body: {
          grant_type: 'refresh_token',
          refresh_token: first.refresh_token,
        },
      });
      const key = randomUUID();

      const before = await mutate(first.access_token, key);
      const after = await mutate(refreshed.body.access_token, key);

      expect(after.body).toEqual(before.body);
      expect(runs.get(`${orgId}:one`)).toBe(1);
    });

    it('the workspace the request acts in is the one that runs the handler, and one key in two workspaces is two intents', async () => {
      const { user, orgId } = await newUser();
      const second = await joinWorkspace(user.id, 'ADMIN');
      const pair = await signIn(user);
      const key = randomUUID();

      const inFirst = await mutate(pair.access_token, key, orgId);
      const inSecond = await mutate(pair.access_token, key, second);

      expect(inFirst.body.orgId).toBe(orgId);
      expect(inSecond.body.orgId).toBe(second);
      expect(runs.get(`${orgId}:one`)).toBe(1);
      expect(runs.get(`${second}:one`)).toBe(1);
    });

    it('a request refused for a bad token never reaches the handler or stores a key', async () => {
      const key = randomUUID();
      const res = await call('POST', '/public/v1/mutate', {
        body: { text: 'hello' },
        headers: {
          authorization: 'Bearer nope',
          'idempotency-key': key,
          'x-probe': 'refused',
        },
      });

      expect(res.status).toBe(401);
      expect([...runs.keys()].some((name) => name.endsWith(':refused'))).toBe(
        false
      );
      expect(await worker.idempotencyRecord.count({ where: { key } })).toBe(0);
    });
  });
});
