// Scoped API keys: creating, listing, revoking and authenticating the keys that work in one
// workspace and for their scopes only, stored as hashes.
import { HttpException, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { ApiKeysRepository } from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.repository';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import {
  API_SCOPES,
  ApiScope,
} from '@gitroom/nestjs-libraries/dtos/api-keys/api.scopes';

export { API_SCOPES };
export type { ApiScope };

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AuthenticatedApiKey {
  organizationId: string;
  keyId: string;
  scopes: ApiScope[];
}

// The most a key is read from: a longer value cannot be one of ours.
const MAX_KEY_LENGTH = 512;
// A key's last use is written at most this often.
const LAST_USED_GRANULARITY_MS = 60 * 1000;
// How often a taken random prefix is drawn again before giving up.
const PREFIX_ATTEMPTS = 5;

const PREFIX_LENGTH = 8;
const SECRET_LENGTH = 32;
const KEY_FORMAT = /^nsk_([A-Za-z0-9]{8})_([A-Za-z0-9]{32})$/;

// The hex SHA-256 of a value.
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// Whether two hex digests are equal, compared in constant time.
const sameHash = (a: string, b: string) => {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
};

// Client-actionable refusal of a key to create: { statusCode, code, message }.
class ApiKeyInvalidException extends HttpException {
  // Answers 400 API_KEY_INVALID with the reason.
  constructor(message: string) {
    super({ statusCode: 400, code: 'API_KEY_INVALID', message }, 400);
  }
}

// The workspace has no key with this id.
class ApiKeyNotFoundException extends HttpException {
  // Answers 404 API_KEY_NOT_FOUND.
  constructor() {
    super({ statusCode: 404, code: 'API_KEY_NOT_FOUND' }, 404);
  }
}

// The keys of a workspace: the rules for making, listing, revoking and recognising them.
@Injectable()
export class ApiKeysService {
  // Receives the repository that stores the keys.
  constructor(private _apiKeysRepository: ApiKeysRepository) {}

  // Makes a key for the workspace and returns it once, with its view; only its hash is kept.
  async create(
    organizationId: string,
    userId: string,
    input: { name: string; scopes: ApiScope[] }
  ): Promise<ApiKeyView & { key: string }> {
    const name = (input.name ?? '').trim();
    const requested: string[] = Array.isArray(input.scopes) ? input.scopes : [];
    const scopes = API_SCOPES.filter((scope) => requested.includes(scope));
    if (name.length < 1 || name.length > 60) {
      throw new ApiKeyInvalidException('name must be 1 to 60 characters');
    }
    if (
      !scopes.length ||
      requested.some((scope) => !(API_SCOPES as readonly string[]).includes(scope))
    ) {
      throw new ApiKeyInvalidException(
        `scopes must be one or more of ${API_SCOPES.join(', ')}`
      );
    }

    const secret = makeSecureId(SECRET_LENGTH);
    for (let attempt = 0; attempt < PREFIX_ATTEMPTS; attempt += 1) {
      const prefix = makeSecureId(PREFIX_LENGTH);
      const row = await this._apiKeysRepository.create({
        organizationId,
        name,
        prefix,
        secretHash: sha256(secret),
        scopes,
        createdBy: userId,
      });
      if (row) {
        return { ...this.view(row), key: `nsk_${prefix}_${secret}` };
      }
    }
    throw new Error('Could not draw an unused API key prefix');
  }

  // The workspace's keys, revoked ones included, newest first; never a secret.
  async list(organizationId: string): Promise<ApiKeyView[]> {
    const rows = await this._apiKeysRepository.list(organizationId);
    return rows.map((row) => this.view(row));
  }

  // Revokes the workspace's key; revoking an already revoked key changes nothing; another workspace's key is 404.
  async revoke(organizationId: string, id: string): Promise<void> {
    const revoked = await this._apiKeysRepository.revoke(
      organizationId,
      id,
      new Date()
    );
    if (!revoked && !(await this._apiKeysRepository.exists(organizationId, id))) {
      throw new ApiKeyNotFoundException();
    }
  }

  // The workspace and scopes of a live key, or null for an unknown, malformed or revoked one or a deleted workspace.
  async authenticate(key: string): Promise<AuthenticatedApiKey | null> {
    if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) {
      return null;
    }
    const found = await this.find(key);
    if (!found || found.revokedAt || found.organization.deletedAt) {
      return null;
    }
    const now = new Date();
    await this._apiKeysRepository.touch(
      found.id,
      now,
      new Date(now.getTime() - LAST_USED_GRANULARITY_MS)
    );
    return {
      organizationId: found.organizationId,
      keyId: found.id,
      scopes: this.scopesOf(found.scopes),
    };
  }

  // The row a presented value names: by prefix for an `nsk_` key, by the hash of the whole value for a migrated one.
  private async find(key: string) {
    const parsed = KEY_FORMAT.exec(key);
    if (parsed) {
      const row = await this._apiKeysRepository.findByPrefix(parsed[1]);
      return row && sameHash(row.secretHash, sha256(parsed[2])) ? row : null;
    }
    const hash = sha256(key);
    const rows = await this._apiKeysRepository.findBySecretHash(hash);
    return rows.find((row) => sameHash(row.secretHash, hash)) ?? null;
  }

  // The stored scopes that are still scopes of this version.
  private scopesOf(stored: string[]): ApiScope[] {
    return API_SCOPES.filter((scope) => stored.includes(scope));
  }

  // The public view of a row.
  private view(row: {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
  }): ApiKeyView {
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: this.scopesOf(row.scopes),
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
    };
  }
}
