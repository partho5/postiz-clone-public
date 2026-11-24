// Paid features (api.entitlements): signs the offline token the app checks with its copy of the public key.
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { createPrivateKey, KeyObject, sign } from 'crypto';
import {
  FeatureKey,
  PlanKey,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';

// How long a token is valid: the time a phone may stay offline and keep its plan (14 days).
export const ENTITLEMENT_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;

// What a token says. A signed-in token also names the device session, the user and the workspace; an
// anonymous one has none of the three.
export interface EntitlementClaims {
  plan: PlanKey;
  features: FeatureKey[];
  sid?: string;
  sub?: string;
  ws?: string;
}

// One part of a compact JWS: the JSON of `value` in base64url, without padding.
const part = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

// The signing key out of the environment value: a PEM that may hold its line breaks as literal `\n`
// (a one-line env file). It must be an elliptic-curve P-256 key, the one ES256 asks for.
const privateKeyOf = (value: string): KeyObject => {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: value.replace(/\\n/g, '\n'), format: 'pem' });
  } catch {
    throw new Error(
      'ENTITLEMENT_SIGNING_KEY is not a PEM private key (make one with: openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256)'
    );
  }
  if (
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new Error('ENTITLEMENT_SIGNING_KEY must be an EC P-256 private key');
  }
  return key;
};

// Signs entitlement tokens with ES256 (ECDSA, P-256, SHA-256).
@Injectable()
export class EntitlementTokenSigner {
  private readonly _logger = new Logger(EntitlementTokenSigner.name);
  private readonly _key?: KeyObject;
  private readonly _keyId?: string;

  // Reads ENTITLEMENT_SIGNING_KEY and ENTITLEMENT_KEY_ID. Without them, production refuses to start (paying
  // users must not silently drop to Free) and any other environment starts but cannot sign. A key that is
  // set but unreadable is an error everywhere.
  constructor() {
    const pem = process.env.ENTITLEMENT_SIGNING_KEY?.trim();
    const keyId = process.env.ENTITLEMENT_KEY_ID?.trim();
    if (pem && keyId) {
      this._key = privateKeyOf(pem);
      this._keyId = keyId;
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ENTITLEMENT_SIGNING_KEY and ENTITLEMENT_KEY_ID are required in production'
      );
    } else {
      this._logger.warn(
        'ENTITLEMENT_SIGNING_KEY or ENTITLEMENT_KEY_ID is not set: GET /entitlements answers 503'
      );
    }
  }

  // The compact JWS for the claims, valid for 14 days from `issuedAt`; 503 when no key is set.
  sign(claims: EntitlementClaims, issuedAt = new Date()): string {
    if (!this._key) {
      throw new HttpException(
        { statusCode: 503, code: 'ENTITLEMENT_SIGNING_NOT_CONFIGURED' },
        503
      );
    }
    const iat = Math.floor(issuedAt.getTime() / 1000);
    const signingInput = [
      part({ alg: 'ES256', typ: 'JWT', kid: this._keyId }),
      part({
        v: 1,
        ...claims,
        iat,
        exp: iat + ENTITLEMENT_TOKEN_TTL_SECONDS,
      }),
    ].join('.');
    // ieee-p1363 is the raw r||s of 64 bytes that JWS asks for, not the DER form Node signs with by default
    const signature = sign('sha256', Buffer.from(signingInput), {
      key: this._key,
      dsaEncoding: 'ieee-p1363',
    });
    return `${signingInput}.${signature.toString('base64url')}`;
  }
}
