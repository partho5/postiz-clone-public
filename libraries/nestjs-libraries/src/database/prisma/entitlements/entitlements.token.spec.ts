// api.entitlements (E2): GET /entitlements. Runs the real controller, token service, entitlements service,
// pricing service and signer on hand-made repositories, with real access tokens; needs no database.
// The cases of the signer alone are in entitlement.token.signer.spec.ts.
import * as fs from 'fs';
import * as path from 'path';
import { Logger, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { generateKeyPairSync, verify } from 'crypto';
import { sign } from 'jsonwebtoken';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { ThrottlerRealIpGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import {
  FEATURE_KEYS,
  PRICING,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { EntitlementTokenSigner } from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlement.token.signer';
import { EntitlementsService } from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlements.service';
import { EntitlementsController } from '@gitroom/backend/api/routes/entitlements.controller';
import { TokenService } from '@gitroom/backend/services/auth/tokens/token.service';

// Modules that pull ESM-only packages ts-jest cannot load; nothing here calls them
jest.mock('file-type', () => ({}));
jest.mock('@gitroom/nestjs-libraries/chat/mastra.service', () => ({
  MastraService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {},
}));

const USER = 'user-1';
const SESSION = 'session-1';
const ORG = 'org-1';
const OTHER_ORG = 'org-2';

const pricing = () => new PricingService({} as any, {} as any, {} as any);
const rankOf = (plan: string) =>
  pricing()
    .plans()
    .findIndex((p) => p.key === plan);

// A workspace of the user as `getOrgsByUserId` lists it
const workspace = (id: string, disabled = false) => ({
  id,
  users: [{ disabled, role: 'ADMIN' }],
});

const now = () => Math.floor(Date.now() / 1000);

// A device access token as `/auth/token` issues it
const accessToken = (claims: Record<string, unknown> = {}) =>
  AuthService.signJWT({
    sub: USER,
    sid: SESSION,
    iat: now(),
    exp: now() + 900,
    ...claims,
  });

// Splits a compact JWS into its decoded header and payload and what was signed
const decode = (token: string) => {
  const [header, payload, signature] = token.split('.');
  const json = (part: string) =>
    JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return {
    header: json(header),
    payload: json(payload),
    signature,
    signingInput: `${header}.${payload}`,
  };
};

describe('api.entitlements: GET /entitlements', () => {
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'ENTITLEMENT_SIGNING_KEY',
    'ENTITLEMENT_KEY_ID',
    'JWT_SECRET',
    'NODE_ENV',
  ];
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  let repo: any;
  let sessions: any;
  let users: any;
  let organizations: any;
  let controller: EntitlementsController;

  // The plan the user's own account has and the plan of the workspace's account (null: no such account)
  const plans = (own: string | null, ofWorkspace: string | null) => {
    repo.ownPlan.mockResolvedValue(own);
    repo.workspacePlan.mockResolvedValue(ofWorkspace);
  };

  // The controller over real services, with the token service replaced when a case needs it
  const build = (tokenService: any = new TokenService(sessions)) =>
    new EntitlementsController(
      tokenService,
      users,
      organizations,
      new EntitlementsService(repo, pricing(), new EntitlementTokenSigner())
    );

  // The app's call: the Authorization and x-workspace-id headers
  const call = (authorization?: string, workspaceId?: string) =>
    controller.getEntitlements(authorization, workspaceId);

  // Expects the call to be refused with this status and, when given, this code
  const refused = (
    promise: Promise<unknown>,
    status: number,
    code?: string
  ) =>
    expect(promise).rejects.toMatchObject({
      status,
      ...(code ? { response: { code } } : {}),
    });

  // The features a plan grants by the pricing file: those whose lowest plan ranks at or below it
  const grantedBy = (plan: string) =>
    FEATURE_KEYS.filter(
      (feature) => rankOf(PRICING.features[feature]) <= rankOf(plan)
    );

  beforeAll(() => {
    for (const name of ENV) {
      saved[name] = process.env[name];
    }
  });

  beforeEach(() => {
    Object.assign(process.env, {
      JWT_SECRET: 'entitlements-spec-secret',
      // the key on one line with literal \n, as a single-line env file holds it
      ENTITLEMENT_SIGNING_KEY: privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString()
        .trim()
        .replace(/\n/g, '\\n'),
      ENTITLEMENT_KEY_ID: 'k1',
      NODE_ENV: 'test',
    });
    repo = { ownPlan: jest.fn(), workspacePlan: jest.fn() };
    plans(null, null);
    sessions = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: SESSION, userId: USER, revokedAt: null }),
      touch: jest.fn(),
    };
    users = {
      getUserById: jest.fn().mockResolvedValue({ id: USER, activated: true }),
    };
    organizations = {
      getOrgsByUserId: jest
        .fn()
        .mockResolvedValue([workspace(ORG), workspace(OTHER_ORG)]),
    };
    controller = build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  describe('anonymous (no Authorization)', () => {
    it('answers FREE with a token that has no sid, sub or ws, and reads no account', async () => {
      const response = await call();

      const { header, payload } = decode(response.token);
      expect(response.plan).toBe('FREE');
      expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'k1' });
      expect(payload.v).toBe(1);
      expect(payload.plan).toBe('FREE');
      expect(payload.features).toEqual(grantedBy('FREE'));
      expect(payload.sid).toBeUndefined();
      expect(payload.sub).toBeUndefined();
      expect(payload.ws).toBeUndefined();
      expect(sessions.findById).not.toHaveBeenCalled();
      expect(repo.ownPlan).not.toHaveBeenCalled();
      expect(repo.workspacePlan).not.toHaveBeenCalled();
    });

    it('treats an empty Authorization as missing and does not look at x-workspace-id', async () => {
      const response = await call('   ', 'org-not-mine');

      expect(response.plan).toBe('FREE');
      expect(decode(response.token).payload.sub).toBeUndefined();
      expect(organizations.getOrgsByUserId).not.toHaveBeenCalled();
    });

    it('answers the catalogue: the plans, FREE first in rank order, and the lowest plan of each feature', async () => {
      const response = await call();

      expect(response.refreshAfter).toBe(6 * 60 * 60);
      expect(response.catalogue.plans).toEqual(pricing().plans());
      expect(response.catalogue.plans[0].key).toBe('FREE');
      expect(response.catalogue.plans.map((p) => p.key)).toEqual([
        'FREE',
        ...PRICING.tiers.map((tier) => tier.key),
      ]);
      expect(response.catalogue.features).toEqual(PRICING.features);
    });
  });

  describe('signed in', () => {
    it('carries the device session id as sid, the user as sub and the default workspace as ws', async () => {
      const response = await call(`Bearer ${accessToken()}`);

      const { payload } = decode(response.token);
      expect(payload.sid).toBe(SESSION);
      expect(payload.sub).toBe(USER);
      expect(payload.ws).toBe(ORG);
      expect(sessions.findById).toHaveBeenCalledWith(SESSION);
      expect(repo.ownPlan).toHaveBeenCalledWith(USER);
      expect(repo.workspacePlan).toHaveBeenCalledWith(ORG);
    });

    it('is for the workspace x-workspace-id names when the user belongs to it', async () => {
      const response = await call(`Bearer ${accessToken()}`, OTHER_ORG);

      expect(decode(response.token).payload.ws).toBe(OTHER_ORG);
      expect(repo.workspacePlan).toHaveBeenCalledWith(OTHER_ORG);
    });

    it('takes the better of the own plan and the workspace plan, in the response and the token', async () => {
      plans('FREE', 'AGENCY');

      const response = await call(`Bearer ${accessToken()}`);

      expect(response.plan).toBe('AGENCY');
      expect(decode(response.token).payload.plan).toBe('AGENCY');
    });

    it('skips a workspace the user is disabled in when it picks the default one', async () => {
      organizations.getOrgsByUserId.mockResolvedValue([
        workspace(ORG, true),
        workspace(OTHER_ORG),
      ]);

      const response = await call(`Bearer ${accessToken()}`);

      expect(decode(response.token).payload.ws).toBe(OTHER_ORG);
    });

    it('gives a user with no workspace a token without ws and the plan of their own account', async () => {
      organizations.getOrgsByUserId.mockResolvedValue([]);
      plans('STARTER', null);

      const response = await call(`Bearer ${accessToken()}`);

      const { payload } = decode(response.token);
      expect(response.plan).toBe('STARTER');
      expect(payload.ws).toBeUndefined();
      expect(payload.sid).toBe(SESSION);
      expect(payload.sub).toBe(USER);
    });

    it('grants in the token every feature whose lowest plan ranks at or below the plan, on every plan', async () => {
      for (const { key } of pricing().plans()) {
        plans(key, 'FREE');

        const response = await call(`Bearer ${accessToken()}`);

        const { payload } = decode(response.token);
        expect(payload.plan).toBe(key);
        expect(payload.features).toEqual(grantedBy(key));
        // the free ones are in every token
        for (const feature of grantedBy('FREE')) {
          expect(payload.features).toContain(feature);
        }
      }
    });

    it('gives FREE again once a lapsed or refunded account is back on FREE, with no paid feature', async () => {
      plans('PRO', 'FREE');
      expect((await call(`Bearer ${accessToken()}`)).plan).toBe('PRO');

      plans('FREE', 'FREE');
      const response = await call(`Bearer ${accessToken()}`);

      const { payload } = decode(response.token);
      expect(response.plan).toBe('FREE');
      expect(payload.plan).toBe('FREE');
      expect(payload.features).toEqual(grantedBy('FREE'));
      expect(payload.features).not.toContain('bg_replace');
    });

    it('signs with the key, so the public key verifies the token as raw r||s (ieee-p1363)', async () => {
      plans('PRO', 'FREE');

      const { token } = await call(`Bearer ${accessToken()}`);

      const { signature, signingInput } = decode(token);
      expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
      expect(
        verify(
          'sha256',
          Buffer.from(signingInput),
          { key: publicKey, dsaEncoding: 'ieee-p1363' },
          Buffer.from(signature, 'base64url')
        )
      ).toBe(true);
    });

    it('lasts 14 days from now', async () => {
      const before = now();

      const { payload } = decode((await call(`Bearer ${accessToken()}`)).token);

      expect(payload.iat).toBeGreaterThanOrEqual(before);
      expect(payload.exp - payload.iat).toBe(14 * 24 * 60 * 60);
    });
  });

  describe('a Bearer that is not good is a 401, never a FREE token', () => {
    it('answers 401 TOKEN_EXPIRED for an expired access token', async () => {
      await refused(
        call(`Bearer ${accessToken({ iat: now() - 2000, exp: now() - 1000 })}`),
        401,
        'TOKEN_EXPIRED'
      );
      expect(repo.ownPlan).not.toHaveBeenCalled();
    });

    it('answers 401 SESSION_REVOKED for a revoked device session', async () => {
      sessions.findById.mockResolvedValue({
        id: SESSION,
        userId: USER,
        revokedAt: new Date(),
      });

      await refused(
        call(`Bearer ${accessToken()}`),
        401,
        'SESSION_REVOKED'
      );
      expect(repo.ownPlan).not.toHaveBeenCalled();
    });

    it.each([
      ['garbage', () => 'Bearer not-a-token'],
      [
        'a token signed with another secret',
        () => `Bearer ${sign({ sub: USER, sid: SESSION }, 'another-secret')}`,
      ],
      [
        'a token with no session id (the one-year token of upstream)',
        () => `Bearer ${AuthService.signJWT({ sub: USER })}`,
      ],
      ['an API key', () => 'nsk_0123456789abcdef'],
      ['another scheme', () => `Basic ${accessToken()}`],
      ['a bare Bearer', () => 'Bearer'],
    ])('answers 401 INVALID_BEARER_TOKEN for %s', async (_name, header) => {
      await refused(call(header()), 401, 'INVALID_BEARER_TOKEN');
      expect(repo.ownPlan).not.toHaveBeenCalled();
    });

    it('answers 401 for a session that is unknown or another user\'s', async () => {
      sessions.findById.mockResolvedValue(null);
      await refused(
        call(`Bearer ${accessToken()}`),
        401,
        'INVALID_BEARER_TOKEN'
      );

      sessions.findById.mockResolvedValue({
        id: SESSION,
        userId: 'someone-else',
        revokedAt: null,
      });
      await refused(
        call(`Bearer ${accessToken()}`),
        401,
        'INVALID_BEARER_TOKEN'
      );
    });

    it('answers 401 for a user who is gone or not activated', async () => {
      users.getUserById.mockResolvedValue(null);
      await refused(
        call(`Bearer ${accessToken()}`),
        401,
        'INVALID_BEARER_TOKEN'
      );

      users.getUserById.mockResolvedValue({ id: USER, activated: false });
      await refused(
        call(`Bearer ${accessToken()}`),
        401,
        'INVALID_BEARER_TOKEN'
      );
    });

    it('answers 401 and signs nothing when a signed-in call has no device session id', async () => {
      const signing = jest.spyOn(EntitlementTokenSigner.prototype, 'sign');
      controller = build({
        verifyAccess: jest.fn().mockResolvedValue({ userId: USER }),
      });

      await refused(
        call(`Bearer ${accessToken()}`),
        401,
        'INVALID_BEARER_TOKEN'
      );
      expect(signing).not.toHaveBeenCalled();
    });
  });

  describe('x-workspace-id', () => {
    it('answers 403 WORKSPACE_FORBIDDEN for a workspace the user is not a member of, before any plan is read', async () => {
      await refused(
        call(`Bearer ${accessToken()}`, 'org-of-someone-else'),
        403,
        'WORKSPACE_FORBIDDEN'
      );
      expect(repo.ownPlan).not.toHaveBeenCalled();
      expect(repo.workspacePlan).not.toHaveBeenCalled();
    });

    it('answers 403 WORKSPACE_FORBIDDEN for a workspace the user is disabled in', async () => {
      organizations.getOrgsByUserId.mockResolvedValue([
        workspace(ORG),
        workspace(OTHER_ORG, true),
      ]);

      await refused(
        call(`Bearer ${accessToken()}`, OTHER_ORG),
        403,
        'WORKSPACE_FORBIDDEN'
      );
    });
  });

  describe('failures that are not the caller\'s', () => {
    it('passes a 500 from an unknown stored plan through, with no token', async () => {
      const signing = jest.spyOn(EntitlementTokenSigner.prototype, 'sign');
      plans('ENTERPRISE', 'FREE');

      await refused(call(`Bearer ${accessToken()}`), 500);
      expect(signing).not.toHaveBeenCalled();
    });

    it('passes a failing database through as it is', async () => {
      repo.ownPlan.mockRejectedValue(new Error('database is down'));

      await expect(call(`Bearer ${accessToken()}`)).rejects.toThrow(
        'database is down'
      );
    });

    it('answers 503 when no signing key is set (outside production)', async () => {
      delete process.env.ENTITLEMENT_SIGNING_KEY;
      delete process.env.ENTITLEMENT_KEY_ID;
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      controller = build();

      await refused(call(), 503);
      await refused(call(`Bearer ${accessToken()}`), 503);
    });
  });

  describe('route', () => {
    const handler = EntitlementsController.prototype.getEntitlements;

    it('is GET /entitlements, never cached, throttled by client address to 120 an hour', () => {
      expect(Reflect.getMetadata(PATH_METADATA, EntitlementsController)).toBe(
        '/entitlements'
      );
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.GET
      );
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([
        { name: 'Cache-Control', value: 'no-store' },
      ]);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
        ThrottlerRealIpGuard,
      ]);
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(120);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(
        60 * 60 * 1000
      );
    });

    it('is served without the authentication middleware', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../../../..', 'apps/backend/src/api/api.module.ts'),
        'utf8'
      );
      const authenticated = /const authenticatedController = \[([^\]]*)\]/.exec(
        source
      )![1];
      const served = source.slice(source.indexOf('controllers:'));

      expect(authenticated).not.toContain('EntitlementsController');
      expect(served).toContain('EntitlementsController,');
    });
  });
});
