// api.device-sessions: a user sees every signed-in device and signs any one of them out.
// Runs the real `SessionsController`, token service, `/auth/token` controller, failed-attempt
// limiter and `AuthMiddleware` in a real Nest app against a real Postgres and a real Redis, on the
// API role as the backend runs. Nothing is stood in for. The modules' registration is read from
// source (no database): the real controllers pull in ES-module-only packages jest here cannot load.
import {
  Controller,
  Get,
  MiddlewareConsumer,
  Module,
  NestModule,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
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
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { HttpExceptionFilter } from '@gitroom/nestjs-libraries/services/exception.filter';
import { AuthTokenController } from '@gitroom/backend/api/routes/auth.token.controller';
import { WebHandoffService } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.service';
import { EmailOtpService } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.service';
import { SessionsController } from '@gitroom/backend/api/routes/sessions.controller';
import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';
import { TokenGrantsService } from '@gitroom/backend/services/auth/tokens/token.grants.service';
import { AuthAttemptLimiter } from '@gitroom/backend/services/auth/tokens/auth.attempt.limiter';

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

// An app route behind `AuthMiddleware`, to see whether a device still gets in.
@Controller('/probe')
class ProbeController {
  // Answers, with the user the request acts as, for any request that got through authentication.
  @Get('me')
  me(@Req() req: any) {
    return { ok: true, userId: req.user.id };
  }
}

describeDb('api.device-sessions (Postgres, Redis)', () => {
  let worker: PrismaClient;
  let apiPrisma: PrismaService;
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
  ];

  beforeAll(async () => {
    for (const name of envNames) {
      saved[name] = process.env[name];
    }
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    process.env.JWT_SECRET = 'device-sessions-spec-secret';
    process.env.FRONTEND_URL = 'http://localhost:4200';
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    process.env.YOUTUBE_CLIENT_ID = 'device-sessions-spec-client';
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
    const organizations = new OrganizationService(
      organizationRepository,
      notifications,
      new AccountsService(new AccountsRepository(repo, repo, repo))
    );
    const users = new UsersService(
      new UsersRepository(repo, new PrismaTransaction(apiPrisma)),
      organizationRepository,
      {} as any,
      notifications
    );

    // The app under test: the token and sessions controllers behind the real authentication.
    @Module({
      controllers: [AuthTokenController, SessionsController, ProbeController],
      providers: [
        TokenService,
        TokenGrantsService,
        AuthAttemptLimiter,
        AuthMiddleware,
        // the email_otp grant is not under test here: the controller only needs the service to be built
        { provide: EmailOtpService, useValue: {} },
        { provide: WebHandoffService, useValue: {} },
        {
          provide: DeviceSessionsRepository,
          useValue: new DeviceSessionsRepository(repo),
        },
        { provide: UsersService, useValue: users },
        { provide: OrganizationService, useValue: organizations },
      ],
    })
    class AppModule implements NestModule {
      // Puts `AuthMiddleware` on the sessions and probe routes, as `ApiModule` does for its controllers.
      configure(consumer: MiddlewareConsumer) {
        consumer
          .apply(AuthMiddleware)
          .forRoutes(SessionsController, ProbeController);
      }
    }
    app = await NestFactory.create(AppModule, { logger: false });
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

  // Opens a session for the user as a sign-in does (`TokenService.issue`), from a device and an address, and returns the pair.
  const signIn = async (
    user: { id: string },
    deviceName = 'Pixel',
    ip = address()
  ) =>
    (await app
      .get(TokenService)
      .issue(user.id, {
        name: deviceName,
        userAgent: `agent-of-${deviceName}`,
        ip,
      })) as {
      access_token: string;
      refresh_token: string;
      session_id: string;
    };

  // A request to the sessions routes (or any route) carrying the pair's access token.
  const asDevice = (
    pair: { access_token: string },
    method: string,
    route: string,
    headers: Record<string, string> = {}
  ) =>
    call(method, route, {
      headers: { authorization: `Bearer ${pair.access_token}`, ...headers },
    });

  // The `impersonate` header value that makes a super admin act as the user: the user's membership row id.
  const impersonationOf = async (userId: string) =>
    (await worker.userOrganization.findFirstOrThrow({ where: { userId } })).id;

  // The failed refreshes the shared counter holds for an address.
  const refreshFailures = (ip: string) =>
    redis
      .get(`auth:fail:refresh:${ip}`)
      .then((value: string | null) => Number(value ?? 0));

  describe('GET /auth/sessions', () => {
    it('lists the user live sessions with their fields and marks only the calling one current', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel', '203.0.113.7');
      const laptop = await signIn(user, 'Laptop', '203.0.113.8');

      const res = await asDevice(phone, 'GET', '/auth/sessions');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      const mine = res.body.find((s: any) => s.id === phone.session_id);
      const other = res.body.find((s: any) => s.id === laptop.session_id);
      expect(mine).toMatchObject({
        id: phone.session_id,
        name: 'Pixel',
        userAgent: 'agent-of-Pixel',
        ip: '203.0.113.7',
        current: true,
      });
      expect(new Date(mine.createdAt).toString()).not.toBe('Invalid Date');
      expect(new Date(mine.lastSeenAt).toString()).not.toBe('Invalid Date');
      expect(other).toMatchObject({ name: 'Laptop', current: false });
    });

    it('marks the other device current when it is the one asking', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel');
      const laptop = await signIn(user, 'Laptop');

      const res = await asDevice(laptop, 'GET', '/auth/sessions');

      expect(
        res.body.filter((s: any) => s.current).map((s: any) => s.id)
      ).toEqual([laptop.session_id]);
      expect(res.body.map((s: any) => s.id)).toContain(phone.session_id);
    });

    it('orders by latest activity, newest first', async () => {
      const { user } = await newUser();
      const a = await signIn(user, 'A');
      const b = await signIn(user, 'B');
      const c = await signIn(user, 'C');
      // The moment this many minutes before now.
      const at = (minutesAgo: number) =>
        new Date(Date.now() - minutesAgo * 60 * 1000);
      await worker.deviceSession.update({
        where: { id: a.session_id },
        data: { lastSeenAt: at(1) },
      });
      await worker.deviceSession.update({
        where: { id: b.session_id },
        data: { lastSeenAt: at(30) },
      });
      await worker.deviceSession.update({
        where: { id: c.session_id },
        data: { lastSeenAt: at(10) },
      });

      const res = await asDevice(a, 'GET', '/auth/sessions');

      expect(res.body.map((s: any) => s.id)).toEqual([
        a.session_id,
        c.session_id,
        b.session_id,
      ]);
    });

    it('never lists a revoked session, and never another user session', async () => {
      const { user } = await newUser();
      const { user: stranger } = await newUser();
      const phone = await signIn(user, 'Pixel');
      const gone = await signIn(user, 'Gone');
      const strangers = await signIn(stranger, 'Stranger');
      await worker.deviceSession.update({
        where: { id: gone.session_id },
        data: { revokedAt: new Date() },
      });

      const res = await asDevice(phone, 'GET', '/auth/sessions');

      expect(res.body.map((s: any) => s.id)).toEqual([phone.session_id]);
      expect(res.text).not.toContain(strangers.session_id);
    });

    it('answers no secret: no refresh hash and no token appears', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel');

      const res = await asDevice(phone, 'GET', '/auth/sessions');

      expect(res.text).not.toMatch(/refreshHash|previousRefreshHash/);
      expect(res.text).not.toContain(phone.refresh_token);
      expect(res.text).not.toContain(phone.access_token);
    });

    it('is refused without a session', async () => {
      const res = await call('GET', '/auth/sessions');

      expect(res.status).toBe(401);
    });

    it('ignores x-postiz-org', async () => {
      const { user } = await newUser();
      const { orgId: otherOrg } = await newUser();
      const phone = await signIn(user, 'Pixel');

      const res = await asDevice(phone, 'GET', '/auth/sessions', {
        'x-postiz-org': otherOrg,
      });

      expect(res.status).toBe(200);
      expect(res.body.map((s: any) => s.id)).toEqual([phone.session_id]);
    });

    it('lists the signed-in admin devices, not the impersonated user, while a super admin impersonates', async () => {
      const { user: admin } = await newUser({ isSuperAdmin: true });
      const { user: target } = await newUser();
      const adminDevice = await signIn(admin, 'Admin laptop');
      await signIn(target, 'Target phone');

      const impersonate = await impersonationOf(target.id);
      const acting = await asDevice(adminDevice, 'GET', '/probe/me', {
        impersonate,
      });
      expect(acting.body.userId).toBe(target.id);

      const res = await asDevice(adminDevice, 'GET', '/auth/sessions', {
        impersonate,
      });

      expect(res.status).toBe(200);
      expect(res.body.map((s: any) => s.id)).toEqual([adminDevice.session_id]);
    });
  });

  describe('DELETE /auth/sessions/:id', () => {
    it('signs another device out: 204, and its access token then gets 401 SESSION_REVOKED', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel');
      const laptop = await signIn(user, 'Laptop');
      expect((await asDevice(laptop, 'GET', '/probe/me')).status).toBe(200);

      const res = await asDevice(
        phone,
        'DELETE',
        `/auth/sessions/${laptop.session_id}`
      );

      expect(res.status).toBe(204);
      const after = await asDevice(laptop, 'GET', '/probe/me');
      expect(after.status).toBe(401);
      expect(after.body).toMatchObject({ code: 'SESSION_REVOKED' });
    });

    it('leaves the calling device and every other device signed in, and signs nobody out of the browser', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel');
      const laptop = await signIn(user, 'Laptop');
      const tablet = await signIn(user, 'Tablet');

      const res = await asDevice(
        phone,
        'DELETE',
        `/auth/sessions/${laptop.session_id}`
      );

      expect(res.headers.get('logout')).toBeNull();
      expect((await asDevice(phone, 'GET', '/probe/me')).status).toBe(200);
      expect((await asDevice(tablet, 'GET', '/probe/me')).status).toBe(200);
      const list = await asDevice(phone, 'GET', '/auth/sessions');
      expect(list.body.map((s: any) => s.id).sort()).toEqual(
        [phone.session_id, tablet.session_id].sort()
      );
    });

    it('makes the revoked device refresh token get 401 INVALID_GRANT and count as a refresh failure', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel');
      const laptop = await signIn(user, 'Laptop');
      await asDevice(phone, 'DELETE', `/auth/sessions/${laptop.session_id}`);
      const ip = address();

      const res = await call('POST', '/auth/token', {
        ip,
        body: { grant_type: 'refresh_token', refresh_token: laptop.refresh_token },
      });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'INVALID_GRANT' });
      expect(await refreshFailures(ip)).toBe(1);
    });

    it('signs the calling device out when it names itself: 204, the logout header, cleared cookies', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel');

      const res = await asDevice(
        phone,
        'DELETE',
        `/auth/sessions/${phone.session_id}`
      );

      expect(res.status).toBe(204);
      expect(res.headers.get('logout')).toBe('true');
      const cookies = res.headers.getSetCookie().join(';');
      expect(cookies).toMatch(/auth=;/);
      expect(cookies).toMatch(/refresh=;/);
      const after = await asDevice(phone, 'GET', '/probe/me');
      expect(after.status).toBe(401);
      expect(after.body).toMatchObject({ code: 'SESSION_REVOKED' });
    });

    it("answers 404 for another user's session and leaves that session working", async () => {
      const { user } = await newUser();
      const { user: stranger } = await newUser();
      const phone = await signIn(user, 'Pixel');
      const strangers = await signIn(stranger, 'Stranger');

      const res = await asDevice(
        phone,
        'DELETE',
        `/auth/sessions/${strangers.session_id}`
      );

      expect(res.status).toBe(404);
      expect(res.text).not.toContain(strangers.session_id);
      expect((await asDevice(strangers, 'GET', '/probe/me')).status).toBe(200);
    });

    it('answers the same 404 for an unknown id as for another user session', async () => {
      const { user } = await newUser();
      const { user: stranger } = await newUser();
      const phone = await signIn(user, 'Pixel');
      const strangers = await signIn(stranger, 'Stranger');

      const foreign = await asDevice(
        phone,
        'DELETE',
        `/auth/sessions/${strangers.session_id}`
      );
      const unknown = await asDevice(
        phone,
        'DELETE',
        `/auth/sessions/${randomUUID()}`
      );

      expect(unknown.status).toBe(404);
      expect(unknown.text).toBe(foreign.text);
    });

    it('answers 404 for a session of the user that is already signed out', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel');
      const laptop = await signIn(user, 'Laptop');
      await asDevice(phone, 'DELETE', `/auth/sessions/${laptop.session_id}`);

      const again = await asDevice(
        phone,
        'DELETE',
        `/auth/sessions/${laptop.session_id}`
      );

      expect(again.status).toBe(404);
    });

    it('signs the admin devices out, never the impersonated user, while a super admin impersonates', async () => {
      const { user: admin } = await newUser({ isSuperAdmin: true });
      const { user: target } = await newUser();
      const adminDevice = await signIn(admin, 'Admin laptop');
      const targetDevice = await signIn(target, 'Target phone');

      const impersonate = await impersonationOf(target.id);

      const res = await asDevice(
        adminDevice,
        'DELETE',
        `/auth/sessions/${targetDevice.session_id}`,
        { impersonate }
      );

      expect(res.status).toBe(404);
      expect((await asDevice(targetDevice, 'GET', '/probe/me')).status).toBe(200);
    });

    it('is refused without a session', async () => {
      const res = await call('DELETE', `/auth/sessions/${randomUUID()}`);

      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /auth/sessions', () => {
    it('with except=current signs every other device out and keeps the calling one', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel');
      const laptop = await signIn(user, 'Laptop');
      const tablet = await signIn(user, 'Tablet');

      const res = await asDevice(
        phone,
        'DELETE',
        '/auth/sessions?except=current'
      );

      expect(res.status).toBe(204);
      expect(res.headers.get('logout')).toBeNull();
      expect((await asDevice(phone, 'GET', '/probe/me')).status).toBe(200);
      for (const gone of [laptop, tablet]) {
        const after = await asDevice(gone, 'GET', '/probe/me');
        expect(after.status).toBe(401);
        expect(after.body).toMatchObject({ code: 'SESSION_REVOKED' });
      }
      const list = await asDevice(phone, 'GET', '/auth/sessions');
      expect(list.body.map((s: any) => s.id)).toEqual([phone.session_id]);
    });

    it('with except=current touches no other user session', async () => {
      const { user } = await newUser();
      const { user: stranger } = await newUser();
      const phone = await signIn(user, 'Pixel');
      await signIn(user, 'Laptop');
      const strangers = await signIn(stranger, 'Stranger');

      await asDevice(phone, 'DELETE', '/auth/sessions?except=current');

      expect((await asDevice(strangers, 'GET', '/probe/me')).status).toBe(200);
    });

    it('with except=current and no other device answers 204 and changes nothing', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel');

      const res = await asDevice(
        phone,
        'DELETE',
        '/auth/sessions?except=current'
      );

      expect(res.status).toBe(204);
      expect((await asDevice(phone, 'GET', '/probe/me')).status).toBe(200);
    });

    it('without except signs every device out, the calling one too, and logs the tab out', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel');
      const laptop = await signIn(user, 'Laptop');

      const res = await asDevice(phone, 'DELETE', '/auth/sessions');

      expect(res.status).toBe(204);
      expect(res.headers.get('logout')).toBe('true');
      for (const gone of [phone, laptop]) {
        expect((await asDevice(gone, 'GET', '/probe/me')).status).toBe(401);
      }
    });

    it('refuses any except value other than current with 400 and signs nobody out', async () => {
      const { user } = await newUser();
      const phone = await signIn(user, 'Pixel');
      const laptop = await signIn(user, 'Laptop');

      const res = await asDevice(phone, 'DELETE', '/auth/sessions?except=all');

      expect(res.status).toBe(400);
      expect((await asDevice(phone, 'GET', '/probe/me')).status).toBe(200);
      expect((await asDevice(laptop, 'GET', '/probe/me')).status).toBe(200);
    });

    it('is refused without a session', async () => {
      const res = await call('DELETE', '/auth/sessions?except=current');

      expect(res.status).toBe(401);
    });
  });
});

// Parses a source file given by its path under the repo root.
const sourceOf = (file: string) => {
  const full = path.resolve(__dirname, '../../../../../..', file);
  return ts.createSourceFile(
    full,
    fs.readFileSync(full, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
};

// The identifiers in a same-file array constant (`authenticatedController`).
const constantList = (file: string, name: string) => {
  const names: string[] = [];
  sourceOf(file).forEachChild((node) => {
    if (!ts.isVariableStatement(node)) {
      return;
    }
    for (const declaration of node.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer &&
        ts.isArrayLiteralExpression(declaration.initializer)
      ) {
        names.push(
          ...declaration.initializer.elements
            .filter(ts.isIdentifier)
            .map((e) => e.text)
        );
      }
    }
  });
  return names;
};

describe('device sessions registration', () => {
  it('ApiModule serves the sessions controller behind authentication, with the authenticated controllers', () => {
    expect(
      constantList('apps/backend/src/api/api.module.ts', 'authenticatedController')
    ).toContain('SessionsController');
  });
});
