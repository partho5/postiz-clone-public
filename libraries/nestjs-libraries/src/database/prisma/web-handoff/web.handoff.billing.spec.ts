// api.web-handoff / api.entitlements (E4): the `billing` target of POST /public/v1/web-link. A link opens
// `/billing?tier=<KEY>` in a workspace whose account the user owns: the active one, else the oldest of their
// own, else a 403 NOT_ACCOUNT_OWNER. Runs the real service and accounts service on hand-made repositories and
// an in-memory link store; needs no database and no Redis.
import { BadRequestException, HttpException } from '@nestjs/common';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { WebHandoffGrant } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.repository';
import { WebHandoffService } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.service';

// Modules that pull ESM-only packages or connect at import; nothing here calls them
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
  socialIntegrationList: [],
}));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {},
}));

const USER = 'user-1';
const OTHER_USER = 'user-2';
const SESSION = 'session-1';
// The active workspace of the call, and the workspace the user's own account has.
const ACTIVE = '11111111-1111-4111-8111-111111111111';
const OWN = '22222222-2222-4222-8222-222222222222';

describe('api.web-handoff: the billing target', () => {
  let saved: Array<{ hash: string; grant: WebHandoffGrant; ttl: number }>;
  let store: Map<string, WebHandoffGrant>;
  let integrations: { isHiddenProvider: jest.Mock };
  let accountsRepository: any;
  let service: WebHandoffService;
  const env = process.env.FRONTEND_URL;

  // Which account each workspace is in, and who owns each account.
  const workspaceAccount: Record<string, string | null> = {};
  const accountOwner: Record<string, string> = {};

  // Who owns the account of the active workspace, and the workspace the user's own account has (null: none).
  const accounts = (activeOwner: string, owned: string | null) => {
    workspaceAccount[ACTIVE] = 'account-active';
    accountOwner['account-active'] = activeOwner;
    accountsRepository.getOwnedOrganization.mockResolvedValue(
      owned ? { id: owned } : null
    );
  };

  // The `next` page a link redeems to, using it once.
  const redeemed = async (url: string) =>
    service.redeem(url.split('code=')[1]);

  beforeEach(() => {
    saved = [];
    store = new Map();
    Object.keys(workspaceAccount).forEach((id) => delete workspaceAccount[id]);
    Object.keys(accountOwner).forEach((id) => delete accountOwner[id]);
    integrations = { isHiddenProvider: jest.fn().mockReturnValue(false) };
    accountsRepository = {
      getOrganizationAccountId: jest.fn(async (id: string) =>
        id in workspaceAccount ? { accountId: workspaceAccount[id] } : null
      ),
      getAccountById: jest.fn(async (id: string) =>
        id in accountOwner ? { id, ownerId: accountOwner[id] } : null
      ),
      getOwnedOrganization: jest.fn(),
    };
    service = new WebHandoffService(
      {
        save: async (hash: string, grant: WebHandoffGrant, ttl: number) => {
          saved.push({ hash, grant, ttl });
          store.set(hash, grant);
        },
        take: async (hash: string) => {
          const grant = store.get(hash) ?? null;
          store.delete(hash);
          return grant;
        },
      } as any,
      integrations as any,
      { findById: jest.fn(async () => ({ name: 'Pixel 8' })) } as any,
      new AccountsService(accountsRepository),
      {} as any
    );
    process.env.FRONTEND_URL = 'https://app.test/';
  });

  afterEach(() => {
    if (env === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = env;
    }
  });

  describe('the workspace of the link', () => {
    it('is the active one when the user owns its account, and looks no further', async () => {
      accounts(USER, OWN);

      const { url } = await service.createLink(USER, ACTIVE, SESSION, 'billing', 'PRO');

      expect(saved).toHaveLength(1);
      expect(saved[0].grant).toEqual({
        userId: USER,
        organizationId: ACTIVE,
        next: `/w/${ACTIVE}/billing?tier=PRO`,
        deviceName: 'Pixel 8',
      });
      expect(accountsRepository.getOwnedOrganization).not.toHaveBeenCalled();
      expect(url).toMatch(/^https:\/\/app\.test\/auth\/continue\?code=[A-Za-z0-9_-]{43}$/);
    });

    it('is the first workspace of an account the user owns when the active one is in another account', async () => {
      accounts(OTHER_USER, OWN);

      await service.createLink(USER, ACTIVE, SESSION, 'billing', 'STARTER');

      expect(accountsRepository.getOwnedOrganization).toHaveBeenCalledWith(USER);
      expect(saved[0].grant.organizationId).toBe(OWN);
      expect(saved[0].grant.next).toBe(`/w/${OWN}/billing?tier=STARTER`);
    });

    it('is a 403 NOT_ACCOUNT_OWNER when the user owns the account of no workspace, and no link is made', async () => {
      accounts(OTHER_USER, null);

      const err = await service
        .createLink(USER, ACTIVE, SESSION, 'billing', 'PRO')
        .catch((e) => e);

      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(403);
      expect(err.getResponse()).toEqual({
        statusCode: 403,
        code: 'NOT_ACCOUNT_OWNER',
        message: 'Only the account owner can manage the plan',
      });
      expect(saved).toEqual([]);
      expect(store.size).toBe(0);
    });
  });

  describe('the link', () => {
    it('opens the plans page on the tier', async () => {
      accounts(USER, null);

      await service.createLink(USER, ACTIVE, SESSION, 'billing', 'AGENCY');

      expect(saved[0].grant.next).toBe(`/w/${ACTIVE}/billing?tier=AGENCY`);
    });

    it('lasts 60 seconds and is stored under a hash, never the code', async () => {
      accounts(USER, null);

      const { url } = await service.createLink(USER, ACTIVE, SESSION, 'billing', 'PRO');

      expect(saved[0].ttl).toBe(60);
      expect(saved[0].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(url).not.toContain(saved[0].hash);
    });

    it('redeems once to the plans page of the chosen workspace, then never again', async () => {
      accounts(OTHER_USER, OWN);
      const { url } = await service.createLink(USER, ACTIVE, SESSION, 'billing', 'PRO');

      const first = await redeemed(url);
      const second = await redeemed(url);

      expect(first).toEqual({
        userId: USER,
        next: `/w/${OWN}/billing?tier=PRO`,
        sessionName: 'Web browser (from Pixel 8)',
      });
      expect(second).toBeNull();
    });

    it('is never asked about providers: a tier key is no provider', async () => {
      accounts(USER, null);

      await service.createLink(USER, ACTIVE, SESSION, 'billing', 'PRO');

      expect(integrations.isHiddenProvider).not.toHaveBeenCalled();
    });
  });

  describe('credentials and connect', () => {
    it('keep the request\'s workspace and their pages, and need no account of the user', async () => {
      accounts(OTHER_USER, null);

      await service.createLink(USER, ACTIVE, SESSION, 'credentials', 'facebook');
      await service.createLink(USER, ACTIVE, SESSION, 'connect', 'linkedin-page');

      expect(saved.map((s) => s.grant.next)).toEqual([
        `/w/${ACTIVE}/settings?tab=app_credentials&provider=facebook`,
        `/w/${ACTIVE}/launches?connect=linkedin-page`,
      ]);
      expect(saved.every((s) => s.grant.organizationId === ACTIVE)).toBe(true);
      expect(accountsRepository.getOrganizationAccountId).not.toHaveBeenCalled();
      expect(accountsRepository.getOwnedOrganization).not.toHaveBeenCalled();
    });

    it('still refuse a hidden provider with a 400', async () => {
      integrations.isHiddenProvider.mockReturnValue(true);

      for (const target of ['credentials', 'connect'] as const) {
        const err = await service
          .createLink(USER, ACTIVE, SESSION, target, 'facebook')
          .catch((e) => e);

        expect(err).toBeInstanceOf(BadRequestException);
      }
      expect(saved).toEqual([]);
    });
  });
});
