// tenancy.account-attach: every new workspace belongs to its creator's account from the moment it is created.
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { OrganizationRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersRepository } from '@gitroom/nestjs-libraries/database/prisma/users/users.repository';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { CreateOrgUserDto } from '@gitroom/nestjs-libraries/dtos/auth/create.org.user.dto';
import { AuthService } from '@gitroom/backend/services/auth/auth.service';
import { AuthTokenController } from '@gitroom/backend/api/routes/auth.token.controller';
import { EmailOtpRepository } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.repository';
import { EmailOtpService } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.service';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';
import { DeviceSessionsRepository } from '@gitroom/nestjs-libraries/database/prisma/device-sessions/device.sessions.repository';
import { EnterpriseController } from '@gitroom/backend/api/routes/enterprise.controller';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { PrismaClient, Provider } from '@prisma/client';
import { randomUUID } from 'crypto';

// Modules that pull ESM-only packages ts-jest cannot load; the create paths
// under test never call them, the controllers only name them as dependencies
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
  () => ({
    PostsService: class {},
  })
);
jest.mock(
  '@gitroom/nestjs-libraries/integrations/social/farcaster.provider',
  () => ({
    FarcasterProvider: class {},
  })
);

// Runs against a real, disposable Postgres, migrated by the jest global setup.
// The create paths run as the API role, like the backend.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('tenancy.account-attach (Postgres)', () => {
  let prisma: PrismaService;
  let worker: PrismaClient;
  let accounts: AccountsService;
  let organizations: OrganizationService;
  let auth: AuthService;
  let tokenController: AuthTokenController;
  let otp: EmailOtpService;
  let mailed: Array<{ to: string; html: string }>;
  let enterprise: EnterpriseController;
  let providerUser: { id: string; email: string };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'account-attach-spec';
    process.env.FRONTEND_URL =
      process.env.FRONTEND_URL || 'http://localhost:4200';
    delete process.env.DISABLE_REGISTRATION;
    delete process.env.DISALLOW_PLUS;
    prisma = new PrismaService();
    await prisma.$connect();
    worker = new PrismaClient({ datasourceUrl: url });

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
    // The notification service: reports that no email provider is set up
    const notifications = {
      // Says no email provider is configured.
      hasEmailProvider: () => false,
    } as any;
    // The social login provider: returns the user the test sets
    const providers = {
      // Hands back a provider whose user is the one the test set.
      getProvider: () => ({
        // Returns the user the test set.
        getUser: async () => providerUser,
      }),
    } as any;

    accounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    organizations = new OrganizationService(
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
    auth = new AuthService(users, organizations, providers, accounts);
    // Sessions are real (a sign-in issues one); the failed-attempt limiter is a stand-in, it needs Redis
    const limiter = {
      // Lets every attempt through.
      assertAllowed: async (): Promise<void> => undefined,
      // Counts nothing.
      recordFailure: async (): Promise<void> => undefined,
    } as any;
    otp = new EmailOtpService(
      new EmailOtpRepository(repo, repo, new PrismaTransaction(prisma)),
      emails,
      users,
      auth,
      limiter
    );
    tokenController = new AuthTokenController(
      new TokenService(new DeviceSessionsRepository(repo)),
      {} as any,
      limiter,
      otp,
      {} as any
    );
    enterprise = new EnterpriseController(
      {} as any,
      organizations,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await worker.$disconnect();
  });

  // A fresh, unused email address.
  const email = () => randomUUID() + '@test.local';

  // A client address of its own, so the per-address request limit never leaks between sign-ups
  const clientIp = () =>
    `10.${Math.floor(Math.random() * 250)}.${Math.floor(
      Math.random() * 250
    )}.${Math.floor(Math.random() * 250)}`;

  // The code in the newest message mailed to an address.
  const codeFor = (address: string) =>
    [...mailed]
      .reverse()
      .find((m) => m.to === address)!
      .html.match(/<strong>(\d{6})<\/strong>/)![1];

  // Signs an address up by one-time code: asks for the code, mails it, exchanges it.
  const signUpByCode = async (address: string) => {
    const ip = clientIp();
    await otp.request(address, ip);
    return otp.verify(address, codeFor(address), ip);
  };

  // A response that records what the controller answered
  const response = () => {
    const res: any = { statusCode: 0, body: undefined as unknown };
    // Records the status code.
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    // Records the body.
    res.json = (body: unknown) => {
      res.body = body;
      return res;
    };
    // Records the body, as `json` does.
    res.send = res.json;
    // Ignores the header.
    res.header = () => res;
    // Ignores the cookie.
    res.cookie = () => res;
    return res;
  };

  // The workspaces a user is a member of, with their account link
  const workspacesOf = (userId: string) =>
    prisma.organization.findMany({
      where: { users: { some: { userId } } },
      select: { id: true, accountId: true },
    });

  // The stored user with an email address.
  const userByEmail = (address: string) =>
    prisma.user.findFirstOrThrow({ where: { email: address } });

  // Asserts the user's single workspace is linked to the user's own account
  const expectAttachedToOwnAccount = async (userId: string) => {
    const [workspace, ...rest] = await workspacesOf(userId);
    expect(rest).toEqual([]);
    expect(workspace.accountId).not.toBeNull();
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: workspace.accountId! },
    });
    expect(account.ownerId).toBe(userId);
    return { organizationId: workspace.id, accountId: account.id };
  };

  // A workspace created outside the create paths (before accounts existed)
  const legacyWorkspace = async () => {
    const org = await prisma.organization.create({
      data: {
        name: 'legacy-' + randomUUID(),
        users: {
          create: {
            role: 'SUPERADMIN',
            user: {
              create: { email: email(), providerName: 'LOCAL', timezone: 0 },
            },
          },
        },
      },
      select: { id: true, users: { select: { userId: true } } },
    });
    return { organizationId: org.id, ownerId: org.users[0].userId };
  };

  describe('one-time-code sign-up', () => {
    it('links the new workspace to the new user account before returning, with no credit use', async () => {
      const address = email();
      const result = await signUpByCode(address);
      expect(result.created).toBe(true);

      const user = await userByEmail(address);
      const { accountId } = await expectAttachedToOwnAccount(user.id);
      const [buckets, ledgers] = await Promise.all([
        worker.creditBucket.count({ where: { accountId } }),
        worker.creditLedger.count({ where: { accountId } }),
      ]);
      expect({ buckets, ledgers }).toEqual({ buckets: 0, ledgers: 0 });
    });

    it('POST /auth/token with the email_otp grant answers with a session and the workspace already attached', async () => {
      const address = email();
      const ip = clientIp();
      await otp.request(address, ip);
      const res = response();
      const pair = await tokenController.token(
        { grant_type: 'email_otp', email: address, code: codeFor(address) } as any,
        { cookies: {} } as any,
        res,
        ip,
        'jest'
      );
      expect(typeof pair.access_token).toBe('string');
      await expectAttachedToOwnAccount((await userByEmail(address)).id);
    });

    it('gives two users two different accounts', async () => {
      const first = email();
      const second = email();
      await Promise.all([first, second].map((address) => signUpByCode(address)));
      const a = await expectAttachedToOwnAccount((await userByEmail(first)).id);
      const b = await expectAttachedToOwnAccount(
        (
          await userByEmail(second)
        ).id
      );
      expect(a.accountId).not.toBe(b.accountId);
    });
  });

  describe('provider sign-up', () => {
    it('links the new workspace to the new user account before returning', async () => {
      providerUser = { id: 'provider-' + randomUUID(), email: email() };
      const result = await auth.routeAuth(
        Provider.GITHUB,
        Object.assign(new CreateOrgUserDto(), {
          providerToken: 'token',
          company: 'ws-' + randomUUID(),
        }),
        '127.0.0.1',
        'jest'
      );
      expect(typeof result.jwt).toBe('string');
      await expectAttachedToOwnAccount(
        (
          await userByEmail(providerUser.email)
        ).id
      );
    });

    it('a returning provider user creates no workspace and no account', async () => {
      providerUser = { id: 'provider-' + randomUUID(), email: email() };
      const body = Object.assign(new CreateOrgUserDto(), {
        providerToken: 'token',
        company: 'ws-' + randomUUID(),
      });
      await auth.routeAuth(Provider.GITHUB, body, '127.0.0.1', 'jest');
      const user = await userByEmail(providerUser.email);
      const before = await workspacesOf(user.id);

      await auth.routeAuth(Provider.GITHUB, body, '127.0.0.1', 'jest');
      expect(await workspacesOf(user.id)).toEqual(before);
      expect(await prisma.account.count({ where: { ownerId: user.id } })).toBe(
        1
      );
    });
  });

  describe('enterprise createMaxUser', () => {
    it('links the new workspace to the account of the user it creates', async () => {
      const saasName = 'saas' + randomUUID().slice(0, 8);
      const created = await organizations.createMaxUser(
        randomUUID(),
        'Enterprise',
        saasName,
        email()
      );
      expect(Object.keys(created).sort()).toEqual(['id']);

      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: created.id },
        select: {
          accountId: true,
          users: { select: { userId: true, role: true } },
        },
      });
      expect(org.users).toEqual([
        expect.objectContaining({ role: 'SUPERADMIN' }),
      ]);
      const account = await prisma.account.findUniqueOrThrow({
        where: { id: org.accountId! },
      });
      expect(account.ownerId).toBe(org.users[0].userId);
    });

    it('POST /enterprise/create-user returns the attached workspace', async () => {
      const result: any = await enterprise.createUser(
        AuthChecker.signJWT({
          id: randomUUID(),
          name: 'Enterprise',
          saasName: 'saas' + randomUUID().slice(0, 8),
          email: email(),
        })
      );
      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: result.id },
        select: { accountId: true },
      });
      expect(org.accountId).not.toBeNull();
    });
  });

  describe('invites', () => {
    it('joining a workspace by invite never changes its account', async () => {
      const ownerEmail = email();
      await signUpByCode(ownerEmail);
      const owner = await expectAttachedToOwnAccount(
        (
          await userByEmail(ownerEmail)
        ).id
      );

      // A new user signs up from an invite: gets a workspace of their own and joins the owner's
      providerUser = { id: 'provider-' + randomUUID(), email: email() };
      const invited = providerUser.email;
      const result = await auth.routeAuth(
        Provider.GITHUB,
        Object.assign(new CreateOrgUserDto(), {
          providerToken: 'token',
          company: 'ws-' + randomUUID(),
        }),
        '127.0.0.1',
        'jest',
        { orgId: owner.organizationId, role: 'ADMIN', id: randomUUID() }
      );
      expect(result.addedOrg).toBeTruthy();

      const shared = await prisma.organization.findUniqueOrThrow({
        where: { id: owner.organizationId },
        select: { accountId: true },
      });
      expect(shared.accountId).toBe(owner.accountId);

      const invitedUser = await userByEmail(invited);
      const own = (await workspacesOf(invitedUser.id)).find(
        (w) => w.id !== owner.organizationId
      )!;
      const invitedAccount = await prisma.account.findUniqueOrThrow({
        where: { ownerId: invitedUser.id },
      });
      expect(own.accountId).toBe(invitedAccount.id);
      expect(invitedAccount.id).not.toBe(owner.accountId);

      // An existing user accepting an invite
      const existing = email();
      await signUpByCode(existing);
      await organizations.addUserToOrg(
        (
          await userByEmail(existing)
        ).id,
        randomUUID(),
        owner.organizationId,
        'USER'
      );
      const after = await prisma.organization.findUniqueOrThrow({
        where: { id: owner.organizationId },
        select: { accountId: true },
      });
      expect(after.accountId).toBe(owner.accountId);
    });
  });

  describe('attachOrganizationToOwner', () => {
    it('concurrent creates by one user produce one account holding every workspace', async () => {
      const { ownerId, organizationId } = await legacyWorkspace();
      const more = await Promise.all(
        Array.from({ length: 5 }, () =>
          prisma.organization.create({
            data: {
              name: 'ws-' + randomUUID(),
              users: { create: { role: 'SUPERADMIN', userId: ownerId } },
            },
            select: { id: true },
          })
        )
      );
      const ids = [organizationId, ...more.map((o) => o.id)];

      const accountIds = await Promise.all(
        ids.map((id) => accounts.attachOrganizationToOwner(id, ownerId))
      );
      expect(new Set(accountIds).size).toBe(1);
      expect(await prisma.account.count({ where: { ownerId } })).toBe(1);
      const linked = await prisma.organization.findMany({
        where: { id: { in: ids } },
        select: { accountId: true },
      });
      expect(linked.map((o) => o.accountId)).toEqual(
        ids.map(() => accountIds[0])
      );
    });

    it('never moves a workspace that already belongs to an account', async () => {
      const first = await legacyWorkspace();
      const other = await legacyWorkspace();
      const accountId = await accounts.attachOrganizationToOwner(
        first.organizationId,
        first.ownerId
      );

      expect(
        await accounts.attachOrganizationToOwner(
          first.organizationId,
          other.ownerId
        )
      ).toBe(accountId);
      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: first.organizationId },
        select: { accountId: true },
      });
      expect(org.accountId).toBe(accountId);
    });

    it('keeps the lazy attach for a workspace created before accounts', async () => {
      const { organizationId, ownerId } = await legacyWorkspace();
      const accountId = await accounts.getAccountIdForOrganization(
        organizationId
      );
      const account = await prisma.account.findUniqueOrThrow({
        where: { id: accountId },
      });
      expect(account.ownerId).toBe(ownerId);
    });
  });

  describe('attach failure', () => {
    // Makes every attach to an account fail with an unavailable account store.
    const failAttach = () =>
      jest
        .spyOn(accounts, 'attachOrganizationToOwner')
        .mockRejectedValue(new Error('account store unavailable'));

    it('one-time-code sign-up fails and returns no session', async () => {
      failAttach();
      await expect(signUpByCode(email())).rejects.toMatchObject({ status: 400 });
    });

    it('POST /auth/token with the email_otp grant answers 400; the leftover workspace is attached lazily to its creator', async () => {
      failAttach();
      const address = email();
      const ip = clientIp();
      await otp.request(address, ip);
      const res = response();
      await expect(
        tokenController.token(
          { grant_type: 'email_otp', email: address, code: codeFor(address) } as any,
          { cookies: {} } as any,
          res,
          ip,
          'jest'
        )
      ).rejects.toMatchObject({ status: 400 });

      jest.restoreAllMocks();
      const user = await userByEmail(address);
      const [workspace] = await workspacesOf(user.id);
      expect(workspace.accountId).toBeNull();
      const accountId = await accounts.getAccountIdForOrganization(
        workspace.id
      );
      const account = await prisma.account.findUniqueOrThrow({
        where: { id: accountId },
      });
      expect(account.ownerId).toBe(user.id);
    });

    it('POST /enterprise/create-user answers { create: false } and returns no workspace', async () => {
      failAttach();
      const result = await enterprise.createUser(
        AuthChecker.signJWT({
          id: randomUUID(),
          name: 'Enterprise',
          saasName: 'saas' + randomUUID().slice(0, 8),
          email: email(),
        })
      );
      expect(result).toEqual({ create: false });
    });
  });
});
