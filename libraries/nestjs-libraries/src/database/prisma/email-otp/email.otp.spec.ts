// api.email-otp: signing in with an email and a one-time code. Runs the real controllers,
// code service and repository, token service, limiter, sign-up path and mail service in a real Nest app
// against a real Postgres and a real Redis; the mail leaves through the Mailgun provider to a local
// HTTP server that stands in for Mailgun, and the test reads each code from the message it received.
// The service cases run on both database roles (the contract's access is "both"); the HTTP cases run
// on the API role, as the backend does.
import {
  ConsoleLogger,
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import { createServer, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { PrismaClient, Provider } from '@prisma/client';
import nodeCrypto, { createHash, randomUUID } from 'crypto';
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
import { otpConfig } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.config';
import { EmailService } from '@gitroom/nestjs-libraries/services/email.service';
import { EmptyProvider } from '@gitroom/nestjs-libraries/emails/empty.provider';
import { HttpExceptionFilter } from '@gitroom/nestjs-libraries/services/exception.filter';
import { AuthController } from '@gitroom/backend/api/routes/auth.controller';
import { AuthTokenController } from '@gitroom/backend/api/routes/auth.token.controller';
import { WebHandoffService } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.service';
import { AuthService } from '@gitroom/backend/services/auth/auth.service';
import { AuthProviderManager } from '@gitroom/backend/services/auth/providers/providers.manager';
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

const JWT_SECRET = 'email-otp-spec-secret';

// What the stand-in Mailgun received for one message.
type Mail = { to: string; subject: string; html: string };

describeDb('api.email-otp (Postgres, Redis, stand-in Mailgun)', () => {
  let worker: PrismaClient;
  let apiPrisma: PrismaService;
  let redis: any;
  let mailServer: Server;
  let mails: Mail[];
  let mailAnswer: (res: ServerResponse) => void;
  const saved: Record<string, string | undefined> = {};
  const envNames = [
    'DATABASE_URL',
    'JWT_SECRET',
    'FRONTEND_URL',
    'NOT_SECURED',
    'NEXT_PUBLIC_BACKEND_URL',
    'REDIS_URL',
    'EMAIL_PROVIDER',
    'EMAIL_FROM_NAME',
    'EMAIL_FROM_ADDRESS',
    'MAILGUN_API_KEY',
    'MAILGUN_DOMAIN',
    'MAILGUN_API_BASE',
    'DISABLE_REGISTRATION',
    'DISALLOW_PLUS',
    'OTP_TTL_SECONDS',
    'OTP_MAX_TRIES',
    'OTP_REQUEST_LIMIT',
    'OTP_REQUEST_WINDOW_SECONDS',
    'OTP_RESEND_COOLDOWN_SECONDS',
    'AUTH_FAIL_LIMIT',
    'AUTH_FAIL_WINDOW_SECONDS',
  ];

  // Builds the code service and everything it uses on the given database connection, with the real
  // limiter and a real mail service pointed at the stand-in Mailgun.
  const build = (prisma: PrismaService) => {
    const repo = new PrismaRepository<any>(prisma);
    const organizationRepository = new OrganizationRepository(repo, repo, repo);
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
    const auth = new AuthService(
      users,
      organizations,
      {} as unknown as AuthProviderManager,
      accounts
    );
    const emails = new EmailService({} as any);
    const emailOtpRepository = new EmailOtpRepository(
      repo,
      repo,
      new PrismaTransaction(prisma)
    );
    const otp = new EmailOtpService(
      emailOtpRepository,
      emails,
      users,
      auth,
      new AuthAttemptLimiter()
    );
    return {
      repo,
      accounts,
      organizations,
      users,
      auth,
      emails,
      emailOtpRepository,
      otp,
    };
  };

  beforeAll(async () => {
    for (const name of envNames) {
      saved[name] = process.env[name];
    }
    mailServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      // Runs once the whole request body has arrived.
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        mails.push({
          to: form.get('to')!,
          subject: form.get('subject')!,
          html: form.get('html')!,
        });
        mailAnswer(res);
      });
    });
    await new Promise<void>((r) => mailServer.listen(0, '127.0.0.1', r));
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.FRONTEND_URL = 'http://localhost:4200';
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    // empty, not deleted: Prisma loads the root .env into any variable that is unset
    process.env.NOT_SECURED = '';
    process.env.NEXT_PUBLIC_BACKEND_URL = '';
    process.env.EMAIL_PROVIDER = 'mailgun';
    process.env.EMAIL_FROM_NAME = 'Sign-in test';
    process.env.EMAIL_FROM_ADDRESS = 'login@mg.example.com';
    process.env.MAILGUN_API_KEY = 'key-email-otp-spec';
    process.env.MAILGUN_DOMAIN = 'mg.example.com';
    process.env.MAILGUN_API_BASE = `http://127.0.0.1:${
      (mailServer.address() as AddressInfo).port
    }`;
    apiPrisma = new PrismaService();
    await apiPrisma.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    redis = (
      await import('@gitroom/nestjs-libraries/redis/redis.service')
    ).ioRedis;
  });

  afterAll(async () => {
    for (const name of envNames) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    mailServer.closeAllConnections();
    await new Promise((r) => mailServer.close(r));
    await apiPrisma.$disconnect();
    await worker.$disconnect();
    await redis.quit();
  });

  beforeEach(() => {
    mails = [];
    // the cooldown is off except in its own tests, so repeated requests in a test are not refused
    process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
    // Default answer: Mailgun accepting the message.
    mailAnswer = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: '<1@mg>', message: 'Queued. Thank you.' }));
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    for (const name of [
      'DISABLE_REGISTRATION',
      'DISALLOW_PLUS',
      'OTP_TTL_SECONDS',
      'OTP_MAX_TRIES',
      'OTP_REQUEST_LIMIT',
      'OTP_REQUEST_WINDOW_SECONDS',
      'OTP_RESEND_COOLDOWN_SECONDS',
      'AUTH_FAIL_LIMIT',
      'AUTH_FAIL_WINDOW_SECONDS',
    ]) {
      delete process.env[name];
    }
  });

  // A unique email address.
  const email = () => randomUUID() + '@test.local';
  // A client address of its own, so request limits and failure counts never leak between tests
  const address = () =>
    `10.${Math.floor(Math.random() * 250)}.${Math.floor(
      Math.random() * 250
    )}.${Math.floor(Math.random() * 250)}`;

  // The six-digit code in the newest message the stand-in received for an address.
  const codeFor = (to: string) => {
    const mail = [...mails].reverse().find((m) => m.to === to.toLowerCase());
    const code = mail?.html.match(/<strong>(\d{6})<\/strong>/)?.[1];
    if (!code) {
      throw new Error(`no code was mailed to ${to}`);
    }
    return code;
  };

  // A code that is six digits and not the given one.
  const wrongCode = (right: string) => (right === '000000' ? '000001' : '000000');

  // An activated Google-account user with a workspace of their own.
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

  // The stored code rows of an address, oldest first.
  const rowsOf = (to: string) =>
    worker.emailOtp.findMany({ where: { email: to }, orderBy: { createdAt: 'asc' } });

  // The failed sign-in attempts the shared counter holds for a client address.
  const failures = (ip: string) =>
    redis
      .get(`auth:fail:sign_in:${ip}`)
      .then((value: string | null) => Number(value ?? 0));

  // Stops the date at the present instant, so a Retry-After can be pinned to the second; timers keep
  // running, so the database, Redis and HTTP calls work. Returns the instant in milliseconds.
  const freezeDate = () => {
    const now = Date.now();
    jest.useFakeTimers({
      now,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    return now;
  };

  // Stores an earlier request of an address from a client address, as if made `seconds` before `now`.
  const seedRequest = (to: string, ip: string, seconds: number, now: number) =>
    worker.emailOtp.create({
      data: {
        email: to,
        codeHash: '',
        expiresAt: new Date(now),
        consumedAt: new Date(now),
        requestIp: ip,
        createdAt: new Date(now - seconds * 1000),
      },
    });

  // Moves every stored request of an address to `seconds` before `now`.
  const ageRequests = (to: string, seconds: number, now: number) =>
    worker.emailOtp.updateMany({
      where: { email: to },
      data: { createdAt: new Date(now - seconds * 1000) },
    });

  // Everything the Nest loggers, the console and the process streams are asked to write while `during`
  // runs, as one string. The app runs with `logger: false`, which silences Nest's Logger, so the
  // loggers are spied at their methods instead of read from the stream.
  const captureOutput = async (during: () => Promise<unknown>) => {
    const seen: unknown[] = [];
    // Notes the arguments of a write.
    const note = (...args: unknown[]) => {
      seen.push(args);
    };
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(note);
      jest.spyOn(Logger, level).mockImplementation(note);
      jest.spyOn(ConsoleLogger.prototype, level).mockImplementation(note);
    }
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, level).mockImplementation(note);
    }
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
      // Notes the write and lets it through, so the test reporter keeps working.
      const noteAndWrite = (...args: unknown[]) => {
        note(...args);
        return write(...args);
      };
      jest
        .spyOn(stream, 'write')
        .mockImplementation(noteAndWrite as typeof stream.write);
    }
    await during();
    return JSON.stringify(seen);
  };

  describe('over HTTP (API role)', () => {
    let app: any;
    let base: string;
    let accounts: AccountsService;
    let emails: EmailService;

    beforeAll(async () => {
      const built = build(apiPrisma);
      accounts = built.accounts;
      emails = built.emails;
      // The app under test: both controllers with the real services behind them.
      @Module({
        // the throttler is only there for the Farcaster routes of AuthController
        imports: [ThrottlerModule.forRoot([{ ttl: 3600000, limit: 1000 }])],
        controllers: [AuthController, AuthTokenController],
        providers: [
          AuthService,
          TokenService,
          TokenGrantsService,
          AuthAttemptLimiter,
          EmailOtpService,
          { provide: AuthProviderManager, useValue: {} },
          { provide: WebHandoffService, useValue: {} },
          { provide: EmailService, useValue: built.emails },
          { provide: UsersService, useValue: built.users },
          { provide: OrganizationService, useValue: built.organizations },
          { provide: AccountsService, useValue: built.accounts },
          {
            provide: EmailOtpRepository,
            useValue: new EmailOtpRepository(
              built.repo,
              built.repo,
              new PrismaTransaction(apiPrisma)
            ),
          },
          {
            provide: DeviceSessionsRepository,
            useValue: new DeviceSessionsRepository(built.repo),
          },
        ],
      })
      class AppModule implements NestModule {
        // Needs no middleware: both controllers are public.
        configure(_consumer: MiddlewareConsumer) {}
      }
      app = await NestFactory.create(AppModule, { logger: false });
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ transform: true }));
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.listen(0);
      base = await app.getUrl();
    });

    afterAll(async () => {
      await app.close();
    });

    // One request to the app; the answer with its parsed body and every Set-Cookie line.
    const call = async (
      method: string,
      path: string,
      options: { body?: unknown; ip?: string } = {}
    ) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': options.ip ?? address(),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
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

    // Asks for a code for an address.
    const requestCode = (to: string, ip?: string) =>
      call('POST', '/auth/otp/request', { body: { email: to }, ip });

    // The email_otp grant for an address and a code.
    const grant = (to: string, code: string, ip?: string, extra = {}) =>
      call('POST', '/auth/token', {
        ip,
        body: { grant_type: 'email_otp', email: to, code, ...extra },
      });

    // Asks for a code and signs in with it; the address, the client address and the answer.
    const signIn = async (to = email(), ip = address()) => {
      await requestCode(to, ip);
      return { to, ip, res: await grant(to, codeFor(to), ip, { device_name: 'Phone' }) };
    };

    const INVALID = { statusCode: 401, code: 'INVALID_GRANT' };

    describe('POST /auth/otp/request', () => {
      it('answers 204 with no body and mails the code to the trimmed, lower-cased address', async () => {
        const to = email();
        const res = await requestCode(`  ${to.toUpperCase()} `);

        expect(res.status).toBe(204);
        expect(res.text).toBe('');
        expect(mails).toHaveLength(1);
        expect(mails[0].to).toBe(to);
        expect(codeFor(to)).toMatch(/^\d{6}$/);
        expect((await rowsOf(to)).length).toBe(1);
        expect((await rowsOf(to.toUpperCase())).length).toBe(0);
      });

      it('the mail says the code, its life in minutes and that it can be ignored', async () => {
        const to = email();
        await requestCode(to);
        const html = mails[0].html;

        expect(html).toContain(`<strong>${codeFor(to)}</strong>`);
        expect(html).toMatch(/10 minutes/);
        expect(html).toMatch(/ignore/i);
      });

      it('the life in the mail and in the row follow OTP_TTL_SECONDS (default 600)', async () => {
        const first = email();
        await requestCode(first);
        const [row] = await rowsOf(first);
        expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(600_000);

        process.env.OTP_TTL_SECONDS = '120';
        const second = email();
        await requestCode(second);
        const [short] = await rowsOf(second);
        expect(short.expiresAt.getTime() - short.createdAt.getTime()).toBe(120_000);
        expect(mails[1].html).toMatch(/2 minutes/);
      });

      it('a code is always six digits, a small random value included', async () => {
        const random = jest
          .spyOn(nodeCrypto, 'randomInt')
          .mockImplementation((() => 42) as typeof nodeCrypto.randomInt);
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        random.mockRestore();

        expect(codeFor(to)).toBe('000042');
        expect((await grant(to, '000042', ip)).status).toBe(200);
      });

      it('draws codes from the whole six-digit range, not only a small one padded with zeros', async () => {
        const codes: number[] = [];
        for (let i = 0; i < 25; i++) {
          const to = email();
          await requestCode(to);
          codes.push(Number(codeFor(to)));
        }

        // a code below 100000 is one in ten, so 25 of them in a row is not chance
        expect(Math.max(...codes)).toBeGreaterThanOrEqual(100_000);
      });

      it('stores the code only as a keyed hash: not the code, not a bare hash of it', async () => {
        const to = email();
        await requestCode(to);
        const code = codeFor(to);
        const [row] = await rowsOf(to);

        expect(JSON.stringify(row)).not.toContain(code);
        expect(row.codeHash).not.toBe(code);
        for (const bare of [code, `${to}:${code}`, `email-otp:${to}:${code}`]) {
          expect(row.codeHash).not.toBe(
            createHash('sha256').update(bare).digest('hex')
          );
        }
        expect(row).toMatchObject({ tries: 0, consumedAt: null, email: to });
      });

      it('the key of the stored hash is the server secret: the table alone does not give the code back', async () => {
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        const code = codeFor(to);

        process.env.JWT_SECRET = 'another-server-secret';
        let refused;
        try {
          refused = await grant(to, code, ip);
        } finally {
          process.env.JWT_SECRET = JWT_SECRET;
        }

        expect(refused.status).toBe(401);
        expect(refused.body).toEqual(INVALID);
        // the same secret again: the same code is the right one
        expect((await grant(to, code, ip)).status).toBe(200);
      });

      it('without a server secret no code is sent and none is left usable', async () => {
        const to = email();
        const ip = address();
        let res;
        try {
          delete process.env.JWT_SECRET;
          res = await requestCode(to, ip);
        } finally {
          process.env.JWT_SECRET = JWT_SECRET;
        }

        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(mails).toHaveLength(0);
        expect((await rowsOf(to)).every((row) => row.consumedAt !== null)).toBe(true);
        expect((await grant(to, '123456', ip)).status).toBe(401);
      });

      it('never returns the code in an answer, never logs it, and never writes it to a stream', async () => {
        const to = email();
        const ip = address();
        const answers: Array<{ headers: Headers; text: string }> = [];
        let code = '';
        const written = await captureOutput(async () => {
          answers.push(await requestCode(to, ip));
          code = codeFor(to);
          answers.push(await grant(to, wrongCode(code), ip));
          answers.push(await grant(to, code, ip));
        });

        const everything = JSON.stringify([
          answers.map((a) => [[...a.headers.entries()], a.text]),
          written,
        ]);
        expect(everything).not.toContain(code);
        expect(everything).not.toContain(wrongCode(code));
        // nor the stored hash of it, which the table holds and a log must not repeat
        const [stored] = await rowsOf(to);
        expect(stored.codeHash).toMatch(/^[0-9a-f]{20,}$/);
        expect(everything).not.toContain(stored.codeHash);
      });

      it('never logs the code when the mail provider refuses it', async () => {
        mailAnswer = (res) => {
          res.writeHead(500);
          res.end('boom');
        };
        const to = email();
        let res: Awaited<ReturnType<typeof requestCode>> | undefined;
        const written = await captureOutput(async () => {
          res = await requestCode(to);
        });
        const code = codeFor(to);

        expect(res!.status).toBe(503);
        expect(written).not.toContain(code);
        expect(JSON.stringify([[...res!.headers.entries()], res!.text])).not.toContain(code);
      });

      it('never logs the code when the account cannot be created, even if the failure carries it in its text', async () => {
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        const code = codeFor(to);
        jest
          .spyOn(accounts, 'attachOrganizationToOwner')
          .mockRejectedValue(
            new Error(`account store down for ${to}, code ${code}`)
          );
        let res: Awaited<ReturnType<typeof grant>> | undefined;
        const written = await captureOutput(async () => {
          res = await grant(to, code, ip);
        });

        expect(res!.status).toBe(400);
        expect(written).not.toContain(code);
        expect(res!.text).not.toContain(code);
        // the failure text can carry the address too: only the kind of failure is written
        expect(written).not.toContain(to);
        expect(res!.text).not.toContain(to);
      });

      it('a new code makes every earlier unused code unusable', async () => {
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        const first = codeFor(to);
        await requestCode(to, ip);
        const second = codeFor(to);

        const old = await grant(to, first, ip);
        expect(old.status).toBe(401);
        expect(old.body).toEqual(INVALID);
        expect((await grant(to, second, ip)).status).toBe(200);
      });

      it('a new code for one address leaves the codes of other addresses usable', async () => {
        const first = email();
        const second = email();
        const ip = address();
        await requestCode(first, ip);
        const kept = codeFor(first);
        await requestCode(second, ip);
        await requestCode(second, ip);

        expect((await grant(first, kept, ip)).status).toBe(200);
      });

      it('an earlier code stays unusable after the newest one has been used', async () => {
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        const first = codeFor(to);
        await requestCode(to, ip);
        const second = codeFor(to);

        expect((await grant(to, second, ip)).status).toBe(200);
        const old = await grant(to, first, ip);
        expect(old.status).toBe(401);
        expect(old.body).toEqual(INVALID);
      });

      it('answers identically for a known address, a new address and a refused address', async () => {
        const { user } = await newUser();
        process.env.DISABLE_REGISTRATION = 'true';
        const known = await requestCode(user.email);
        const refused = await requestCode(email());
        delete process.env.DISABLE_REGISTRATION;
        const fresh = await requestCode(email());

        for (const res of [known, refused, fresh]) {
          expect(res.status).toBe(204);
          expect(res.text).toBe('');
        }
        // The sorted names of a response's headers, without the two that vary per response.
        const shape = (res: typeof known) => {
          const names = [...res.headers.keys()]
            .filter((name) => !['date', 'etag'].includes(name))
            .sort();
          return names;
        };
        expect(shape(refused)).toEqual(shape(known));
        expect(shape(fresh)).toEqual(shape(known));
      });

      it('sends nothing to a new address when registration is disabled, and still stores the request so it counts', async () => {
        await newUser();
        process.env.DISABLE_REGISTRATION = 'true';
        const to = email();
        const res = await requestCode(to);

        expect(res.status).toBe(204);
        expect(mails).toHaveLength(0);
        const rows = await rowsOf(to);
        expect(rows).toHaveLength(1);
        expect(rows[0].consumedAt).not.toBeNull();
      });

      it('sends nothing to a new address with a plus sign while DISALLOW_PLUS is set', async () => {
        await newUser();
        process.env.DISALLOW_PLUS = 'true';
        const res = await requestCode(`plus+${randomUUID()}@test.local`);

        expect(res.status).toBe(204);
        expect(mails).toHaveLength(0);
      });

      it('still sends to a known address when registration is disabled', async () => {
        const { user } = await newUser();
        process.env.DISABLE_REGISTRATION = 'true';
        const res = await requestCode(user.email);

        expect(res.status).toBe(204);
        expect(mails).toHaveLength(1);
      });

      it('answers 400 for a malformed address, sends nothing and stores nothing', async () => {
        const ip = address();
        for (const bad of ['not-an-email', '', 'a@', 'x'.repeat(250) + '@test.local']) {
          const res = await call('POST', '/auth/otp/request', {
            body: { email: bad },
            ip,
          });
          expect(res.status).toBe(400);
        }
        const noBody = await call('POST', '/auth/otp/request', { body: {}, ip });
        expect(noBody.status).toBe(400);
        expect(mails).toHaveLength(0);
        expect(await worker.emailOtp.count({ where: { requestIp: ip } })).toBe(0);
      });

      it('answers 503 MAIL_DELIVERY_FAILED when the mail provider refuses, and leaves no usable code', async () => {
        mailAnswer = (res) => {
          res.writeHead(500);
          res.end('boom');
        };
        const to = email();
        const ip = address();
        const res = await requestCode(to, ip);

        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ statusCode: 503, code: 'MAIL_DELIVERY_FAILED' });
        expect(mails).toHaveLength(1);
        const refused = await grant(to, codeFor(to), ip);
        expect(refused.status).toBe(401);
        expect(refused.body).toEqual(INVALID);
        expect(await worker.user.count({ where: { email: to } })).toBe(0);
      });

      it('answers 503 MAIL_DELIVERY_FAILED when no mail provider is configured', async () => {
        const real = emails.emailService;
        emails.emailService = new EmptyProvider();
        try {
          const res = await requestCode(email());
          expect(res.status).toBe(503);
          expect(res.body).toMatchObject({ code: 'MAIL_DELIVERY_FAILED' });
        } finally {
          emails.emailService = real;
        }
      });

      it('a failed send still counts toward the request limit', async () => {
        process.env.OTP_REQUEST_LIMIT = '2';
        mailAnswer = (res) => {
          res.writeHead(500);
          res.end();
        };
        const to = email();
        expect((await requestCode(to)).status).toBe(503);
        expect((await requestCode(to)).status).toBe(503);
        expect((await requestCode(to)).status).toBe(429);
      });

      it('deletes rows older than 24 hours on each request', async () => {
        const old = await worker.emailOtp.create({
          data: {
            email: email(),
            codeHash: 'x',
            expiresAt: new Date(),
            requestIp: '10.0.0.1',
            createdAt: new Date(Date.now() - 25 * 3600 * 1000),
          },
        });
        const recent = await worker.emailOtp.create({
          data: {
            email: email(),
            codeHash: 'x',
            expiresAt: new Date(),
            requestIp: '10.0.0.1',
            createdAt: new Date(Date.now() - 23 * 3600 * 1000),
          },
        });
        await requestCode(email());

        expect(await worker.emailOtp.findUnique({ where: { id: old.id } })).toBeNull();
        expect(await worker.emailOtp.findUnique({ where: { id: recent.id } })).not.toBeNull();
      });
    });

    describe('request limits', () => {
      it('refuses a request past OTP_REQUEST_LIMIT for one address with 429, AUTH_RATE_LIMITED and Retry-After', async () => {
        process.env.OTP_REQUEST_LIMIT = '3';
        const to = email();
        for (let i = 0; i < 3; i++) {
          expect((await requestCode(to, address())).status).toBe(204);
        }
        const res = await requestCode(to, address());

        expect(res.status).toBe(429);
        expect(res.body).toEqual({ statusCode: 429, code: 'AUTH_RATE_LIMITED' });
        const wait = Number(res.headers.get('retry-after'));
        expect(wait).toBeGreaterThan(0);
        expect(wait).toBeLessThanOrEqual(900);
        expect(mails).toHaveLength(3);
        expect((await requestCode(email(), address())).status).toBe(204);
      });

      it('refuses past the limit per client address across all addresses', async () => {
        process.env.OTP_REQUEST_LIMIT = '3';
        const ip = address();
        for (let i = 0; i < 3; i++) {
          expect((await requestCode(email(), ip)).status).toBe(204);
        }
        const res = await requestCode(email(), ip);

        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBeTruthy();
        expect((await requestCode(email(), address())).status).toBe(204);
      });

      it('counts every request the same: known, new and refused addresses all use up the limit', async () => {
        process.env.OTP_REQUEST_LIMIT = '2';
        const { user } = await newUser();
        process.env.DISABLE_REGISTRATION = 'true';
        const refusedAddress = email();
        const outcomes: number[] = [];
        for (const to of [user.email, refusedAddress]) {
          for (let i = 0; i < 3; i++) {
            outcomes.push((await requestCode(to, address())).status);
          }
        }

        expect(outcomes).toEqual([204, 204, 429, 204, 204, 429]);
      });

      it('allows requests again once the counting window has passed', async () => {
        process.env.OTP_REQUEST_LIMIT = '2';
        const to = email();
        await requestCode(to);
        await requestCode(to);
        expect((await requestCode(to)).status).toBe(429);
        await worker.emailOtp.updateMany({
          where: { email: to },
          data: { createdAt: new Date(Date.now() - 901 * 1000) },
        });

        expect((await requestCode(to)).status).toBe(204);
      });

      it('follows OTP_REQUEST_WINDOW_SECONDS', async () => {
        process.env.OTP_REQUEST_LIMIT = '1';
        process.env.OTP_REQUEST_WINDOW_SECONDS = '60';
        const to = email();
        await requestCode(to);
        const res = await requestCode(to);
        expect(res.status).toBe(429);
        expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(60);
        await worker.emailOtp.updateMany({
          where: { email: to },
          data: { createdAt: new Date(Date.now() - 61 * 1000) },
        });
        expect((await requestCode(to)).status).toBe(204);
      });

      it('counts a request for the whole window and not a second longer', async () => {
        process.env.OTP_REQUEST_LIMIT = '1';
        const now = freezeDate();
        const inside = email();
        await seedRequest(inside, address(), 880, now);
        const outside = email();
        await seedRequest(outside, address(), 920, now);

        expect((await requestCode(inside)).status).toBe(429);
        expect((await requestCode(outside)).status).toBe(204);
      });

      it('answers Retry-After as the seconds until the address leaves the limit', async () => {
        process.env.OTP_REQUEST_LIMIT = '1';
        const now = freezeDate();
        const to = email();
        await seedRequest(to, address(), 100.5, now);
        const res = await requestCode(to);

        // a 900 s window and a request made 100.5 s ago: 799.5 s left, rounded up
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('800');
      });

      it('answers Retry-After as the seconds until the client address leaves the limit', async () => {
        process.env.OTP_REQUEST_LIMIT = '1';
        const now = freezeDate();
        const ip = address();
        await seedRequest(email(), ip, 250.5, now);
        const res = await requestCode(email(), ip);

        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('650');
      });

      it('when the address and the client address are both full, Retry-After is the later of the two', async () => {
        process.env.OTP_REQUEST_LIMIT = '1';
        const now = freezeDate();
        const addressLater = email();
        const ipEarlier = address();
        await seedRequest(addressLater, address(), 100.5, now);
        await seedRequest(email(), ipEarlier, 300, now);
        const clientLater = email();
        const ipLater = address();
        await seedRequest(clientLater, address(), 300, now);
        await seedRequest(email(), ipLater, 100.5, now);

        const first = await requestCode(addressLater, ipEarlier);
        const second = await requestCode(clientLater, ipLater);

        expect(first.status).toBe(429);
        expect(first.headers.get('retry-after')).toBe('800');
        expect(second.status).toBe(429);
        expect(second.headers.get('retry-after')).toBe('800');
      });

      it('with more counted requests than the limit, Retry-After is when the count drops below it', async () => {
        process.env.OTP_REQUEST_LIMIT = '2';
        const now = freezeDate();
        const to = email();
        for (const age of [400, 300, 100]) {
          await seedRequest(to, address(), age, now);
        }
        const res = await requestCode(to);

        // the count is below two again once the rows at 400 s and 300 s have left the 900 s window
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('600');
      });

      it('follows OTP_REQUEST_WINDOW_SECONDS for the seconds left', async () => {
        process.env.OTP_REQUEST_LIMIT = '1';
        process.env.OTP_REQUEST_WINDOW_SECONDS = '60';
        const now = freezeDate();
        const to = email();
        await seedRequest(to, address(), 50, now);
        const res = await requestCode(to);

        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('10');
      });

      it('concurrent requests never exceed the limit', async () => {
        process.env.OTP_REQUEST_LIMIT = '3';
        const to = email();
        const results = await Promise.all(
          Array.from({ length: 8 }, () => requestCode(to, address()))
        );

        expect(results.filter((r) => r.status === 204)).toHaveLength(3);
        expect(results.filter((r) => r.status === 429)).toHaveLength(5);
        expect(await worker.emailOtp.count({ where: { email: to } })).toBe(3);
      });

      it('the refusal is the same for a known and an unknown address', async () => {
        process.env.OTP_REQUEST_LIMIT = '1';
        const { user } = await newUser();
        const ip = address();
        await requestCode(user.email, ip);
        const known = await requestCode(user.email, address());
        const fresh = email();
        await requestCode(fresh, address());
        const unknown = await requestCode(fresh, address());

        expect(known.status).toBe(429);
        expect(unknown.status).toBe(429);
        expect(known.body).toEqual(unknown.body);
      });
    });

    describe('resend cooldown', () => {
      it('refuses a second code for the same address inside the cooldown with 429, AUTH_RATE_LIMITED and Retry-After', async () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
        const to = email();
        expect((await requestCode(to, address())).status).toBe(204);
        const res = await requestCode(to, address());

        expect(res.status).toBe(429);
        expect(res.body).toEqual({ statusCode: 429, code: 'AUTH_RATE_LIMITED' });
        // Straight after the first request almost the whole cooldown is left: the seconds left, not a constant.
        const wait = Number(res.headers.get('retry-after'));
        expect(wait).toBeGreaterThanOrEqual(58);
        expect(wait).toBeLessThanOrEqual(60);
        expect(mails).toHaveLength(1);
      });

      it('answers Retry-After as the seconds left of the cooldown, which shrink as the last request ages', async () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
        const now = freezeDate();
        const to = email();
        await requestCode(to);
        const left: string[] = [];
        // the last request 0.2 s, 30 s and 29.5 s ago: 59.8, 30 and 30.5 s left, rounded up
        for (const age of [0.2, 30, 29.5]) {
          await ageRequests(to, age, now);
          const res = await requestCode(to);
          expect(res.status).toBe(429);
          left.push(res.headers.get('retry-after')!);
        }

        expect(left).toEqual(['60', '30', '31']);
      });

      it('measures the cooldown from the last request of the address, not from its first', async () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
        const now = freezeDate();
        const to = email();
        await requestCode(to);
        await ageRequests(to, 90, now);
        expect((await requestCode(to)).status).toBe(204);
        await worker.emailOtp.updateMany({
          where: { email: to, createdAt: new Date(now) },
          data: { createdAt: new Date(now - 20_000) },
        });
        const third = await requestCode(to);

        // the first request is 90 s old, the second 20 s: the cooldown still has 40 s to run
        expect(third.status).toBe(429);
        expect(third.headers.get('retry-after')).toBe('40');
        expect(mails).toHaveLength(2);
      });

      it('holds the cooldown for the whole of it and not a second longer', async () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
        const now = freezeDate();
        const held = email();
        await seedRequest(held, address(), 55, now);
        const free = email();
        await seedRequest(free, address(), 65, now);

        expect((await requestCode(held)).status).toBe(429);
        expect((await requestCode(free)).status).toBe(204);
      });

      it('of concurrent requests for one address inside the cooldown, exactly one is accepted', async () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
        const to = email();
        const results = await Promise.all(
          Array.from({ length: 6 }, () => requestCode(to, address()))
        );

        expect(results.filter((r) => r.status === 204)).toHaveLength(1);
        expect(results.filter((r) => r.status === 429)).toHaveLength(5);
        expect(mails).toHaveLength(1);
      });

      it('does not hold back a different address from the same client', async () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
        const ip = address();
        expect((await requestCode(email(), ip)).status).toBe(204);
        expect((await requestCode(email(), ip)).status).toBe(204);
      });

      it('allows the address again once the cooldown has passed', async () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
        const to = email();
        await requestCode(to);
        await worker.emailOtp.updateMany({
          where: { email: to },
          data: { createdAt: new Date(Date.now() - 61 * 1000) },
        });

        expect((await requestCode(to)).status).toBe(204);
      });

      it('refuses a known and an unknown address the same way', async () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
        const { user } = await newUser();
        const fresh = email();
        await requestCode(user.email);
        await requestCode(fresh);
        const known = await requestCode(user.email);
        const unknown = await requestCode(fresh);

        expect(known.status).toBe(429);
        expect(unknown.status).toBe(429);
        expect(known.body).toEqual(unknown.body);
      });

      it('rejects a cooldown longer than the counting window as a configuration error', async () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '1000';
        process.env.OTP_REQUEST_WINDOW_SECONDS = '900';
        expect(() => otpConfig()).toThrow('OTP_RESEND_COOLDOWN_SECONDS');
      });
    });

    describe('configuration', () => {
      const names = {
        OTP_TTL_SECONDS: 'ttlSeconds',
        OTP_MAX_TRIES: 'maxTries',
        OTP_REQUEST_LIMIT: 'requestLimit',
        OTP_REQUEST_WINDOW_SECONDS: 'requestWindowSeconds',
      };

      it('defaults to 600 seconds, 5 tries, 5 requests per 900 seconds and a 30 second cooldown', () => {
        for (const name of [...Object.keys(names), 'OTP_RESEND_COOLDOWN_SECONDS']) {
          delete process.env[name];
        }

        expect(otpConfig()).toEqual({
          ttlSeconds: 600,
          maxTries: 5,
          requestLimit: 5,
          requestWindowSeconds: 900,
          resendCooldownSeconds: 30,
        });
      });

      it('reads each variable', () => {
        process.env.OTP_TTL_SECONDS = '61';
        process.env.OTP_MAX_TRIES = '7';
        process.env.OTP_REQUEST_LIMIT = '8';
        process.env.OTP_REQUEST_WINDOW_SECONDS = '901';
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '9';

        expect(otpConfig()).toEqual({
          ttlSeconds: 61,
          maxTries: 7,
          requestLimit: 8,
          requestWindowSeconds: 901,
          resendCooldownSeconds: 9,
        });
      });

      it.each(Object.keys(names).flatMap((name) => ['0', '-1', '1.5', 'abc', '30s'].map((value) => [name, value])))(
        'a malformed %s (%s) is an error',
        (name, value) => {
          process.env[name] = value;
          expect(() => otpConfig()).toThrow(name);
        }
      );

      it.each(['-1', '1.5', 'abc', '30s'])(
        'a malformed OTP_RESEND_COOLDOWN_SECONDS (%s) is an error',
        (value) => {
          process.env.OTP_RESEND_COOLDOWN_SECONDS = value;
          expect(() => otpConfig()).toThrow('OTP_RESEND_COOLDOWN_SECONDS');
        }
      );

      it('a cooldown of 0 switches it off, and one as long as the window is allowed', () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
        expect(otpConfig().resendCooldownSeconds).toBe(0);
        process.env.OTP_REQUEST_WINDOW_SECONDS = '900';
        process.env.OTP_RESEND_COOLDOWN_SECONDS = '900';
        expect(otpConfig().resendCooldownSeconds).toBe(900);
      });
    });

    describe('the sign-in mail', () => {
      it('names the product, carries the code and its life in minutes, and needs no link', async () => {
        process.env.OTP_TTL_SECONDS = '600';
        const to = email();
        await requestCode(to);
        const mail = mails.find((m) => m.to === to.toLowerCase())!;

        expect(mail.subject).toBe(`${codeFor(to)} is your Sign-in test sign-in code`);
        expect(mail.html).toContain('Sign-in test sign-in code is');
        expect(mail.html).toContain('expires in 10 minutes');
        expect(mail.html).toMatch(/works once/i);
        expect(mail.html).toMatch(/ignore this email/i);
      });

      it('has no link of its own: the only links are the ones the shared layout puts on every mail', async () => {
        await emails.sendRequired('layout@test.local', 'layout', 'a body without a link');
        const to = email();
        await requestCode(to);
        // The href values and the number of anchors in a message.
        const links = (html: string) => ({
          hrefs: [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
          anchors: (html.match(/<a[\s>]/gi) ?? []).length,
        });
        const layoutOnly = links(mails[0].html);
        const mail = links(mails.find((m) => m.to === to.toLowerCase())!.html);

        expect(mail.hrefs).toEqual(layoutOnly.hrefs);
        expect(mail.anchors).toBe(layoutOnly.anchors);
        expect(JSON.stringify(mail)).not.toContain(codeFor(to));
      });
    });

    describe('POST /auth/token with the email_otp grant', () => {
      it('a new address gets a token pair, cookies, the onboarding header, and an account with a workspace', async () => {
        const { to, res } = await signIn();

        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(
          ['access_token', 'expires_in', 'refresh_token', 'session_id', 'token_type'].sort()
        );
        expect(res.body.token_type).toBe('Bearer');
        expect(res.headers.get('onboarding')).toBe('true');
        const auth = res.cookies.find((c) => c.startsWith('auth='))!;
        const refresh = res.cookies.find((c) => c.startsWith('refresh='))!;
        expect(auth).toContain(`auth=${res.body.access_token}`);
        expect(refresh).toContain(`refresh=${res.body.refresh_token}`);
        expect(refresh).toMatch(/Path=\/auth\/token(;|$)/);

        const user = await worker.user.findFirstOrThrow({ where: { email: to } });
        expect(user).toMatchObject({
          providerName: Provider.LOCAL,
          activated: true,
          password: '',
          deletedAt: null,
        });
        const memberships = await worker.userOrganization.findMany({
          where: { userId: user.id },
          include: { organization: true },
        });
        expect(memberships).toHaveLength(1);
        expect(memberships[0].role).toBe('SUPERADMIN');
        const account = await worker.account.findFirstOrThrow({
          where: { ownerId: user.id },
        });
        expect(memberships[0].organization.accountId).toBe(account.id);
        const claims = JSON.parse(
          Buffer.from(res.body.access_token.split('.')[1], 'base64url').toString()
        );
        expect(claims.sub).toBe(user.id);
        const session = await worker.deviceSession.findUniqueOrThrow({
          where: { id: res.body.session_id },
        });
        expect(session).toMatchObject({ userId: user.id, name: 'Phone' });
      });

      it('an address that has a user signs in as that user: no second user, no new workspace, no onboarding header', async () => {
        const { user, orgId } = await newUser();
        const orgsBefore = await worker.userOrganization.count({ where: { userId: user.id } });
        const { res } = await signIn(user.email.toUpperCase());

        expect(res.status).toBe(200);
        expect(res.headers.get('onboarding')).toBeNull();
        const claims = JSON.parse(
          Buffer.from(res.body.access_token.split('.')[1], 'base64url').toString()
        );
        expect(claims.sub).toBe(user.id);
        expect(await worker.user.count({ where: { email: { equals: user.email, mode: 'insensitive' } } })).toBe(1);
        expect(await worker.userOrganization.count({ where: { userId: user.id } })).toBe(orgsBefore);
        expect(await worker.organization.findUnique({ where: { id: orgId } })).not.toBeNull();
      });

      it('with several users for one address (different providers) signs in as the oldest', async () => {
        const shared = email();
        const oldest = await newUser({ email: shared, providerName: Provider.GITHUB });
        await new Promise((r) => setTimeout(r, 20));
        await newUser({ email: shared, providerName: Provider.GOOGLE });
        const { res } = await signIn(shared);

        const claims = JSON.parse(
          Buffer.from(res.body.access_token.split('.')[1], 'base64url').toString()
        );
        expect(claims.sub).toBe(oldest.user.id);
      });

      it('the same email on a browser and on a phone reaches one user, one workspace and one account, with a session each', async () => {
        const to = email();
        const web = await signIn(to);
        const phone = await signIn(to);

        expect(web.res.status).toBe(200);
        expect(phone.res.status).toBe(200);
        expect(phone.res.headers.get('onboarding')).toBeNull();
        expect(phone.res.body.session_id).not.toBe(web.res.body.session_id);
        const users = await worker.user.findMany({ where: { email: to } });
        expect(users).toHaveLength(1);
        expect(await worker.userOrganization.count({ where: { userId: users[0].id } })).toBe(1);
        expect(await worker.account.count({ where: { ownerId: users[0].id } })).toBe(1);
        const sessions = await worker.deviceSession.findMany({ where: { userId: users[0].id } });
        expect(sessions).toHaveLength(2);
        expect(sessions.every((s) => s.revokedAt === null)).toBe(true);
      });

      it('trims and lower-cases the address of the grant', async () => {
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        const res = await grant(`  ${to.toUpperCase()}  `, codeFor(to), ip);

        expect(res.status).toBe(200);
        expect(await worker.user.count({ where: { email: to } })).toBe(1);
      });

      it('an address stored with capital letters signs in as that user, with no second user', async () => {
        const { user } = await newUser({
          email: `Mixed-${randomUUID()}@Test.Local`,
        });
        process.env.DISABLE_REGISTRATION = 'true';
        const ip = address();
        await requestCode(user.email, ip);
        const res = await grant(user.email, codeFor(user.email), ip);

        expect(res.status).toBe(200);
        expect(res.headers.get('onboarding')).toBeNull();
        const claims = JSON.parse(
          Buffer.from(res.body.access_token.split('.')[1], 'base64url').toString()
        );
        expect(claims.sub).toBe(user.id);
        expect(
          await worker.user.count({
            where: { email: { equals: user.email, mode: 'insensitive' } },
          })
        ).toBe(1);
      });

      it('a user created before activation was removed (not activated) is activated by the code', async () => {
        const { user } = await newUser({ providerName: Provider.LOCAL, activated: false });
        const { res } = await signIn(user.email);

        expect(res.status).toBe(200);
        expect((await worker.user.findUniqueOrThrow({ where: { id: user.id } })).activated).toBe(true);
      });

      it('a deleted user is not signed in: the address is treated as a new one', async () => {
        const { user } = await newUser({ deletedAt: new Date() });
        const { res } = await signIn(user.email);

        expect(res.status).toBe(200);
        expect(res.headers.get('onboarding')).toBe('true');
        expect(await worker.user.count({ where: { email: user.email, deletedAt: null } })).toBe(1);
      });

      it('the code is single use: a second sign-in with the same code is refused', async () => {
        const { to, ip, res } = await signIn();
        expect(res.status).toBe(200);
        const code = (await rowsOf(to))[0];

        const again = await grant(to, codeFor(to), ip);
        expect(again.status).toBe(401);
        expect(again.body).toEqual(INVALID);
        expect(code.consumedAt).not.toBeNull();
        expect(await failures(ip)).toBe(1);
      });

      it('of many concurrent sign-ins with the correct code exactly one succeeds, and only one user is created', async () => {
        const to = email();
        await requestCode(to);
        const code = codeFor(to);
        const results = await Promise.all(
          Array.from({ length: 10 }, () => grant(to, code, address()))
        );

        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        expect(results.filter((r) => r.status === 401)).toHaveLength(9);
        expect(await worker.user.count({ where: { email: to } })).toBe(1);
        expect(await worker.deviceSession.count({ where: { user: { email: to } } })).toBe(1);
      });

      it('a wrong code is 401 INVALID_GRANT and counts one try', async () => {
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        const right = codeFor(to);
        const res = await grant(to, wrongCode(right), ip);

        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID);
        expect((await rowsOf(to))[0].tries).toBe(1);
        expect(await failures(ip)).toBe(1);
        expect((await grant(to, right, ip)).status).toBe(200);
      });

      it('the code dies after OTP_MAX_TRIES wrong values (default 5): a later correct value is refused', async () => {
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        const right = codeFor(to);
        for (let i = 0; i < 5; i++) {
          expect((await grant(to, wrongCode(right), ip)).status).toBe(401);
        }
        const late = await grant(to, right, ip);

        expect(late.status).toBe(401);
        expect(late.body).toEqual(INVALID);
        expect((await rowsOf(to))[0]).toMatchObject({ tries: 5, consumedAt: null });
        expect(await failures(ip)).toBe(6);
        expect(await worker.user.count({ where: { email: to } })).toBe(0);
      });

      it('the number of tries follows OTP_MAX_TRIES', async () => {
        process.env.OTP_MAX_TRIES = '2';
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        const right = codeFor(to);
        await grant(to, wrongCode(right), ip);
        await grant(to, wrongCode(right), ip);

        expect((await grant(to, right, ip)).status).toBe(401);
      });

      it('four wrong values then the right one still succeeds', async () => {
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        const right = codeFor(to);
        for (let i = 0; i < 4; i++) {
          await grant(to, wrongCode(right), ip);
        }

        expect((await grant(to, right, ip)).status).toBe(200);
      });

      it('an expired code is refused', async () => {
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        await worker.emailOtp.updateMany({
          where: { email: to },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
        const res = await grant(to, codeFor(to), ip);

        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID);
        expect(await failures(ip)).toBe(1);
      });

      it('every refusal looks the same: wrong, expired, used, dead and an address that never asked', async () => {
        const answers: Array<{ status: number; body: unknown; keys: string[] }> = [];
        // Records the status, body and cookie names of one refusal for comparison.
        const note = (res: Awaited<ReturnType<typeof grant>>) =>
          answers.push({
            status: res.status,
            body: res.body,
            keys: res.cookies.map((c) => c.split('=')[0]),
          });

        const wrong = email();
        await requestCode(wrong);
        note(await grant(wrong, wrongCode(codeFor(wrong))));

        const expired = email();
        await requestCode(expired);
        await worker.emailOtp.updateMany({ where: { email: expired }, data: { expiresAt: new Date(0) } });
        note(await grant(expired, codeFor(expired)));

        const used = email();
        await signIn(used);
        note(await grant(used, codeFor(used)));

        const dead = email();
        await requestCode(dead);
        for (let i = 0; i < 5; i++) {
          await grant(dead, wrongCode(codeFor(dead)));
        }
        note(await grant(dead, codeFor(dead)));

        note(await grant(email(), '123456'));

        for (const answer of answers) {
          expect(answer).toEqual({ status: 401, body: INVALID, keys: [] });
        }
      });

      it('a code for one address does not work for another', async () => {
        const a = email();
        const b = email();
        const ip = address();
        await requestCode(a, ip);
        await requestCode(b, ip);

        expect((await grant(b, codeFor(a), ip)).status).toBe(401);
        expect((await grant(a, codeFor(a), ip)).status).toBe(200);
      });

      it('answers 400 for an address that is not an email or a code that is not six digits, and checks nothing', async () => {
        const ip = address();
        const to = email();
        await requestCode(to, ip);
        const cases: Array<Record<string, unknown>> = [
          { email: 'nope', code: '123456' },
          { email: to, code: '12345' },
          { email: to, code: '1234567' },
          { email: to, code: 'abcdef' },
          { email: to, code: '12 456' },
          { email: to },
          { code: '123456' },
        ];
        for (const body of cases) {
          const res = await call('POST', '/auth/token', {
            ip,
            body: { grant_type: 'email_otp', ...body },
          });
          expect(res.status).toBe(400);
        }
        expect((await rowsOf(to))[0].tries).toBe(0);
        expect(await failures(ip)).toBe(0);
      });
    });

    describe('failed-attempt limit', () => {
      it('a refusal is recorded as a sign_in failure of the client address', async () => {
        const ip = address();
        await grant(email(), '123456', ip);
        await grant(email(), '123456', ip);

        expect(await failures(ip)).toBe(2);
      });

      it('after AUTH_FAIL_LIMIT failures even the correct code gets 429 with Retry-After and is not checked', async () => {
        process.env.AUTH_FAIL_LIMIT = '3';
        const to = email();
        await requestCode(to);
        const right = codeFor(to);
        const ip = address();
        for (let i = 0; i < 3; i++) {
          expect((await grant(email(), '123456', ip)).status).toBe(401);
        }
        const limited = await grant(to, right, ip);

        expect(limited.status).toBe(429);
        expect(limited.body).toEqual({ statusCode: 429, code: 'AUTH_RATE_LIMITED' });
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
        expect((await rowsOf(to))[0]).toMatchObject({ tries: 0, consumedAt: null });
        expect((await grant(to, right, address())).status).toBe(200);
      });

      it('parallel wrong attempts from one address are all counted: none slips past the limit', async () => {
        process.env.AUTH_FAIL_LIMIT = '4';
        const ip = address();
        const results = await Promise.all(
          Array.from({ length: 10 }, () => grant(email(), '123456', ip))
        );

        expect(results.filter((r) => r.status === 401)).toHaveLength(4);
        expect(results.filter((r) => r.status === 429)).toHaveLength(6);
      });

      it('a successful sign-in counts nothing', async () => {
        const ip = address();
        await signIn(email(), ip);

        expect(await failures(ip)).toBe(0);
      });
    });

    describe('create failures', () => {
      it('a workspace that cannot be linked to its account fails the request with 400 and writes no session', async () => {
        jest
          .spyOn(accounts, 'attachOrganizationToOwner')
          .mockRejectedValue(new Error('account store down'));
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        const res = await grant(to, codeFor(to), ip);

        expect(res.status).toBe(400);
        expect(res.cookies).toEqual([]);
        expect(res.text).not.toContain('account store down');
        expect(await worker.deviceSession.count({ where: { user: { email: to } } })).toBe(0);
      });

      it('registration disabled after the code was sent still refuses a new address', async () => {
        await newUser();
        const to = email();
        const ip = address();
        await requestCode(to, ip);
        process.env.DISABLE_REGISTRATION = 'true';
        const res = await grant(to, codeFor(to), ip);

        expect(res.status).toBe(400);
        expect(res.cookies).toEqual([]);
        expect(await worker.user.count({ where: { email: to } })).toBe(0);
      });
    });

    describe('removed password sign-in', () => {
      it.each([
        ['/auth/register'],
        ['/auth/login'],
        ['/auth/forgot'],
        ['/auth/forgot-return'],
        ['/auth/activate'],
        ['/auth/resend-activation'],
      ])('POST %s answers 404 and counts nothing', async (path) => {
        const ip = address();
        const res = await call('POST', path, {
          ip,
          body: { email: email(), password: 'hunter2-secret', provider: 'LOCAL', code: 'x' },
        });

        expect(res.status).toBe(404);
        expect(await failures(ip)).toBe(0);
      });

      it('the password grant is not a grant type', async () => {
        const ip = address();
        const res = await call('POST', '/auth/token', {
          ip,
          body: { grant_type: 'password', email: email(), password: 'hunter2-secret' },
        });

        expect(res.status).toBe(400);
        expect(res.cookies).toEqual([]);
      });

      it('a password field in an email_otp body signs nobody in without the code', async () => {
        const { user } = await newUser({ providerName: Provider.LOCAL });
        const res = await call('POST', '/auth/token', {
          body: { grant_type: 'email_otp', email: user.email, code: '123456', password: 'x' },
        });

        expect(res.status).toBe(401);
      });

      it('the resend-activation request type no longer exists', () => {
        expect(() =>
          jest.requireActual(
            '@gitroom/nestjs-libraries/dtos/auth/resend-activation.dto'
          )
        ).toThrow();
      });

      it('GET /auth/can-register is unchanged', async () => {
        const res = await call('GET', '/auth/can-register');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ register: true });
      });
    });
  });

  describe.each([
    ['API role', () => process.env.TEST_DATABASE_API_URL!],
    ['worker role', () => url!],
  ])('EmailOtpService (%s)', (_role, databaseUrl) => {
    let prisma: PrismaService;
    let otp: EmailOtpService;
    let repository: EmailOtpRepository;

    beforeAll(async () => {
      const previous = process.env.DATABASE_URL;
      process.env.DATABASE_URL = databaseUrl();
      prisma = new PrismaService();
      await prisma.$connect();
      process.env.DATABASE_URL = previous;
      const built = build(prisma);
      otp = built.otp;
      repository = built.emailOtpRepository;
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('request then verify creates the user, workspace and account for a new address', async () => {
      const to = email();
      const ip = address();
      await otp.request(` ${to.toUpperCase()}`, ip);
      const result = await otp.verify(to.toUpperCase(), codeFor(to), ip);

      expect(result.created).toBe(true);
      const user = await worker.user.findUniqueOrThrow({ where: { id: result.userId } });
      expect(user.email).toBe(to);
      const org = await worker.organization.findFirstOrThrow({
        where: { users: { some: { userId: user.id } } },
      });
      expect(org.accountId).not.toBeNull();
    });

    it('verify for an address with a user returns that user with created false', async () => {
      const { user } = await newUser();
      const ip = address();
      await otp.request(user.email, ip);
      const result = await otp.verify(user.email, codeFor(user.email), ip);

      expect(result).toEqual({ userId: user.id, created: false });
    });

    it('every refusal is INVALID_GRANT', async () => {
      const ip = address();
      await expect(otp.verify(email(), '123456', ip)).rejects.toMatchObject({
        status: 401,
        response: INVALID_GRANT,
      });
    });

    // Makes the next lookup of a usable code return the row and then change it in the database, as another
    // request does between a lookup and the use of the code.
    const changeAfterLookup = (data: Record<string, unknown>) => {
      const lookup = repository.findUsable.bind(repository);
      // Looks the code up as the repository does, then changes the row.
      const lookupThenChange = async (...args: Parameters<typeof lookup>) => {
        const row = await lookup(...args);
        await worker.emailOtp.update({ where: { id: row!.id }, data });
        return row;
      };
      jest
        .spyOn(repository, 'findUsable')
        .mockImplementationOnce(lookupThenChange as unknown as typeof lookup);
    };

    it('a code that expires after it was looked up is refused', async () => {
      const to = email();
      const ip = address();
      await otp.request(to, ip);
      changeAfterLookup({ expiresAt: new Date(Date.now() - 1000) });

      await expect(otp.verify(to, codeFor(to), ip)).rejects.toMatchObject({
        status: 401,
        response: INVALID_GRANT,
      });
      expect(await worker.user.count({ where: { email: to } })).toBe(0);
    });

    it('a code that has used up its tries after it was looked up is refused', async () => {
      const to = email();
      const ip = address();
      await otp.request(to, ip);
      changeAfterLookup({ tries: otpConfig().maxTries });

      await expect(otp.verify(to, codeFor(to), ip)).rejects.toMatchObject({
        status: 401,
        response: INVALID_GRANT,
      });
      expect(await worker.user.count({ where: { email: to } })).toBe(0);
    });

    it('a code that was used after it was looked up is refused', async () => {
      const to = email();
      const ip = address();
      await otp.request(to, ip);
      changeAfterLookup({ consumedAt: new Date() });

      await expect(otp.verify(to, codeFor(to), ip)).rejects.toMatchObject({
        status: 401,
        response: INVALID_GRANT,
      });
      expect(await worker.user.count({ where: { email: to } })).toBe(0);
    });

    it('a padded, upper-case address is the same address for request and verify', async () => {
      const to = email();
      const ip = address();
      await otp.request(`  ${to.toUpperCase()}  `, ip);
      const result = await otp.verify(`  ${to.toUpperCase()}  `, codeFor(to), ip);

      expect(result.created).toBe(true);
      expect(await worker.user.count({ where: { email: to } })).toBe(1);
    });

    it('of concurrent verify calls with the correct code exactly one succeeds', async () => {
      const to = email();
      await otp.request(to, address());
      const code = codeFor(to);
      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, () => otp.verify(to, code, address()))
      );

      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      expect(await worker.user.count({ where: { email: to } })).toBe(1);
    });

    // Stores a code row for an address directly, unused, unexpired and with no tries counted unless the
    // data says otherwise.
    const storeCode = (to: string, data: Record<string, unknown> = {}) =>
      worker.emailOtp.create({
        data: {
          email: to,
          codeHash: 'stored-hash-' + randomUUID(),
          expiresAt: new Date(Date.now() + 600_000),
          requestIp: address(),
          ...data,
        },
      });

    describe('findUsable', () => {
      it('answers an unused, unexpired code that has tries left', async () => {
        const to = email();
        const row = await storeCode(to, { tries: otpConfig().maxTries - 1 });

        const found = await repository.findUsable(
          to,
          new Date(),
          otpConfig().maxTries
        );
        expect(found?.id).toBe(row.id);
      });

      it('answers nothing for an expired code', async () => {
        const to = email();
        await storeCode(to, { expiresAt: new Date(Date.now() - 1000) });

        expect(
          await repository.findUsable(to, new Date(), otpConfig().maxTries)
        ).toBeNull();
      });

      it('answers nothing for a code that has been used', async () => {
        const to = email();
        await storeCode(to, { consumedAt: new Date() });

        expect(
          await repository.findUsable(to, new Date(), otpConfig().maxTries)
        ).toBeNull();
      });

      it('answers nothing for a code that has used up its tries', async () => {
        const to = email();
        await storeCode(to, { tries: otpConfig().maxTries });

        expect(
          await repository.findUsable(to, new Date(), otpConfig().maxTries)
        ).toBeNull();
      });

      it('answers nothing for the code of another address', async () => {
        await storeCode(email());

        expect(
          await repository.findUsable(email(), new Date(), otpConfig().maxTries)
        ).toBeNull();
      });

      it('answers the newest of two unused codes', async () => {
        const to = email();
        const now = Date.now();
        await storeCode(to, { createdAt: new Date(now - 60_000) });
        const newest = await storeCode(to, { createdAt: new Date(now - 1000) });
        await storeCode(to, { createdAt: new Date(now - 120_000) });

        const found = await repository.findUsable(
          to,
          new Date(),
          otpConfig().maxTries
        );
        expect(found?.id).toBe(newest.id);
      });
    });

    describe('addTry', () => {
      it('counts one wrong value against the code', async () => {
        const row = await storeCode(email());

        await repository.addTry(row.id, otpConfig().maxTries);
        await repository.addTry(row.id, otpConfig().maxTries);

        expect(
          (await worker.emailOtp.findUniqueOrThrow({ where: { id: row.id } }))
            .tries
        ).toBe(2);
      });

      it('counts nothing past the tries allowed', async () => {
        const { maxTries } = otpConfig();
        const row = await storeCode(email(), { tries: maxTries });

        await repository.addTry(row.id, maxTries);

        expect(
          (await worker.emailOtp.findUniqueOrThrow({ where: { id: row.id } }))
            .tries
        ).toBe(maxTries);
      });

      it('counts nothing against a code that has been used', async () => {
        const row = await storeCode(email(), { consumedAt: new Date() });

        await repository.addTry(row.id, otpConfig().maxTries);

        expect(
          (await worker.emailOtp.findUniqueOrThrow({ where: { id: row.id } }))
            .tries
        ).toBe(0);
      });
    });
  });
});

const INVALID_GRANT = { statusCode: 401, code: 'INVALID_GRANT' };
