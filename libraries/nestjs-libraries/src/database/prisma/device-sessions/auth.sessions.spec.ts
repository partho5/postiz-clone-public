// api.token-auth: every sign-in route starts a device session, the sign-in routes share the
// failed-attempt limit, and logout ends the session. Runs the real AuthController, AuthTokenController,
// TokenService and limiter over a real Postgres and Redis; the sign-in itself (AuthService, the one-time-code
// service) is the real one, except the OAuth code exchange, which needs a provider's network, and the mail
// service, which keeps each message instead of sending it.
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
import { EmailOtpRepository } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.repository';
import { EmailOtpService } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.service';
import { AuthService } from '@gitroom/backend/services/auth/auth.service';
import { AuthController } from '@gitroom/backend/api/routes/auth.controller';
import { AuthTokenController } from '@gitroom/backend/api/routes/auth.token.controller';
import { UsersController } from '@gitroom/backend/api/routes/users.controller';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';
import { AuthAttemptLimiter } from '@gitroom/backend/services/auth/tokens/auth.attempt.limiter';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';

// Modules that pull ESM-only packages ts-jest cannot load; the routes under test never call them
jest.mock('file-type', () => ({}));
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
jest.mock(
  '@gitroom/nestjs-libraries/integrations/social/farcaster.provider',
  () => ({ FarcasterProvider: class {} })
);
jest.mock('@gitroom/nestjs-libraries/chat/mastra.service', () => ({
  MastraService: class {},
}));
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

describeDb('api.token-auth sign-in routes and logout (Postgres, Redis)', () => {
  let prisma: PrismaService;
  let worker: PrismaClient;
  let redis: any;
  let auth: AuthService;
  let tokens: TokenService;
  let authController: AuthController;
  let tokenController: AuthTokenController;
  let otp: EmailOtpService;
  let mailed: Array<{ to: string; html: string }>;
  let usersController: UsersController;
  let switched: any[];
  const saved: Record<string, string | undefined> = {};
  const envNames = [
    'DATABASE_URL',
    'JWT_SECRET',
    'FRONTEND_URL',
    'NOT_SECURED',
    'REDIS_URL',
    'AUTH_FAIL_LIMIT',
    'DISABLE_REGISTRATION',
    'DISALLOW_PLUS',
  ];

  beforeAll(async () => {
    for (const name of envNames) {
      saved[name] = process.env[name];
    }
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    process.env.JWT_SECRET = 'auth-sessions-spec-secret';
    process.env.FRONTEND_URL = 'http://localhost:4200';
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    delete process.env.DISABLE_REGISTRATION;
    delete process.env.DISALLOW_PLUS;
    prisma = new PrismaService();
    await prisma.$connect();
    // empty, not deleted: Prisma loads the root .env into any variable that is unset
    process.env.NOT_SECURED = '';
    worker = new PrismaClient({ datasourceUrl: url });
    redis = (
      await import('@gitroom/nestjs-libraries/redis/redis.service')
    ).ioRedis;

    const repo = new PrismaRepository<any>(prisma);
    const organizationRepository = new OrganizationRepository(repo, repo, repo);
    // The mail service: keeps each message so the test can read the code it carries
    mailed = [];
    const emails = {
      // Keeps the message instead of sending it.
      sendRequired: async (to: string, _subject: string, html: string) => {
        mailed.push({ to, html });
      },
    } as any;
    const notifications = {
      // Reports no email provider.
      hasEmailProvider: () => false,
    } as any;
    const accounts = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const organizations = new OrganizationService(
      organizationRepository,
      notifications,
      accounts
    );
    const users = new UsersService(
      new UsersRepository(repo, new PrismaTransaction(prisma)),
      organizationRepository,
      {} as any,
      notifications
    );
    auth = new AuthService(users, organizations, {} as any, accounts);
    tokens = new TokenService(new DeviceSessionsRepository(repo));
    const limiter = new AuthAttemptLimiter();
    otp = new EmailOtpService(
      new EmailOtpRepository(repo, repo, new PrismaTransaction(prisma)),
      emails,
      users,
      auth,
      limiter
    );
    authController = new AuthController(auth, tokens, otp);
    tokenController = new AuthTokenController(
      tokens,
      {} as any,
      limiter,
      otp,
      {} as any
    );
    // What the super admin switch hands to the user service, and to the payment service after it
    switched = [];
    usersController = new UsersController(
      {} as any,
      {
        // Does nothing: no payment provider is involved.
        syncCustomerEmailsAfterSwitch: async () => undefined,
      } as any,
      auth,
      organizations,
      {
        // Records what the controller hands to the user service.
        switchUser: async (...args: unknown[]) => {
          switched.push(args);
          return { kept: {}, switched: {} };
        },
      } as any,
      {} as any,
      tokens
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
    await prisma.$disconnect();
    await worker.$disconnect();
    await redis.quit();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.AUTH_FAIL_LIMIT;
  });

  // A unique email address for a new user.
  const email = () => randomUUID() + '@test.local';
  const password = 'correct-horse-' + randomUUID();
  // A client address of its own, so the limiter's counts never leak between tests.
  const address = () =>
    `10.${Math.floor(Math.random() * 250)}.${Math.floor(
      Math.random() * 250
    )}.${Math.floor(Math.random() * 250)}`;

  // A response that records the status, body, headers and cookies the controller answered with
  const response = () => {
    const res: any = {
      statusCode: 0,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
      cookies: {} as Record<string, { value: string; options: any }>,
    };
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = (body: unknown) => {
      res.body = body;
      return res;
    };
    res.send = res.json;
    res.header = (name: string, value: string) => {
      res.headers[name] = value;
      return res;
    };
    res.cookie = (name: string, value: string, options: any) => {
      res.cookies[name] = { value, options };
      return res;
    };
    return res;
  };

  // Asks for a one-time code for an address from a client address; the code that was mailed.
  const askForCode = async (address_: string, ip: string) => {
    await otp.request(address_, ip);
    return [...mailed]
      .reverse()
      .find((m) => m.to === address_)!
      .html.match(/<strong>(\d{6})<\/strong>/)![1];
  };

  // The email_otp grant for an address and code, as the token endpoint receives it, with the response it fills.
  const grant = (
    address_: string,
    code: string,
    res: any,
    ip: string,
    agent: string
  ) =>
    tokenController.token(
      { grant_type: 'email_otp', email: address_, code } as any,
      { cookies: {} } as any,
      res,
      ip,
      agent
    );

  // Signs an address in by one-time code: asks for the code, then sends the grant.
  const signInByCode = async (
    address_: string,
    res: any,
    ip: string,
    agent: string
  ) => grant(address_, await askForCode(address_, ip), res, ip, agent);

  // Creates the user of an address by signing it in once, from a client address of its own.
  const signUp = async (address_: string) => {
    await signInByCode(address_, response(), address(), 'jest');
  };

  // The device sessions stored for an email address's user
  const sessionsOf = async (address: string) => {
    const user = await worker.user.findFirstOrThrow({ where: { email: address } });
    return worker.deviceSession.findMany({ where: { userId: user.id } });
  };

  // Asserts the response carries a session's cookies and that the access cookie is a live session token
  const expectSessionCookies = async (res: any, userId: string) => {
    expect(res.cookies.auth.options.httpOnly).toBe(true);
    expect(res.cookies.refresh.options).toMatchObject({
      httpOnly: true,
      path: '/auth/token',
    });
    const { userId: user, sessionId } = await tokens.verifyAccess(
      res.cookies.auth.value
    );
    expect(user).toBe(userId);
    // a cookie that lives as long as the refresh lifetime
    const days =
      (res.cookies.auth.options.expires.getTime() - Date.now()) /
      (24 * 3600 * 1000);
    expect(days).toBeGreaterThan(36499);
    expect(days).toBeLessThan(36501);
    return sessionId;
  };

  it('POST /auth/token (email_otp, new address) starts a device session for the new user from this device', async () => {
    const address_ = email();
    const res = response();
    await signInByCode(address_, res, '10.1.2.3', 'register-agent');
    const [session, ...rest] = await sessionsOf(address_);
    expect(rest).toEqual([]);
    expect(session).toMatchObject({
      ip: '10.1.2.3',
      userAgent: 'register-agent',
      revokedAt: null,
    });
    const user = await worker.user.findFirstOrThrow({ where: { email: address_ } });
    expect(await expectSessionCookies(res, user.id)).toBe(session.id);
  });

  it('POST /auth/token (email_otp) starts a device session, and a second sign-in a second one', async () => {
    const address_ = email();
    await signUp(address_);
    const first = response();
    const second = response();
    await signInByCode(address_, first, address(), 'laptop');
    await signInByCode(address_, second, address(), 'phone');

    const sessions = await sessionsOf(address_);
    expect(sessions.map((s) => s.userAgent).sort()).toEqual(['jest', 'laptop', 'phone']);
    const user = await worker.user.findFirstOrThrow({ where: { email: address_ } });
    const a = await expectSessionCookies(first, user.id);
    const b = await expectSessionCookies(second, user.id);
    expect(a).not.toBe(b);
  });

  it('POST /auth/oauth/:provider/exists starts a device session for the signed-in user', async () => {
    const user = await worker.user.create({
      data: { email: email(), providerName: 'LOCAL', activated: true, timezone: 0 },
    });
    jest
      .spyOn((authController as any)._authService, 'checkExists')
      .mockResolvedValue({ jwt: AuthChecker.signJWT({ id: user.id }) });
    const res = response();
    await authController.oauthExists(
      { headers: { 'content-type': 'application/json' }, cookies: {} } as any,
      'code',
      'http://localhost:4200/cb',
      'state',
      'github',
      res,
      '10.5.5.5',
      'oauth-agent'
    );
    expect(res.statusCode).toBe(200);
    expect(await expectSessionCookies(res, user.id)).toBeTruthy();
    expect((await worker.deviceSession.findMany({ where: { userId: user.id } })).length).toBe(1);
  });

  it('a failed email_otp sign-in starts no session and sets no cookie', async () => {
    const address_ = email();
    const ip = address();
    const code = await askForCode(address_, ip);
    const res = response();
    await expect(
      grant(address_, code === '000000' ? '000001' : '000000', res, ip, 'jest')
    ).rejects.toMatchObject({ status: 401, response: { code: 'INVALID_GRANT' } });
    expect(res.cookies.auth).toBeUndefined();
    expect(await worker.user.count({ where: { email: address_ } })).toBe(0);
  });

  describe('failed-attempt limit on the email_otp grant', () => {
    // A six-digit code that is not the given one.
    const wrong = (code: string) => (code === '000000' ? '000001' : '000000');

    it('after AUTH_FAIL_LIMIT wrong codes the address gets AUTH_RATE_LIMITED, even for the right one, which is not checked', async () => {
      process.env.AUTH_FAIL_LIMIT = '3';
      const address_ = email();
      const ip = address();
      const code = await askForCode(address_, ip);
      for (let i = 0; i < 3; i++) {
        await expect(
          grant(address_, wrong(code), response(), ip, 'jest')
        ).rejects.toMatchObject({ status: 401 });
      }
      await expect(
        grant(address_, code, response(), ip, 'jest')
      ).rejects.toMatchObject({
        status: 429,
        response: { statusCode: 429, code: 'AUTH_RATE_LIMITED' },
        retryAfterSeconds: expect.any(Number),
      });
      const row = await worker.emailOtp.findFirstOrThrow({ where: { email: address_ } });
      expect(row.consumedAt).toBeNull();
      expect(await worker.user.count({ where: { email: address_ } })).toBe(0);
    });

    it('shares its count with the other sign-in grants: the failures are counted as sign_in of the address', async () => {
      process.env.AUTH_FAIL_LIMIT = '2';
      const address_ = email();
      const ip = address();
      const code = await askForCode(address_, ip);
      for (let i = 0; i < 2; i++) {
        await grant(address_, wrong(code), response(), ip, 'jest').catch(() => undefined);
      }
      expect(Number(await redis.get(`auth:fail:sign_in:${ip}`))).toBe(2);
    });

    it('a burst of parallel wrong codes is stopped at the limit', async () => {
      process.env.AUTH_FAIL_LIMIT = '3';
      const address_ = email();
      const ip = address();
      const code = await askForCode(address_, ip);
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, async () => {
          try {
            await grant(address_, wrong(code), response(), ip, 'jest');
            return 200;
          } catch (err: any) {
            return err.status;
          }
        })
      );
      expect(outcomes.filter((status) => status === 401)).toHaveLength(3);
      expect(outcomes.filter((status) => status === 429)).toHaveLength(17);
    });

    it('a successful sign-in does not count against the address', async () => {
      process.env.AUTH_FAIL_LIMIT = '2';
      const address_ = email();
      const ip = address();
      for (let i = 0; i < 5; i++) {
        const res = response();
        await grant(address_, await askForCode(address_, ip), res, ip, 'jest');
        expect(res.cookies.auth).toBeDefined();
      }
      expect(Number(await redis.get(`auth:fail:sign_in:${ip}`) ?? 0)).toBe(0);
    });
  });

  describe('POST /user/logout', () => {
    // The request AuthMiddleware leaves behind for a session
    const requestOf = (userId: string, sessionId: string) =>
      ({ sessionId, sessionUserId: userId, headers: {}, cookies: {} } as any);

    it('revokes the caller’s device session, and clears the auth, refresh, workspace and impersonation cookies', async () => {
      const address_ = email();
      await signUp(address_);
      const user = await worker.user.findFirstOrThrow({ where: { email: address_ } });
      const mine = await tokens.issue(user.id, { name: 'mine' });
      const other = await tokens.issue(user.id, { name: 'other' });

      const res = response();
      await usersController.logout(requestOf(user.id, mine.session_id), res);

      expect(res.headers.logout).toBe('true');
      for (const name of ['auth', 'refresh', 'showorg', 'impersonate']) {
        expect(res.cookies[name].value).toBe('');
        expect(res.cookies[name].options.expires.getTime()).toBe(0);
      }
      expect(res.cookies.refresh.options.path).toBe('/auth/token');
      await expect(tokens.verifyAccess(mine.access_token)).rejects.toMatchObject({
        status: 401,
        response: { code: 'SESSION_REVOKED' },
      });
      // the user’s other device stays signed in
      expect((await tokens.verifyAccess(other.access_token)).userId).toBe(user.id);
    });

    it('while impersonating, revokes the admin’s session, not the impersonated user’s', async () => {
      const admin = await worker.user.create({
        data: { email: email(), providerName: 'LOCAL', activated: true, isSuperAdmin: true, timezone: 0 },
      });
      const adminSession = await tokens.issue(admin.id, {});
      const res = response();
      await usersController.logout(requestOf(admin.id, adminSession.session_id), res);
      await expect(tokens.verifyAccess(adminSession.access_token)).rejects.toMatchObject({
        response: { code: 'SESSION_REVOKED' },
      });
    });

    it('with no session on the request still clears the cookies and revokes nothing', async () => {
      const res = response();
      await usersController.logout({ headers: {}, cookies: {} } as any, res);
      expect(res.headers.logout).toBe('true');
      expect(res.cookies.auth.value).toBe('');
    });
  });

  describe('POST /user/switch', () => {
    // The impersonated account, as the request decorator hands it over
    const target = { id: 'target-' + randomUUID(), isSuperAdmin: true } as any;

    it('takes the admin behind the impersonation from the session, never from the token body', async () => {
      switched.length = 0;
      const adminId = 'admin-' + randomUUID();
      const outcome = await usersController.switchUser(
        target,
        'next-' + randomUUID(),
        {
          sessionUserId: adminId,
          // upstream’s old way: an id in the token body, which must not be consulted
          headers: { auth: AuthChecker.signJWT({ id: 'someone-else' }) },
          cookies: {},
        } as any
      );
      expect(outcome).toEqual({ success: true });
      expect(switched).toHaveLength(1);
      expect(switched[0][0]).toBe(target.id);
      expect(switched[0][2]).toBe(adminId);
    });

    it.each([
      ['no session user on the request', undefined],
      ['the admin’s own account as the impersonated one', target.id],
    ])('refuses with 400 when there is %s', async (_name, sessionUserId) => {
      switched.length = 0;
      await expect(
        usersController.switchUser(target, 'next', {
          sessionUserId,
          headers: { auth: AuthChecker.signJWT({ id: 'admin' }) },
          cookies: {},
        } as any)
      ).rejects.toMatchObject({ status: 400 });
      expect(switched).toHaveLength(0);
    });
  });
});
