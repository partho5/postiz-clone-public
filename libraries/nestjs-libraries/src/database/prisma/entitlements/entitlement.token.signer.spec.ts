// api.entitlements (E2): the signer makes a compact ES256 JWS the app can check with the public key, reads
// its key from the environment (a one-line PEM too) and refuses to run in production without one.
// Needs no database.
import { Logger } from '@nestjs/common';
import {
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  verify,
} from 'crypto';
import {
  ENTITLEMENT_TOKEN_TTL_SECONDS,
  EntitlementTokenSigner,
} from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlement.token.signer';

const ENV = ['ENTITLEMENT_SIGNING_KEY', 'ENTITLEMENT_KEY_ID', 'NODE_ENV'] as const;

// A P-256 key pair: the private key as the PKCS8 PEM that `openssl genpkey` writes, and the public key
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
  };
};

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

// Whether the signature is a valid ES256 one for the key, checked the way the app does: raw r||s
const verifies = (token: string, publicKey: KeyObject) => {
  const { signature, signingInput } = decode(token);
  return verify(
    'sha256',
    Buffer.from(signingInput),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url')
  );
};

// What `run` throws, or undefined when it does not
const thrown = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
};

const CLAIMS = {
  plan: 'PRO' as const,
  features: ['crop_9_16', 'bg_replace'] as any,
  sid: 'session-1',
  sub: 'user-1',
  ws: 'org-1',
};

describe('api.entitlements: EntitlementTokenSigner', () => {
  const saved: Record<string, string | undefined> = {};
  let keys: ReturnType<typeof pair>;

  const configure = (env: Partial<Record<(typeof ENV)[number], string>>) => {
    for (const name of ENV) {
      delete process.env[name];
    }
    Object.assign(process.env, env);
  };

  beforeAll(() => {
    for (const name of ENV) {
      saved[name] = process.env[name];
    }
    keys = pair();
  });

  beforeEach(() => {
    configure({ ENTITLEMENT_SIGNING_KEY: keys.pem, ENTITLEMENT_KEY_ID: 'k1' });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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

  describe('token', () => {
    it('is a compact JWS of three base64url parts without padding', () => {
      const token = new EntitlementTokenSigner().sign(CLAIMS);

      const parts = token.split('.');
      expect(parts).toHaveLength(3);
      for (const part of parts) {
        expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it('has the header ES256, JWT and the key id', () => {
      const { header } = decode(new EntitlementTokenSigner().sign(CLAIMS));

      expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'k1' });
    });

    it('carries the claims, version 1, and iat and exp in epoch seconds 14 days apart', () => {
      const issuedAt = new Date('2026-10-20T12:00:00.900Z');

      const { payload } = decode(
        new EntitlementTokenSigner().sign(CLAIMS, issuedAt)
      );

      expect(payload).toEqual({
        v: 1,
        ...CLAIMS,
        iat: 1792497600,
        exp: 1792497600 + 14 * 24 * 60 * 60,
      });
      expect(ENTITLEMENT_TOKEN_TTL_SECONDS).toBe(14 * 24 * 60 * 60);
    });

    it('stamps the current time when no time is given', () => {
      const before = Math.floor(Date.now() / 1000);

      const { payload } = decode(new EntitlementTokenSigner().sign(CLAIMS));

      expect(payload.iat).toBeGreaterThanOrEqual(before);
      expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
      expect(payload.exp - payload.iat).toBe(ENTITLEMENT_TOKEN_TTL_SECONDS);
    });

    it('has no sid, sub or ws for an anonymous token', () => {
      const { payload } = decode(
        new EntitlementTokenSigner().sign({
          plan: 'FREE',
          features: ['crop_9_16'] as any,
        })
      );

      expect(Object.keys(payload).sort()).toEqual(
        ['exp', 'features', 'iat', 'plan', 'v'].sort()
      );
    });
  });

  describe('signature', () => {
    it('verifies with the public key as raw r||s of 64 bytes (ieee-p1363)', () => {
      const token = new EntitlementTokenSigner().sign(CLAIMS);

      expect(Buffer.from(decode(token).signature, 'base64url')).toHaveLength(64);
      expect(verifies(token, keys.publicKey)).toBe(true);
    });

    it('verifies with the public key the way the app holds it: kid=base64 of the DER SPKI', () => {
      const token = new EntitlementTokenSigner().sign(CLAIMS);
      const listed = `k1=${keys.publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64')}`;

      // the base64 may end in '=', so only the first one separates the key id
      const kid = listed.slice(0, listed.indexOf('='));
      const fromList = createPublicKey({
        key: Buffer.from(listed.slice(listed.indexOf('=') + 1), 'base64'),
        format: 'der',
        type: 'spki',
      });

      expect(kid).toBe(decode(token).header.kid);
      expect(verifies(token, fromList)).toBe(true);
    });

    it('does not verify with another key, or after the payload is changed', () => {
      const token = new EntitlementTokenSigner().sign(CLAIMS);
      const [header, , signature] = token.split('.');
      const forged = decode(token).payload;
      forged.plan = 'AGENCY';
      const swapped = [
        header,
        Buffer.from(JSON.stringify(forged)).toString('base64url'),
        signature,
      ].join('.');

      expect(verifies(token, pair().publicKey)).toBe(false);
      expect(verifies(swapped, keys.publicKey)).toBe(false);
    });
  });

  describe('key from the environment', () => {
    it('accepts the PEM on one line with literal \\n sequences', () => {
      configure({
        ENTITLEMENT_SIGNING_KEY: keys.pem.trim().replace(/\n/g, '\\n'),
        ENTITLEMENT_KEY_ID: 'k1',
      });

      const token = new EntitlementTokenSigner().sign(CLAIMS);

      expect(verifies(token, keys.publicKey)).toBe(true);
    });

    it('uses the key id it is given', () => {
      configure({
        ENTITLEMENT_SIGNING_KEY: keys.pem,
        ENTITLEMENT_KEY_ID: 'k2',
      });

      expect(decode(new EntitlementTokenSigner().sign(CLAIMS)).header.kid).toBe(
        'k2'
      );
    });

    it('refuses a key that is not a P-256 private key, naming the variable and not the key', () => {
      const other = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();

      for (const bad of [other, rsa, 'not a key', keys.pem.slice(0, 80)]) {
        configure({ ENTITLEMENT_SIGNING_KEY: bad, ENTITLEMENT_KEY_ID: 'k1' });
        expect(() => new EntitlementTokenSigner()).toThrow(
          /ENTITLEMENT_SIGNING_KEY/
        );
      }
    });

    it('refuses a key that is unreadable even outside production', () => {
      configure({
        ENTITLEMENT_SIGNING_KEY: 'not a key',
        ENTITLEMENT_KEY_ID: 'k1',
        NODE_ENV: 'development',
      });

      expect(() => new EntitlementTokenSigner()).toThrow();
    });
  });

  describe('no key', () => {
    it('fails to start in production without the key, or without the key id', () => {
      configure({ NODE_ENV: 'production', ENTITLEMENT_KEY_ID: 'k1' });
      expect(() => new EntitlementTokenSigner()).toThrow(
        /ENTITLEMENT_SIGNING_KEY and ENTITLEMENT_KEY_ID are required in production/
      );

      configure({ NODE_ENV: 'production', ENTITLEMENT_SIGNING_KEY: keys.pem });
      expect(() => new EntitlementTokenSigner()).toThrow(/required in production/);

      configure({ NODE_ENV: 'production' });
      expect(() => new EntitlementTokenSigner()).toThrow(/required in production/);
    });

    it('starts in production with both set', () => {
      configure({
        NODE_ENV: 'production',
        ENTITLEMENT_SIGNING_KEY: keys.pem,
        ENTITLEMENT_KEY_ID: 'k1',
      });

      expect(() => new EntitlementTokenSigner()).not.toThrow();
    });

    it('starts outside production with a warning, and answers 503 when asked to sign', () => {
      for (const env of ['development', 'test', undefined]) {
        configure(env ? { NODE_ENV: env } : {});
        (Logger.prototype.warn as jest.Mock).mockClear();

        const signer = new EntitlementTokenSigner();

        expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
        expect(thrown(() => signer.sign(CLAIMS))).toMatchObject({
          status: 503,
        });
      }
    });
  });
});
