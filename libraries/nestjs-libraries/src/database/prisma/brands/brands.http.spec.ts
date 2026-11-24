// Brand profile: the brand routes over HTTP. Runs the real `BrandsController`, brands
// service, repository, credit engine, account attach, `AuthMiddleware` and idempotency middleware in
// a real Nest app against a real Postgres and a real Redis, on the API role as the backend runs.
import {
  MiddlewareConsumer,
  Module,
  NestModule,
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
  selectWorkerDatabase,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { DeviceSessionsRepository } from '@gitroom/nestjs-libraries/database/prisma/device-sessions/device.sessions.repository';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { OrganizationRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersRepository } from '@gitroom/nestjs-libraries/database/prisma/users/users.repository';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { IdempotencyRepository } from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.repository';
import { IdempotencyService } from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.service';
import { BrandsRepository } from '@gitroom/nestjs-libraries/database/prisma/brands/brands.repository';
import { BrandsService } from '@gitroom/nestjs-libraries/database/prisma/brands/brands.service';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { CreditsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { PricingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { BRAND_DEFAULT_COLOR } from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { HttpExceptionFilter } from '@gitroom/nestjs-libraries/services/exception.filter';
import { EmailOtpService } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.service';
import { BrandsController } from '@gitroom/backend/api/routes/brands.controller';
import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';
import { IdempotencyMiddleware } from '@gitroom/backend/services/idempotency/idempotency.middleware';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';
import { TokenGrantsService } from '@gitroom/backend/services/auth/tokens/token.grants.service';
import { AuthAttemptLimiter } from '@gitroom/backend/services/auth/tokens/auth.attempt.limiter';

// Modules that pull ESM-only packages ts-jest cannot load; nothing here calls them
jest.mock('file-type', () => ({}));
jest.mock('@gitroom/nestjs-libraries/chat/mastra.service', () => ({
  MastraService: class {},
}));
// The failed-attempt limiter lives in a real Redis, the one the test run is given
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

describeDb('brands over HTTP (Postgres, Redis)', () => {
  let worker: PrismaClient;
  let apiPrisma: PrismaService;
  let workerPrisma: PrismaService;
  let accounts: AccountsService;
  let workerCredits: CreditsService;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;
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
  ];

  beforeAll(async () => {
    for (const name of envNames) {
      saved[name] = process.env[name];
    }
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    process.env.JWT_SECRET = 'brands-http-spec-secret';
    process.env.FRONTEND_URL = 'http://localhost:4200';
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    // empty, not deleted: Prisma loads the root .env into any variable that is unset
    process.env.NOT_SECURED = '';
    process.env.NEXT_PUBLIC_BACKEND_URL = '';
    apiPrisma = new PrismaService();
    await apiPrisma.$connect();
    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    workerPrisma = new PrismaService();
    await workerPrisma.$connect();
    expect(apiPrisma.role).toBe('api');
    expect(workerPrisma.role).toBe('worker');
    worker = new PrismaClient({ datasourceUrl: url });
    redis = (await import('@gitroom/nestjs-libraries/redis/redis.service'))
      .ioRedis;

    const repo = new PrismaRepository<any>(apiPrisma);
    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    const scope = new MoneyScope(new PrismaTransaction(apiPrisma), accounts);
    const credits = new CreditsService(
      new CreditsRepository(scope, repo, repo, repo),
      accounts,
      scope
    );
    // Credits are granted on the worker role, the only one allowed to move money in
    const workerRepo = new PrismaRepository<any>(workerPrisma);
    const workerAccounts = new AccountsService(
      new AccountsRepository(workerRepo, workerRepo, workerRepo)
    );
    const workerScope = new MoneyScope(
      new PrismaTransaction(workerPrisma),
      workerAccounts
    );
    workerCredits = new CreditsService(
      new CreditsRepository(workerScope, workerRepo, workerRepo, workerRepo),
      workerAccounts,
      workerScope
    );
    await new PricingService(
      new PricingRepository(new PrismaTransaction(apiPrisma), repo, repo),
      credits,
      accounts
    ).sync();
    const brands = new BrandsService(
      new BrandsRepository(repo, repo),
      credits,
      accounts
    );
    const organizationRepository = new OrganizationRepository(repo, repo, repo);
    const notifications = {
      // Reports no email provider.
      hasEmailProvider: () => false,
    } as any;
    const organizations = new OrganizationService(
      organizationRepository,
      notifications,
      accounts
    );
    const users = new UsersService(
      new UsersRepository(repo, new PrismaTransaction(apiPrisma)),
      organizationRepository,
      {} as any,
      notifications
    );

    // The app under test: the real brand controller and middlewares, as `api.module.ts` orders them.
    @Module({
      controllers: [BrandsController],
      providers: [
        TokenService,
        TokenGrantsService,
        AuthAttemptLimiter,
        AuthMiddleware,
        IdempotencyMiddleware,
        // the email_otp grant is not under test here: the token service only needs it to be built
        { provide: EmailOtpService, useValue: {} },
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
        { provide: BrandsService, useValue: brands },
      ],
    })
    class AppModule implements NestModule {
      // Puts `AuthMiddleware` and the idempotency middleware before the brand routes.
      configure(consumer: MiddlewareConsumer) {
        consumer
          .apply(AuthMiddleware, IdempotencyMiddleware)
          .forRoutes(BrandsController);
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
    if (savedWorkerUrl === undefined) {
      delete process.env.DATABASE_WORKER_URL;
    } else {
      process.env.DATABASE_WORKER_URL = savedWorkerUrl;
    }
    await app.close();
    await apiPrisma.$disconnect();
    await workerPrisma.$disconnect();
    await worker.$disconnect();
    await redis.quit();
  });

  const password = 'correct-horse-' + randomUUID();
  // A client address of its own, so the limiter's counts never leak between tests
  const address = () =>
    `10.${Math.floor(Math.random() * 250)}.${Math.floor(
      Math.random() * 250
    )}.${Math.floor(Math.random() * 250)}`;

  // An activated user who is the SUPERADMIN of a workspace of their own, attached to their account.
  const newUser = async (granted = 0) => {
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
    const accountId = await accounts.getAccountIdForOrganization(org.id);
    if (granted > 0) {
      await workerCredits.grant(accountId, { type: 'GRANT', amount: granted });
    }
    return { user, orgId: org.id, accountId };
  };

  // Makes the user a member of a new workspace with the given role.
  const joinWorkspace = async (
    userId: string,
    role: 'SUPERADMIN' | 'ADMIN' | 'USER',
    name = 'ws-' + randomUUID()
  ) => {
    const org = await worker.organization.create({
      data: { name, users: { create: { role, userId } } },
    });
    return org.id;
  };

  // Opens a session for the user as a sign-in does, and returns the Bearer header value.
  const bearerFor = async (user: { id: string }) =>
    `Bearer ${
      (
        await app
          .get(TokenService)
          .issue(user.id, { name: 'Pixel', ip: address() })
      ).access_token
    }`;

  // One request to the brand routes as the signed-in user, in the given workspace.
  const call = async (
    bearer: string,
    method: string,
    route: string,
    workspaceId: string,
    body?: unknown
  ) => {
    const res = await fetch(base + route, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': address(),
        authorization: bearer,
        'x-workspace-id': workspaceId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: text ? JSON.parse(text) : undefined,
    };
  };

  // Runs a block with `brand.create` priced at `cost`, then puts the price back.
  const withPrice = async (cost: number, run: () => Promise<void>) => {
    const before = await worker.creditAction.findUniqueOrThrow({
      where: { key: 'brand.create' },
    });
    await worker.creditAction.update({
      where: { key: 'brand.create' },
      data: { cost },
    });
    try {
      await run();
    } finally {
      await worker.creditAction.update({
        where: { key: 'brand.create' },
        data: { cost: before.cost },
      });
    }
  };

  describe('PUT /brands/current', () => {
    it('answers 403 ADMIN_REQUIRED to a USER member and changes nothing', async () => {
      const { user } = await newUser();
      const memberOf = await joinWorkspace(user.id, 'USER', 'Before ' + randomUUID());
      const before = await worker.organization.findUniqueOrThrow({
        where: { id: memberOf },
      });
      const bearer = await bearerFor(user);

      const res = await call(bearer, 'PUT', '/brands/current', memberOf, {
        name: 'Hijacked',
        color: '#ff0000',
      });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'ADMIN_REQUIRED' });
      const after = await worker.organization.findUniqueOrThrow({
        where: { id: memberOf },
      });
      expect(after.name).toBe(before.name);
      expect(after.color).toBeNull();
    });

    it.each(['ADMIN', 'SUPERADMIN'] as const)(
      'answers 200 with the changed BrandView to a %s member',
      async (role) => {
        const { user } = await newUser();
        const orgId = await joinWorkspace(user.id, role);
        const bearer = await bearerFor(user);

        const res = await call(bearer, 'PUT', '/brands/current', orgId, {
          name: 'Renamed ' + role,
          color: '#0A84FF',
          timezone: 'Europe/Berlin',
          profile: { schemaVersion: 1, tagline: 'Plain and clear' },
        });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          id: orgId,
          name: 'Renamed ' + role,
          color: '#0a84ff',
          timezone: 'Europe/Berlin',
          profile: { schemaVersion: 1, tagline: 'Plain and clear' },
        });
        const row = await worker.organization.findUniqueOrThrow({
          where: { id: orgId },
        });
        expect(row.name).toBe('Renamed ' + role);
      }
    );

    it('answers 400 INVALID_BRAND with its fields to an admin and stores nothing', async () => {
      const { user } = await newUser();
      const name = 'Keep ' + randomUUID();
      const orgId = await joinWorkspace(user.id, 'ADMIN', name);
      const bearer = await bearerFor(user);

      const res = await call(bearer, 'PUT', '/brands/current', orgId, {
        name: 'Changed',
        color: 'red',
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'INVALID_BRAND',
      });
      expect(res.body.fields.map((f: any) => f.path)).toEqual(['color']);
      const row = await worker.organization.findUniqueOrThrow({
        where: { id: orgId },
      });
      expect(row.name).toBe(name);
    });
  });

  describe('GET /brands/current', () => {
    it('answers 200 with the BrandView of the workspace named, to a USER member too', async () => {
      const { user } = await newUser();
      const name = 'Read ' + randomUUID();
      const memberOf = await joinWorkspace(user.id, 'USER', name);
      const bearer = await bearerFor(user);

      const res = await call(bearer, 'GET', '/brands/current', memberOf);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: memberOf,
        name,
        slug: expect.any(String),
        color: BRAND_DEFAULT_COLOR,
        avatarUrl: null,
        timezone: 'UTC',
        locale: 'en',
        profile: { schemaVersion: 1 },
      });
    });
  });

  describe('GET /brands', () => {
    it('answers 200 with a BrandSummary for each workspace the user belongs to', async () => {
      const { user, orgId } = await newUser();
      const second = await joinWorkspace(user.id, 'USER');
      const stranger = await newUser();
      const bearer = await bearerFor(user);

      const res = await call(bearer, 'GET', '/brands', orgId);

      expect(res.status).toBe(200);
      expect(res.body.map((b: any) => b.id).sort()).toEqual(
        [orgId, second].sort()
      );
      expect(res.text).not.toContain(stranger.orgId);
      for (const brand of res.body) {
        expect(Object.keys(brand).sort()).toEqual([
          'avatarUrl',
          'color',
          'id',
          'name',
          'slug',
        ]);
      }
    });
  });

  describe('POST /brands', () => {
    it('answers 201 with the BrandView of a new workspace attached to the creator account', async () => {
      const { user, orgId, accountId } = await newUser();
      const bearer = await bearerFor(user);
      const name = 'Fresh ' + randomUUID();

      const res = await call(bearer, 'POST', '/brands', orgId, {
        name,
        timezone: 'Asia/Tokyo',
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name,
        color: BRAND_DEFAULT_COLOR,
        avatarUrl: null,
        timezone: 'Asia/Tokyo',
        locale: 'en',
        profile: { schemaVersion: 1 },
      });
      const row = await worker.organization.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { users: true },
      });
      expect(row.accountId).toBe(accountId);
      expect(row.users).toHaveLength(1);
      expect(row.users[0]).toMatchObject({
        userId: user.id,
        role: 'SUPERADMIN',
      });
    });

    it('answers 402 INSUFFICIENT_CREDITS with its body and creates nothing', async () => {
      const { user, orgId } = await newUser(2);
      const bearer = await bearerFor(user);
      const name = 'Too Dear ' + randomUUID();

      await withPrice(3, async () => {
        const res = await call(bearer, 'POST', '/brands', orgId, {
          name,
          timezone: 'UTC',
        });

        expect(res.status).toBe(402);
        expect(res.body).toMatchObject({
          code: 'INSUFFICIENT_CREDITS',
          required: 3,
          available: 2,
        });
        expect(await worker.organization.count({ where: { name } })).toBe(0);
      });
    });

    it('answers 400 INVALID_BRAND with its fields and creates nothing', async () => {
      const { user, orgId } = await newUser();
      const bearer = await bearerFor(user);
      const name = 'Invalid ' + randomUUID();

      const res = await call(bearer, 'POST', '/brands', orgId, {
        name,
        timezone: 'Mars/Olympus',
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'INVALID_BRAND',
      });
      expect(res.body.fields.map((f: any) => f.path)).toEqual(['timezone']);
      expect(await worker.organization.count({ where: { name } })).toBe(0);
    });
  });
});
