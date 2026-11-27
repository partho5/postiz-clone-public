// api.token-auth: short-lived access tokens, rotating refresh tokens with a grace window,
// revocable device sessions, and a failed-attempt limit per client address. Runs the real token
// service, repository, grants service, limiter, `/auth/token` controller and `AuthMiddleware` in a
// real Nest app against a real Postgres and a real Redis. The service cases run on both database
// roles (the contract's access is "both"); the HTTP cases run on the API role, as the backend does.
// Only Google's ID-token check is a stand-in: it needs Google's network and keys.
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
import { PrismaClient, Provider } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
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

// Answers the middleware's request back, so a test sees what the middleware set.
@Controller('probe')
class ProbeController {
  // The ids the middleware resolved for the request, as the probe's answer.
  @Get('me')
  me(@Req() req: any) {
    return {
      userId: req.user?.id,
      orgId: req.org?.id,
      sessionId: req.sessionId,
      sessionUserId: req.sessionUserId,
    };
  }
}

// The hex SHA-256 of a string, as the repository stores a refresh token.
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

// Waits for the given number of milliseconds.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb('api.token-auth (Postgres, Redis)', () => {
  let worker: PrismaClient;
  let apiPrisma: PrismaService;
  let users: UsersService;
  let organizations: OrganizationService;
  let redis: any;
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
    'REFRESH_TOKEN_TTL_DAYS',
    'REFRESH_GRACE_SECONDS',
    'AUTH_FAIL_LIMIT',
    'AUTH_FAIL_WINDOW_SECONDS',
  ];

  beforeAll(async () => {
    for (const name of envNames) {
      saved[name] = process.env[name];
    }
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    process.env.JWT_SECRET = 'token-auth-spec-secret';
    process.env.FRONTEND_URL = 'http://localhost:4200';
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    process.env.YOUTUBE_CLIENT_ID = 'token-auth-spec-client';
    // empty, not deleted: Prisma loads the root .env into any variable that is unset
    process.env.NOT_SECURED = '';
    process.env.NEXT_PUBLIC_BACKEND_URL = '';
    apiPrisma = new PrismaService();
    await apiPrisma.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    redis = (
      await import('@gitroom/nestjs-libraries/redis/redis.service')
    ).ioRedis;

    const repo = new PrismaRepository<any>(apiPrisma);
    const organizationRepository = new OrganizationRepository(repo, repo, repo);
    const notifications = {
      // Reports no email provider.
      hasEmailProvider: () => false,
    } as any;
    const accounts = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    organizations = new OrganizationService(
      organizationRepository,
      notifications,
      accounts
    );
    users = new UsersService(
      new UsersRepository(repo, new PrismaTransaction(apiPrisma)),
      organizationRepository,
      {} as any,
      notifications
    );
  });

  afterAll(async () => {
    for (const name of envNames) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    await apiPrisma.$disconnect();
    await worker.$disconnect();
    await redis.quit();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ACCESS_TOKEN_TTL_SECONDS;
    delete process.env.REFRESH_TOKEN_TTL_DAYS;
    delete process.env.REFRESH_GRACE_SECONDS;
    delete process.env.AUTH_FAIL_LIMIT;
    delete process.env.AUTH_FAIL_WINDOW_SECONDS;
  });

  // A unique email address for a new user.
  const email = () => randomUUID() + '@test.local';
  // A client address of its own, so the limiter's counts never leak between tests
  const address = () =>
    `10.${Math.floor(Math.random() * 250)}.${Math.floor(
      Math.random() * 250
    )}.${Math.floor(Math.random() * 250)}`;

  // An activated Google-account user (no password exists) who is the only member of a workspace of their own.
  const newUser = async (overrides: Record<string, unknown> = {}) => {
    const user = await worker.user.create({
      data: {
        email: email(),
        providerName: Provider.GOOGLE,
        providerId: 'g-' + randomUUID(),
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

  // The stored row of a session.
  const rowOf = (id: string) =>
    worker.deviceSession.findUniqueOrThrow({ where: { id } });

  // The user of a pair's access token, decoded without checking it.
  const claimsOf = (accessToken: string) =>
    JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')
    );

  describe.each([
    ['API role', () => process.env.TEST_DATABASE_API_URL!],
    ['worker role', () => url!],
  ])('TokenService (%s)', (_role, databaseUrl) => {
    let service: TokenService;
    let prisma: PrismaService;

    beforeAll(async () => {
      const previous = process.env.DATABASE_URL;
      process.env.DATABASE_URL = databaseUrl();
      prisma = new PrismaService();
      await prisma.$connect();
      process.env.DATABASE_URL = previous;
      service = new TokenService(
        new DeviceSessionsRepository(new PrismaRepository<any>(prisma))
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    const device = { name: 'Pixel', userAgent: 'jest-agent', ip: '10.9.9.9' };

    // Makes the stored rotation time `seconds` old, as if that long had passed.
    const ageRotation = (id: string, seconds: number) =>
      worker.deviceSession.update({
        where: { id },
        data: { rotatedAt: new Date(Date.now() - seconds * 1000) },
      });

    it('issue returns a bearer pair whose access token names the user and the session', async () => {
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);

      expect(pair.token_type).toBe('Bearer');
      expect(pair.expires_in).toBe(900);
      expect(typeof pair.refresh_token).toBe('string');
      const claims = claimsOf(pair.access_token);
      expect(claims.sub).toBe(user.id);
      expect(claims.sid).toBe(pair.session_id);
      expect(claims.exp - claims.iat).toBe(900);
      expect(await service.verifyAccess(pair.access_token)).toEqual({
        userId: user.id,
        sessionId: pair.session_id,
      });
    });

    it('stores the refresh token only as a hash, with the device it came from', async () => {
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);
      const row = await rowOf(pair.session_id);

      expect(JSON.stringify(row)).not.toContain(pair.refresh_token);
      expect(JSON.stringify(row)).not.toContain(pair.access_token);
      expect(row.refreshHash).toBe(sha256(pair.refresh_token));
      expect(row).toMatchObject({
        userId: user.id,
        name: 'Pixel',
        userAgent: 'jest-agent',
        ip: '10.9.9.9',
        revokedAt: null,
        previousRefreshHash: null,
      });
    });

    it('the refresh lifetime defaults to 36500 days (a 100-year session) when REFRESH_TOKEN_TTL_DAYS is unset', async () => {
      delete process.env.REFRESH_TOKEN_TTL_DAYS;
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);
      const row = await rowOf(pair.session_id);
      const days =
        (row.refreshExpiresAt.getTime() - row.createdAt.getTime()) /
        (24 * 3600 * 1000);
      expect(days).toBeCloseTo(36500, 1);
    });

    it('takes the lifetimes from ACCESS_TOKEN_TTL_SECONDS and REFRESH_TOKEN_TTL_DAYS', async () => {
      process.env.ACCESS_TOKEN_TTL_SECONDS = '120';
      process.env.REFRESH_TOKEN_TTL_DAYS = '2';
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);
      const row = await rowOf(pair.session_id);

      expect(pair.expires_in).toBe(120);
      const claims = claimsOf(pair.access_token);
      expect(claims.exp - claims.iat).toBe(120);
      const days =
        (row.refreshExpiresAt.getTime() - row.createdAt.getTime()) /
        (24 * 3600 * 1000);
      expect(days).toBeCloseTo(2, 2);
    });

    it('refuses a malformed lifetime setting instead of guessing', async () => {
      process.env.ACCESS_TOKEN_TTL_SECONDS = 'soon';
      const { user } = await newUser();
      await expect(service.issue(user.id, device)).rejects.toThrow(
        'ACCESS_TOKEN_TTL_SECONDS'
      );
    });

    it('refresh rotates: a new pair for the same session, and the new token works in turn', async () => {
      const { user } = await newUser();
      const first = await service.issue(user.id, device);
      const second = await service.refresh(first.refresh_token, {});
      const third = await service.refresh(second.refresh_token, {});

      expect(second.session_id).toBe(first.session_id);
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(third.refresh_token).not.toBe(second.refresh_token);
      expect(await service.verifyAccess(third.access_token)).toEqual({
        userId: user.id,
        sessionId: first.session_id,
      });
      const row = await rowOf(first.session_id);
      expect(row.refreshHash).toBe(sha256(third.refresh_token));
      expect(row.previousRefreshHash).toBe(sha256(second.refresh_token));
    });

    it('a refresh slides the refresh lifetime forward', async () => {
      const { user } = await newUser();
      const first = await service.issue(user.id, device);
      await worker.deviceSession.update({
        where: { id: first.session_id },
        data: { refreshExpiresAt: new Date(Date.now() + 60 * 1000) },
      });
      await service.refresh(first.refresh_token, {});
      const row = await rowOf(first.session_id);
      expect(row.refreshExpiresAt.getTime()).toBeGreaterThan(
        Date.now() + 36499 * 24 * 3600 * 1000
      );
    });

    it('the previous token presented again within the grace window returns the same new pair', async () => {
      const { user } = await newUser();
      const first = await service.issue(user.id, device);
      const second = await service.refresh(first.refresh_token, {});
      const again = await service.refresh(first.refresh_token, {});

      expect(again).toEqual(second);
      // the reply that was lost was not the end of the session
      const next = await service.refresh(again.refresh_token, {});
      expect(next.session_id).toBe(first.session_id);
    });

    it('concurrent refreshes with the same token all get the same new pair', async () => {
      const { user } = await newUser();
      const first = await service.issue(user.id, device);
      const pairs = await Promise.all(
        Array.from({ length: 8 }, () =>
          service.refresh(first.refresh_token, {})
        )
      );

      expect(new Set(pairs.map((pair) => pair.refresh_token)).size).toBe(1);
      expect(new Set(pairs.map((pair) => pair.access_token)).size).toBe(1);
      expect(pairs[0].refresh_token).not.toBe(first.refresh_token);
    });

    it('the previous token after the grace window revokes the session (reuse detection)', async () => {
      const { user } = await newUser();
      const first = await service.issue(user.id, device);
      const second = await service.refresh(first.refresh_token, {});
      await ageRotation(first.session_id, 61);

      await expect(service.refresh(first.refresh_token, {})).rejects.toMatchObject(
        { status: 401, response: { code: 'INVALID_GRANT' } }
      );
      expect((await rowOf(first.session_id)).revokedAt).not.toBeNull();
      // the thief's and the owner's tokens are both dead
      await expect(service.refresh(second.refresh_token, {})).rejects.toMatchObject(
        { response: { code: 'INVALID_GRANT' } }
      );
      await expect(service.verifyAccess(second.access_token)).rejects.toMatchObject(
        { status: 401, response: { code: 'SESSION_REVOKED' } }
      );
    });

    it('REFRESH_GRACE_SECONDS sets the window', async () => {
      process.env.REFRESH_GRACE_SECONDS = '5';
      const { user } = await newUser();
      const first = await service.issue(user.id, device);
      const second = await service.refresh(first.refresh_token, {});
      await ageRotation(first.session_id, 4);
      const again = await service.refresh(first.refresh_token, {});
      expect(again.refresh_token).toBe(second.refresh_token);
      expect(again.session_id).toBe(second.session_id);
      await ageRotation(first.session_id, 6);
      await expect(service.refresh(first.refresh_token, {})).rejects.toMatchObject(
        { response: { code: 'INVALID_GRANT' } }
      );
    });

    it('any token older than the previous one revokes the session', async () => {
      const { user } = await newUser();
      const first = await service.issue(user.id, device);
      const second = await service.refresh(first.refresh_token, {});
      const third = await service.refresh(second.refresh_token, {});

      await expect(service.refresh(first.refresh_token, {})).rejects.toMatchObject(
        { response: { code: 'INVALID_GRANT' } }
      );
      expect((await rowOf(first.session_id)).revokedAt).not.toBeNull();
      await expect(service.refresh(third.refresh_token, {})).rejects.toMatchObject(
        { response: { code: 'INVALID_GRANT' } }
      );
    });

    it.each([
      ['an unknown session', () => `${randomUUID()}.${'a'.repeat(43)}`],
      ['a malformed token', () => 'not-a-token'],
      ['an empty token', () => ''],
      ['a token that is only a dot', () => '.'],
    ])('refresh with %s is INVALID_GRANT', async (_name, token) => {
      await expect(service.refresh(token(), {})).rejects.toMatchObject({
        status: 401,
        response: { statusCode: 401, code: 'INVALID_GRANT' },
      });
    });

    it('refresh with the right session id and a wrong secret is INVALID_GRANT and ends the session', async () => {
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);
      await expect(
        service.refresh(`${pair.session_id}.${'b'.repeat(43)}`, {})
      ).rejects.toMatchObject({ response: { code: 'INVALID_GRANT' } });
      expect((await rowOf(pair.session_id)).revokedAt).not.toBeNull();
    });

    it('refresh past the refresh lifetime is INVALID_GRANT', async () => {
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);
      await worker.deviceSession.update({
        where: { id: pair.session_id },
        data: { refreshExpiresAt: new Date(Date.now() - 1000) },
      });
      await expect(service.refresh(pair.refresh_token, {})).rejects.toMatchObject(
        { response: { code: 'INVALID_GRANT' } }
      );
    });

    it('refresh for a deactivated user is INVALID_GRANT', async () => {
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);
      await worker.user.update({
        where: { id: user.id },
        data: { activated: false },
      });
      await expect(service.refresh(pair.refresh_token, {})).rejects.toMatchObject(
        { response: { code: 'INVALID_GRANT' } }
      );
    });

    it('refresh records the device that refreshed', async () => {
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);
      await service.refresh(pair.refresh_token, {
        userAgent: 'new-agent',
        ip: '10.8.8.8',
      });
      expect(await rowOf(pair.session_id)).toMatchObject({
        userAgent: 'new-agent',
        ip: '10.8.8.8',
      });
    });

    it('verifyAccess answers TOKEN_EXPIRED for an access token past its expiry', async () => {
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);
      const past = Math.floor(Date.now() / 1000) - 10;
      const expired = AuthService.signJWT({
        sub: user.id,
        sid: pair.session_id,
        iat: past - 900,
        exp: past,
      });
      await expect(service.verifyAccess(expired)).rejects.toMatchObject({
        status: 401,
        response: { statusCode: 401, code: 'TOKEN_EXPIRED' },
      });
    });

    it('verifyAccess refuses upstream’s one-year token, which has no session id', async () => {
      const { user } = await newUser();
      await expect(
        service.verifyAccess(AuthService.signJWT({ ...user, id: user.id }))
      ).rejects.toMatchObject({ status: 403 });
    });

    it.each([
      ['a token signed with another secret', () =>
        require('jsonwebtoken').sign({ sub: 'x', sid: 'y' }, 'other-secret')],
      ['a token that is not a JWT', () => 'garbage'],
    ])('verifyAccess refuses %s', async (_name, token) => {
      await expect(service.verifyAccess(token())).rejects.toMatchObject({
        status: 403,
      });
    });

    it('verifyAccess refuses a token whose session belongs to another user or does not exist', async () => {
      const { user } = await newUser();
      const { user: other } = await newUser();
      const pair = await service.issue(user.id, device);
      await expect(
        service.verifyAccess(
          AuthService.signJWT({ sub: other.id, sid: pair.session_id })
        )
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.verifyAccess(
          AuthService.signJWT({ sub: user.id, sid: randomUUID() })
        )
      ).rejects.toMatchObject({ status: 403 });
    });

    it('a revoked session answers SESSION_REVOKED whatever its access token’s expiry', async () => {
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);
      await service.revoke(pair.session_id, user.id);
      await expect(service.verifyAccess(pair.access_token)).rejects.toMatchObject(
        { status: 401, response: { statusCode: 401, code: 'SESSION_REVOKED' } }
      );
    });

    it('revoke ends only the caller’s own session', async () => {
      const { user } = await newUser();
      const { user: other } = await newUser();
      const pair = await service.issue(user.id, device);

      await service.revoke(pair.session_id, other.id);
      expect((await rowOf(pair.session_id)).revokedAt).toBeNull();
      await service.revoke(pair.session_id, user.id);
      expect((await rowOf(pair.session_id)).revokedAt).not.toBeNull();
      // already ended, or unknown: nothing to say
      await expect(service.revoke(pair.session_id, user.id)).resolves.toBeUndefined();
      await expect(service.revoke(randomUUID(), user.id)).resolves.toBeUndefined();
    });

    it('revokeRefreshToken ends the session for the current and for the previous token, and says nothing either way', async () => {
      const { user } = await newUser();
      const a = await service.issue(user.id, device);
      await expect(service.revokeRefreshToken(a.refresh_token)).resolves.toBeUndefined();
      expect((await rowOf(a.session_id)).revokedAt).not.toBeNull();

      const b = await service.issue(user.id, device);
      await service.refresh(b.refresh_token, {});
      await service.revokeRefreshToken(b.refresh_token);
      expect((await rowOf(b.session_id)).revokedAt).not.toBeNull();
    });

    it.each([
      ['a token older than the previous one', 3],
      ['a wrong secret', 0],
    ])('revokeRefreshToken with %s leaves the session alone', async (_name, rotations) => {
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);
      let current = pair;
      const old = pair.refresh_token;
      for (let i = 0; i < rotations; i++) {
        current = await service.refresh(current.refresh_token, {});
      }
      const presented =
        rotations === 0 ? `${pair.session_id}.${'c'.repeat(43)}` : old;
      await expect(service.revokeRefreshToken(presented)).resolves.toBeUndefined();
      expect((await rowOf(pair.session_id)).revokedAt).toBeNull();
    });

    it.each(['', 'garbage', '.', `${randomUUID()}.xxxx`])(
      'revokeRefreshToken with %j does nothing and does not throw',
      async (token) => {
        await expect(service.revokeRefreshToken(token)).resolves.toBeUndefined();
      }
    );

    it('listSessions returns the user’s own live sessions, newest activity first, as views', async () => {
      const { user } = await newUser();
      const { user: other } = await newUser();
      const oldest = await service.issue(user.id, { name: 'old' });
      const revoked = await service.issue(user.id, { name: 'gone' });
      const newest = await service.issue(user.id, { name: 'new' });
      await service.issue(other.id, { name: 'not mine' });
      await service.revoke(revoked.session_id, user.id);
      await worker.deviceSession.update({
        where: { id: oldest.session_id },
        data: { lastSeenAt: new Date(Date.now() - 3600 * 1000) },
      });

      const sessions = await service.listSessions(user.id);
      expect(sessions.map((session) => session.id)).toEqual([
        newest.session_id,
        oldest.session_id,
      ]);
      expect(Object.keys(sessions[0]).sort()).toEqual(
        ['createdAt', 'id', 'ip', 'lastSeenAt', 'name', 'userAgent'].sort()
      );
      expect(typeof sessions[0].createdAt).toBe('string');
      expect(new Date(sessions[0].lastSeenAt).toISOString()).toBe(
        sessions[0].lastSeenAt
      );
      expect(JSON.stringify(sessions)).not.toMatch(/refresh|hash/i);
    });

    it('verifyAccess keeps the session’s last-seen time current', async () => {
      const { user } = await newUser();
      const pair = await service.issue(user.id, device);
      await worker.deviceSession.update({
        where: { id: pair.session_id },
        data: { lastSeenAt: new Date(Date.now() - 3600 * 1000) },
      });
      await service.verifyAccess(pair.access_token);
      expect(
        Date.now() - (await rowOf(pair.session_id)).lastSeenAt.getTime()
      ).toBeLessThan(10 * 1000);
    });

    it('never writes a token or a refresh secret to a log', async () => {
      const written: string[] = [];
      for (const stream of [process.stdout, process.stderr]) {
        jest
          .spyOn(stream, 'write')
          .mockImplementation(((chunk: unknown) => {
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
      const first = await service.issue(user.id, device);
      const second = await service.refresh(first.refresh_token, {});
      await service.refresh(first.refresh_token, {}).catch(() => undefined);
      await service.verifyAccess(second.access_token);
      await service.revokeRefreshToken(second.refresh_token);
      await service.refresh(second.refresh_token, {}).catch(() => undefined);

      const output = written.join('\n');
      for (const secret of [
        first.refresh_token,
        second.refresh_token,
        first.access_token,
        second.access_token,
      ]) {
        expect(output).not.toContain(secret);
      }
    });
  });

  describe('the token endpoint and the middleware over HTTP', () => {
    let app: any;
    let base: string;
    let tokens: TokenService;
    let grants: TokenGrantsService;

    beforeAll(async () => {
      // The app under test: the token controller, the probe route and the real middleware.
      @Module({
        controllers: [AuthTokenController, ProbeController],
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
            useValue: new DeviceSessionsRepository(
              new PrismaRepository<any>(apiPrisma)
            ),
          },
          { provide: UsersService, useValue: users },
          { provide: OrganizationService, useValue: organizations },
        ],
      })
      class AppModule implements NestModule {
        // Puts AuthMiddleware on the probe route only.
        configure(consumer: MiddlewareConsumer) {
          consumer.apply(AuthMiddleware).forRoutes(ProbeController);
        }
      }
      app = await NestFactory.create(AppModule, { logger: false });
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ transform: true }));
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.listen(0);
      base = await app.getUrl();
      tokens = app.get(TokenService);
      grants = app.get(TokenGrantsService);
    });

    afterAll(async () => {
      await app.close();
    });

    // One request to the app; the answer with its parsed body and every Set-Cookie line.
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
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        cookies: res.headers.getSetCookie(),
        text,
        body: text ? JSON.parse(text) : undefined,
      };
    };

    // Makes Google's ID-token check answer, for a token written `token-of:<providerId>`, that the
    // Google account with that id signed it (the check itself needs Google's network and keys).
    beforeEach(() => {
      jest
        .spyOn((grants as any)._google, 'verifyIdToken')
        .mockImplementation((async ({ idToken }: { idToken: string }) => ({
          // The claims Google's check returns for a verified account.
          getPayload: () => ({
            sub: idToken.replace('token-of:', ''),
            email_verified: true,
          }),
        })) as any);
    });

    // A Google ID-token grant for the user from an address, with extra body fields.
    const signIn = (
      user: { providerId: string | null },
      ip?: string,
      extra: Record<string, unknown> = {}
    ) =>
      call('POST', '/auth/token', {
        ip,
        body: {
          grant_type: 'google_id_token',
          id_token: `token-of:${user.providerId}`,
          ...extra,
        },
      });

    // The Set-Cookie line for one cookie name, if the response set it.
    const cookie = (cookies: string[], name: string) =>
      cookies.find((line) => line.startsWith(name + '='));

    // The failed attempts the shared counter holds for an address and a kind of attempt.
    const failures = (ip: string, kind: string) =>
      redis.get(`auth:fail:${kind}:${ip}`).then((value: string | null) =>
        Number(value ?? 0)
      );

    describe('POST /auth/token', () => {
      it('google_id_token grant answers 200 with a token pair and sets the auth and refresh cookies', async () => {
        const { user } = await newUser();
        const res = await signIn(user, undefined, { device_name: 'Laptop' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          token_type: 'Bearer',
          expires_in: 900,
        });
        expect(Object.keys(res.body).sort()).toEqual(
          ['access_token', 'expires_in', 'refresh_token', 'session_id', 'token_type'].sort()
        );
        const auth = cookie(res.cookies, 'auth')!;
        const refresh = cookie(res.cookies, 'refresh')!;
        expect(auth).toContain(`auth=${res.body.access_token}`);
        expect(refresh).toContain(`refresh=${res.body.refresh_token}`);
        for (const line of [auth, refresh]) {
          expect(line).toMatch(/HttpOnly/i);
          expect(line).toMatch(/Secure/i);
        }
        expect(refresh).toMatch(/Path=\/auth\/token(;|$)/);
        expect(auth).not.toMatch(/Path=\/auth\/token/);
        expect((await rowOf(res.body.session_id)).name).toBe('Laptop');
      });

      it('the refresh cookie path follows the path the backend is reached at', async () => {
        process.env.NEXT_PUBLIC_BACKEND_URL = 'https://example.test/api/';
        try {
          const { user } = await newUser();
          const res = await signIn(user);
          expect(cookie(res.cookies, 'refresh')).toMatch(
            /Path=\/api\/auth\/token(;|$)/
          );
        } finally {
          process.env.NEXT_PUBLIC_BACKEND_URL = '';
        }
      });

      it('NOT_SECURED mode keeps the existing header behaviour: the access token in the auth header, no httpOnly', async () => {
        process.env.NOT_SECURED = 'true';
        try {
          const { user } = await newUser();
          const res = await signIn(user);
          expect(res.headers.get('auth')).toBe(res.body.access_token);
          expect(cookie(res.cookies, 'auth')).not.toMatch(/HttpOnly/i);
        } finally {
          process.env.NOT_SECURED = '';
        }
      });

      it('the session cookies live as long as the refresh lifetime, 36500 days by default, so the web session is permanent', async () => {
        delete process.env.REFRESH_TOKEN_TTL_DAYS;
        const { user } = await newUser();
        const res = await signIn(user);
        for (const name of ['auth', 'refresh']) {
          const expires = new Date(
            /Expires=([^;]+)/i.exec(cookie(res.cookies, name)!)![1]
          ).getTime();
          expect(
            (expires - Date.now()) / (24 * 3600 * 1000)
          ).toBeGreaterThan(36499);
        }
        const refreshed = await call('POST', '/auth/token', {
          body: { grant_type: 'refresh_token', refresh_token: res.body.refresh_token },
        });
        const renewed = new Date(
          /Expires=([^;]+)/i.exec(cookie(refreshed.cookies, 'refresh')!)![1]
        ).getTime();
        expect((renewed - Date.now()) / (24 * 3600 * 1000)).toBeGreaterThan(36499);
      });

      it('answers the same 401 INVALID_GRANT body for an account that has not signed up and an inactive account', async () => {
        const { user } = await newUser();
        const { user: inactive } = await newUser({ activated: false });
        const answers = await Promise.all([
          call('POST', '/auth/token', {
            body: {
              grant_type: 'google_id_token',
              id_token: 'token-of:never-signed-up-' + randomUUID(),
            },
          }),
          signIn(inactive),
        ]);
        for (const answer of answers) {
          expect(answer.status).toBe(401);
          expect(answer.body).toEqual({ statusCode: 401, code: 'INVALID_GRANT' });
          expect(answer.text).not.toContain(user.email);
        }
      });

      it.each([
        ['an unknown grant type', { grant_type: 'client_credentials' }],
        ['a password grant (no password sign-in exists)', { grant_type: 'password', email: 'a@b.co', password: 'x' }],
        ['a password grant with no fields', { grant_type: 'password' }],
        ['a google grant with no id_token', { grant_type: 'google_id_token' }],
        ['an empty body', {}],
      ])('rejects %s with 400', async (_name, body) => {
        const res = await call('POST', '/auth/token', { body });
        expect(res.status).toBe(400);
      });

      it('google_id_token signs in a user whose Google account already signed up', async () => {
        const providerId = 'g-' + randomUUID();
        const { user } = await newUser({
          password: null,
          providerName: Provider.GOOGLE,
          providerId,
        });
        jest
          .spyOn((grants as any)._google, 'verifyIdToken')
          .mockResolvedValue({
            // The claims Google's check returns for a token of the account that signed up.
            getPayload: () => ({ sub: providerId, email_verified: true }),
          } as any);
        const res = await call('POST', '/auth/token', {
          body: { grant_type: 'google_id_token', id_token: 'signed-by-google' },
        });
        expect(res.status).toBe(200);
        expect(claimsOf(res.body.access_token).sub).toBe(user.id);
        expect(
          (grants as any)._google.verifyIdToken
        ).toHaveBeenCalledWith({
          idToken: 'signed-by-google',
          audience: 'token-auth-spec-client',
        });
      });

      it('google_id_token for a Google account that has not signed up, an unverified email, or a bad token is INVALID_GRANT', async () => {
        const verify = jest.spyOn((grants as any)._google, 'verifyIdToken');
        // Posts a `google_id_token` grant and answers with the response.
        const answerFor = async () =>
          call('POST', '/auth/token', {
            body: { grant_type: 'google_id_token', id_token: 'whatever' },
          });

        verify.mockResolvedValue({
          // The claims Google's check returns for an account that never signed up.
          getPayload: () => ({ sub: 'never-signed-up-' + randomUUID(), email_verified: true }),
        } as any);
        const unknown = await answerFor();

        const providerId = 'g-' + randomUUID();
        await newUser({ password: null, providerName: Provider.GOOGLE, providerId });
        verify.mockResolvedValue({
          // The claims Google's check returns for an unverified email.
          getPayload: () => ({ sub: providerId, email_verified: false }),
        } as any);
        const unverified = await answerFor();

        verify.mockRejectedValue(new Error('Wrong number of segments'));
        const bad = await answerFor();

        for (const answer of [unknown, unverified, bad]) {
          expect(answer.status).toBe(401);
          expect(answer.body).toEqual({ statusCode: 401, code: 'INVALID_GRANT' });
        }
      });

      it('refresh_token grant works from the body and from the refresh cookie, and rotates', async () => {
        const { user } = await newUser();
        const first = (await signIn(user)).body;

        const viaBody = await call('POST', '/auth/token', {
          body: { grant_type: 'refresh_token', refresh_token: first.refresh_token },
        });
        expect(viaBody.status).toBe(200);
        expect(viaBody.body.session_id).toBe(first.session_id);
        expect(viaBody.body.refresh_token).not.toBe(first.refresh_token);
        expect(cookie(viaBody.cookies, 'refresh')).toContain(
          viaBody.body.refresh_token
        );

        const viaCookie = await call('POST', '/auth/token', {
          body: { grant_type: 'refresh_token' },
          headers: { cookie: `refresh=${viaBody.body.refresh_token}` },
        });
        expect(viaCookie.status).toBe(200);
        expect(viaCookie.body.refresh_token).not.toBe(viaBody.body.refresh_token);
      });

      it('a lost refresh reply is recovered: the same token again returns the same pair', async () => {
        const { user } = await newUser();
        const first = (await signIn(user)).body;
        const body = { grant_type: 'refresh_token', refresh_token: first.refresh_token };
        const one = await call('POST', '/auth/token', { body });
        const two = await call('POST', '/auth/token', { body });
        expect(two.status).toBe(200);
        expect(two.body).toEqual(one.body);
      });

      it('a failed refresh answers 401 INVALID_GRANT, clears both cookies and asks the client to log out', async () => {
        const res = await call('POST', '/auth/token', {
          body: { grant_type: 'refresh_token', refresh_token: 'nope' },
        });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ statusCode: 401, code: 'INVALID_GRANT' });
        expect(res.headers.get('logout')).toBe('true');
        expect(cookie(res.cookies, 'auth')).toMatch(/auth=;/);
        expect(cookie(res.cookies, 'refresh')).toMatch(/refresh=;/);
      });

      it('a refresh with no token anywhere is INVALID_GRANT', async () => {
        const res = await call('POST', '/auth/token', {
          body: { grant_type: 'refresh_token' },
        });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('INVALID_GRANT');
      });

      it('never puts a token or a submitted secret in an error answer', async () => {
        const res = await call('POST', '/auth/token', {
          body: { grant_type: 'password', email: email(), password: 'hunter2-secret' },
        });
        expect(res.status).toBe(400);
        expect(res.text).not.toContain('hunter2-secret');
        const refused = await call('POST', '/auth/token', {
          body: { grant_type: 'refresh_token', refresh_token: 'hunter2-secret' },
        });
        expect(refused.status).toBe(401);
        expect(refused.text).not.toContain('hunter2-secret');
      });
    });

    describe('POST /auth/token/revoke', () => {
      it('ends the session of the refresh token in the body, answers 204 and clears the cookies', async () => {
        const { user } = await newUser();
        const pair = (await signIn(user)).body;
        const res = await call('POST', '/auth/token/revoke', {
          body: { refresh_token: pair.refresh_token },
        });
        expect(res.status).toBe(204);
        expect(cookie(res.cookies, 'auth')).toMatch(/auth=;/);
        expect(cookie(res.cookies, 'refresh')).toMatch(/refresh=;/);
        expect((await rowOf(pair.session_id)).revokedAt).not.toBeNull();
      });

      it('takes the refresh token from the cookie when the body has none', async () => {
        const { user } = await newUser();
        const pair = (await signIn(user)).body;
        const res = await call('POST', '/auth/token/revoke', {
          body: {},
          headers: { cookie: `refresh=${pair.refresh_token}` },
        });
        expect(res.status).toBe(204);
        expect((await rowOf(pair.session_id)).revokedAt).not.toBeNull();
      });

      it('answers 204 for no token, an unknown token and a wrong secret alike, changing nothing', async () => {
        const { user } = await newUser();
        const pair = (await signIn(user)).body;
        for (const body of [
          {},
          { refresh_token: 'garbage' },
          { refresh_token: `${pair.session_id}.${'d'.repeat(43)}` },
        ]) {
          const res = await call('POST', '/auth/token/revoke', { body });
          expect(res.status).toBe(204);
          expect(res.text).toBe('');
        }
        expect((await rowOf(pair.session_id)).revokedAt).toBeNull();
      });
    });

    describe('AuthMiddleware', () => {
      // A pair for a fresh user, and the id of their workspace.
      const session = async () => {
        const made = await newUser();
        const pair = (await signIn(made.user)).body;
        return { ...made, pair };
      };

      it('accepts Authorization: Bearer, the auth header and the auth cookie, and sets the user, workspace and session', async () => {
        const { user, orgId, pair } = await session();
        for (const headers of [
          { authorization: `Bearer ${pair.access_token}` },
          { auth: pair.access_token },
          { cookie: `auth=${pair.access_token}` },
        ]) {
          const res = await call('GET', '/probe/me', { headers });
          expect(res.status).toBe(200);
          expect(res.body).toEqual({
            userId: user.id,
            orgId,
            sessionId: pair.session_id,
            sessionUserId: user.id,
          });
        }
      });

      it('while a super admin impersonates, the request is the impersonated user’s and the session is still the admin’s', async () => {
        const { user: admin, pair } = await (async () => {
          const made = await newUser({ isSuperAdmin: true });
          return { ...made, pair: (await signIn(made.user)).body };
        })();
        const { user: target, orgId: targetOrg } = await newUser();
        const membership = await worker.userOrganization.findFirstOrThrow({
          where: { userId: target.id, organizationId: targetOrg },
        });
        const res = await call('GET', '/probe/me', {
          headers: {
            authorization: `Bearer ${pair.access_token}`,
            impersonate: membership.id,
          },
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          userId: target.id,
          orgId: targetOrg,
          sessionId: pair.session_id,
          sessionUserId: admin.id,
        });
      });

      it('refuses a request with no token', async () => {
        const res = await call('GET', '/probe/me');
        expect(res.status).toBe(401);
      });

      it('refuses upstream’s one-year token, which has no session id', async () => {
        const { user } = await newUser();
        const res = await call('GET', '/probe/me', {
          headers: { auth: AuthService.signJWT({ ...user, id: user.id }) },
        });
        expect(res.status).toBe(401);
      });

      it('answers 401 TOKEN_EXPIRED for an expired access token, so the client can refresh', async () => {
        const { user, pair } = await session();
        const past = Math.floor(Date.now() / 1000) - 10;
        const expired = AuthService.signJWT({
          sub: user.id,
          sid: pair.session_id,
          iat: past - 900,
          exp: past,
        });
        const res = await call('GET', '/probe/me', {
          headers: { authorization: `Bearer ${expired}` },
        });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ statusCode: 401, code: 'TOKEN_EXPIRED' });
      });

      it('a revoked session gets 401 SESSION_REVOKED on its next request, and its cookies are cleared', async () => {
        const { user, pair } = await session();
        await tokens.revoke(pair.session_id, user.id);
        const res = await call('GET', '/probe/me', {
          headers: { authorization: `Bearer ${pair.access_token}` },
        });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ statusCode: 401, code: 'SESSION_REVOKED' });
        expect(res.headers.get('logout')).toBe('true');
        expect(cookie(res.cookies, 'auth')).toMatch(/auth=;/);
      });

      it('still runs the existing checks: SESSION_CHANGED for another user’s tab, WORKSPACE_FORBIDDEN for a workspace the user is not in', async () => {
        const { user, pair } = await session();
        const { user: other, orgId: otherOrg } = await newUser();
        const headers = { authorization: `Bearer ${pair.access_token}` };

        const changed = await call('GET', '/probe/me', {
          headers: { ...headers, 'x-session-user': other.id },
        });
        expect(changed.status).toBe(409);
        expect(changed.body.code).toBe('SESSION_CHANGED');

        const forbidden = await call('GET', '/probe/me', {
          headers: { ...headers, 'x-workspace-id': otherOrg },
        });
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.code).toBe('WORKSPACE_FORBIDDEN');

        const ok = await call('GET', '/probe/me', {
          headers: { ...headers, 'x-session-user': user.id },
        });
        expect(ok.status).toBe(200);
      });

      it('ignores x-postiz-org: a device token acts only in the workspace the existing checks resolve', async () => {
        const { user, orgId, pair } = await session();
        const second = await worker.organization.create({
          data: {
            name: 'ws-' + randomUUID(),
            users: { create: { role: 'ADMIN', userId: user.id } },
          },
        });
        const authorization = `Bearer ${pair.access_token}`;
        const baseline = await call('GET', '/probe/me', {
          headers: { authorization },
        });
        // The workspace the existing checks pick when no workspace is named.
        const defaultOrg = baseline.body.orgId;
        const named = defaultOrg === orgId ? second.id : orgId;

        const res = await call('GET', '/probe/me', {
          headers: { authorization, 'x-postiz-org': named },
        });
        expect(res.status).toBe(200);
        expect(res.body.orgId).toBe(defaultOrg);
        expect(res.body.orgId).not.toBe(named);

        const viaWorkspaceHeader = await call('GET', '/probe/me', {
          headers: { authorization, 'x-workspace-id': named },
        });
        expect(viaWorkspaceHeader.body.orgId).toBe(named);
      });
    });

    describe('failed-attempt limit', () => {
      // Posts a grant that cannot succeed (unknown account, or an unknown refresh token) from an address.
      const wrong = (ip: string, kind: 'sign_in' | 'refresh' = 'sign_in') =>
        call('POST', '/auth/token', {
          ip,
          body:
            kind === 'sign_in'
              ? {
                  grant_type: 'google_id_token',
                  id_token: 'token-of:never-signed-up-' + randomUUID(),
                }
              : { grant_type: 'refresh_token', refresh_token: 'nope' },
        });

      it('after AUTH_FAIL_LIMIT failed sign-ins the address gets 429 AUTH_RATE_LIMITED with Retry-After, even for a correct credential, which is not checked', async () => {
        process.env.AUTH_FAIL_LIMIT = '3';
        const { user } = await newUser();
        const ip = address();
        for (let i = 0; i < 3; i++) {
          expect((await wrong(ip)).status).toBe(401);
        }
        const sessionsBefore = await worker.deviceSession.count({
          where: { userId: user.id },
        });
        const limited = await signIn(user, ip);

        expect(limited.status).toBe(429);
        expect(limited.body).toEqual({ statusCode: 429, code: 'AUTH_RATE_LIMITED' });
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(900);
        expect(
          await worker.deviceSession.count({ where: { userId: user.id } })
        ).toBe(sessionsBefore);
        // a refused attempt is not a further failure
        expect(await failures(ip, 'sign_in')).toBe(3);
      });

      it('the answer is identical whether or not the account exists and never contains the credential', async () => {
        process.env.AUTH_FAIL_LIMIT = '1';
        const { user } = await newUser();
        const ip = address();
        await wrong(ip);
        const known = await signIn(user, ip);
        const unknown = await call('POST', '/auth/token', {
          ip,
          body: { grant_type: 'google_id_token', id_token: 'token-of:secret-guess' },
        });
        expect(known.status).toBe(429);
        expect(unknown.status).toBe(429);
        expect(known.body).toEqual(unknown.body);
        expect(unknown.text).not.toContain('secret-guess');
        expect(known.text).not.toContain(user.email);
      });

      it('counts per address: another address is unaffected', async () => {
        process.env.AUTH_FAIL_LIMIT = '2';
        const { user } = await newUser();
        const ip = address();
        await wrong(ip);
        await wrong(ip);
        expect((await wrong(ip)).status).toBe(429);
        expect((await signIn(user, address())).status).toBe(200);
      });

      it('counts per kind: sign-in failures do not limit refreshes, and refresh failures do not limit sign-ins', async () => {
        process.env.AUTH_FAIL_LIMIT = '2';
        const { user } = await newUser();
        const ip = address();
        await wrong(ip);
        await wrong(ip);
        expect((await wrong(ip)).status).toBe(429);
        const refreshAnswer = await wrong(ip, 'refresh');
        expect(refreshAnswer.status).toBe(401);

        const other = address();
        await wrong(other, 'refresh');
        await wrong(other, 'refresh');
        expect((await wrong(other, 'refresh')).status).toBe(429);
        expect((await signIn(user, other)).status).toBe(200);
      });

      it('only failures count: successful sign-ins and refreshes never limit the address', async () => {
        process.env.AUTH_FAIL_LIMIT = '2';
        const { user } = await newUser();
        const ip = address();
        let pair = (await signIn(user, ip)).body;
        for (let i = 0; i < 5; i++) {
          expect((await signIn(user, ip)).status).toBe(200);
          const refreshed = await call('POST', '/auth/token', {
            ip,
            body: { grant_type: 'refresh_token', refresh_token: pair.refresh_token },
          });
          expect(refreshed.status).toBe(200);
          pair = refreshed.body;
        }
        expect(await failures(ip, 'sign_in')).toBe(0);
        expect(await failures(ip, 'refresh')).toBe(0);
      });

      it('a reused refresh token counts as a refresh failure', async () => {
        process.env.AUTH_FAIL_LIMIT = '1';
        const { user } = await newUser();
        const ip = address();
        const first = (await signIn(user, ip)).body;
        const second = (
          await call('POST', '/auth/token', {
            ip,
            body: { grant_type: 'refresh_token', refresh_token: first.refresh_token },
          })
        ).body;
        await ageRotationOf(first.session_id);
        const reuse = await call('POST', '/auth/token', {
          ip,
          body: { grant_type: 'refresh_token', refresh_token: first.refresh_token },
        });
        expect(reuse.status).toBe(401);
        const limited = await call('POST', '/auth/token', {
          ip,
          body: { grant_type: 'refresh_token', refresh_token: second.refresh_token },
        });
        expect(limited.status).toBe(429);
      });

      it('a burst of parallel wrong attempts is stopped at the limit, not let through together', async () => {
        process.env.AUTH_FAIL_LIMIT = '3';
        const ip = address();
        const answers = await Promise.all(
          Array.from({ length: 25 }, () => wrong(ip))
        );
        expect(answers.filter((answer) => answer.status === 401)).toHaveLength(3);
        expect(answers.filter((answer) => answer.status === 429)).toHaveLength(22);
      });

      it('a parallel burst cannot guess past the limit even when the right credential is in it', async () => {
        process.env.AUTH_FAIL_LIMIT = '3';
        const { user } = await newUser();
        const ip = address();
        const attempts = [
          ...Array.from({ length: 3 }, () => wrong(ip)),
          signIn(user, ip),
        ];
        const answers = await Promise.all(attempts);
        expect(answers.filter((answer) => answer.status === 200).length).toBeLessThanOrEqual(1);
        const limit = (await failures(ip, 'sign_in')) <= 3;
        expect(limit).toBe(true);
      });

      it('the lock lasts AUTH_FAIL_WINDOW_SECONDS, then the address may try again', async () => {
        process.env.AUTH_FAIL_LIMIT = '1';
        process.env.AUTH_FAIL_WINDOW_SECONDS = '1';
        const { user } = await newUser();
        const ip = address();
        await wrong(ip);
        expect((await signIn(user, ip)).status).toBe(429);
        await sleep(1300);
        expect((await signIn(user, ip)).status).toBe(200);
      });

      it('the count is shared between backend instances: two limiters over one Redis add up', async () => {
        process.env.AUTH_FAIL_LIMIT = '3';
        const one = new AuthAttemptLimiter();
        const two = new AuthAttemptLimiter();
        const ip = address();
        await one.recordFailure(ip, 'api_key');
        await two.recordFailure(ip, 'api_key');
        await one.assertAllowed(ip, 'api_key');
        await two.recordFailure(ip, 'api_key');
        await expect(one.assertAllowed(ip, 'api_key')).rejects.toMatchObject({
          status: 429,
          response: { statusCode: 429, code: 'AUTH_RATE_LIMITED' },
        });
        await expect(two.assertAllowed(ip, 'api_key')).rejects.toMatchObject({
          status: 429,
        });
        // another kind from the same address is untouched
        await expect(one.assertAllowed(ip, 'sign_in')).resolves.toBeUndefined();
      });

      it('refuses to start without Redis, since counts must be shared', () => {
        const previous = process.env.REDIS_URL;
        delete process.env.REDIS_URL;
        try {
          expect(() => new AuthAttemptLimiter()).toThrow('REDIS_URL');
        } finally {
          process.env.REDIS_URL = previous;
        }
      });
    });

    // Makes a session's stored rotation time older than the grace window.
    const ageRotationOf = (id: string) =>
      worker.deviceSession.update({
        where: { id },
        data: { rotatedAt: new Date(Date.now() - 120 * 1000) },
      });
  });
});
