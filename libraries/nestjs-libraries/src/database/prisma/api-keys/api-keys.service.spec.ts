// api.scoped-keys: the key rules. Runs the real service and repository against a real
// Postgres on both database roles (the contract's access is "both"), the real organization service
// for the "no new legacy key" lines, and the real migration SQL for the keys that existed before.
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  PrismaRepository,
  PrismaService,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ApiKeysRepository } from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.repository';
import {
  API_SCOPES,
  ApiKeysService,
  ApiScope,
} from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { OrganizationRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';

// Modules that pull ESM-only packages ts-jest cannot load; nothing here calls them
jest.mock('file-type', () => ({}));

const url = process.env.TEST_DATABASE_URL;
const apiUrl = process.env.TEST_DATABASE_API_URL;
const describeDb = url && apiUrl ? describe : describe.skip;

// The hex SHA-256 of a value, as the service stores it.
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// The error a call rejects with, or undefined when it resolves.
const failure = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (err) {
    return err as HttpException;
  }
  return undefined;
};

describeDb('api.scoped-keys: ApiKeysService (Postgres)', () => {
  let worker: PrismaClient;
  let apiPrisma: PrismaService;
  const saved = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = apiUrl;
    apiPrisma = new PrismaService();
    await apiPrisma.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
  });

  afterAll(async () => {
    if (saved === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = saved;
    }
    await apiPrisma.$disconnect();
    await worker.$disconnect();
  });

  // A workspace with one SUPERADMIN member, made through the worker client.
  const newWorkspace = async () => {
    const user = await worker.user.create({
      data: {
        email: randomUUID() + '@test.local',
        providerName: 'LOCAL',
        password: 'x',
        activated: true,
        timezone: 0,
      },
    });
    const org = await worker.organization.create({
      data: {
        name: 'ws-' + randomUUID(),
        users: { create: { role: 'SUPERADMIN', userId: user.id } },
      },
    });
    return { userId: user.id, orgId: org.id };
  };

  describe.each([
    ['API role', () => apiPrisma],
    ['worker role', () => worker],
  ])('on the %s', (_role, client) => {
    // The service wired to the role's client.
    const service = () =>
      new ApiKeysService(
        new ApiKeysRepository(new PrismaRepository<any>(client() as any))
      );

    describe('create', () => {
      it('returns the key once as nsk_<prefix>_<secret> with the view of the stored row', async () => {
        const { userId, orgId } = await newWorkspace();

        const created = await service().create(orgId, userId, {
          name: 'Zapier',
          scopes: ['posts:read', 'posts:write'],
        });

        expect(created.key).toMatch(/^nsk_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/);
        expect(created).toMatchObject({
          name: 'Zapier',
          scopes: ['posts:read', 'posts:write'],
          lastUsedAt: null,
          revokedAt: null,
        });
        expect(created.prefix).toBe(created.key.split('_')[1]);
        expect(new Date(created.createdAt).getTime()).not.toBeNaN();
        const row = await worker.apiKey.findUniqueOrThrow({
          where: { id: created.id },
        });
        expect(row).toMatchObject({
          organizationId: orgId,
          createdBy: userId,
          prefix: created.prefix,
        });
      });

      it('stores only the SHA-256 of the secret: no column holds the secret or the key', async () => {
        const { userId, orgId } = await newWorkspace();

        const created = await service().create(orgId, userId, {
          name: 'hash',
          scopes: ['account:read'],
        });

        const secret = created.key.split('_')[2];
        const row = await worker.apiKey.findUniqueOrThrow({
          where: { id: created.id },
        });
        expect(row.secretHash).toBe(sha256(secret));
        const stored = JSON.stringify(row);
        expect(stored).not.toContain(secret);
        expect(stored).not.toContain(created.key);
      });

      it('never returns a secret from list, and returns every key of the workspace, revoked ones too, newest first', async () => {
        const { userId, orgId } = await newWorkspace();
        const first = await service().create(orgId, userId, {
          name: 'one',
          scopes: ['posts:read'],
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await service().create(orgId, userId, {
          name: 'two',
          scopes: ['posts:read'],
        });
        await service().revoke(orgId, first.id);

        const listed = await service().list(orgId);

        expect(listed.map((k) => k.id)).toEqual([second.id, first.id]);
        expect(listed[1].revokedAt).not.toBeNull();
        expect(Object.keys(listed[0]).sort()).toEqual(
          [
            'createdAt',
            'id',
            'lastUsedAt',
            'name',
            'prefix',
            'revokedAt',
            'scopes',
          ].sort()
        );
        expect(JSON.stringify(listed)).not.toContain(first.key.split('_')[2]);
        expect(JSON.stringify(listed)).not.toContain(second.key.split('_')[2]);
      });

      it('lists only the workspace asked for', async () => {
        const a = await newWorkspace();
        const b = await newWorkspace();
        await service().create(a.orgId, a.userId, {
          name: 'a',
          scopes: ['posts:read'],
        });

        expect(await service().list(b.orgId)).toEqual([]);
      });

      it('rejects a name outside 1 to 60 characters with 400 and stores nothing', async () => {
        const { userId, orgId } = await newWorkspace();

        for (const name of ['', '   ', 'x'.repeat(61)]) {
          const err = await failure(
            service().create(orgId, userId, { name, scopes: ['posts:read'] })
          );
          expect(err?.getStatus()).toBe(400);
          expect(err?.getResponse()).toMatchObject({ code: 'API_KEY_INVALID' });
        }
        const ok = await service().create(orgId, userId, {
          name: 'x'.repeat(60),
          scopes: ['posts:read'],
        });
        expect(ok.name).toHaveLength(60);
        expect(await worker.apiKey.count({ where: { organizationId: orgId } })).toBe(1);
      });

      it('rejects no scope and an unknown scope with 400', async () => {
        const { userId, orgId } = await newWorkspace();

        const none = await failure(
          service().create(orgId, userId, { name: 'k', scopes: [] })
        );
        const unknown = await failure(
          service().create(orgId, userId, {
            name: 'k',
            scopes: ['posts:read', 'admin:all' as ApiScope],
          })
        );

        expect(none?.getStatus()).toBe(400);
        expect(unknown?.getStatus()).toBe(400);
        expect(await worker.apiKey.count({ where: { organizationId: orgId } })).toBe(0);
      });

      it('keeps each scope once however many times it was sent', async () => {
        const { userId, orgId } = await newWorkspace();

        const created = await service().create(orgId, userId, {
          name: 'dup',
          scopes: ['posts:read', 'posts:read', 'ai:use'],
        });

        expect(created.scopes).toEqual(['posts:read', 'ai:use']);
      });

      it('gives two keys two different prefixes and secrets', async () => {
        const { userId, orgId } = await newWorkspace();

        const a = await service().create(orgId, userId, { name: 'a', scopes: ['posts:read'] });
        const b = await service().create(orgId, userId, { name: 'b', scopes: ['posts:read'] });

        expect(a.prefix).not.toBe(b.prefix);
        expect(a.key).not.toBe(b.key);
      });
    });

    describe('authenticate', () => {
      it('answers the workspace, the key id and the scopes of a live key', async () => {
        const { userId, orgId } = await newWorkspace();
        const created = await service().create(orgId, userId, {
          name: 'k',
          scopes: ['channels:read', 'media:write'],
        });

        const found = await service().authenticate(created.key);

        expect(found).toEqual({
          organizationId: orgId,
          keyId: created.id,
          scopes: ['media:write', 'channels:read'],
        });
      });

      it('answers null for a key that was never issued, a wrong secret under a real prefix, and malformed values', async () => {
        const { userId, orgId } = await newWorkspace();
        const created = await service().create(orgId, userId, {
          name: 'k',
          scopes: ['posts:read'],
        });
        const [, prefix] = created.key.split('_');

        const unknownPrefix = `nsk_${'a'.repeat(8)}_${'b'.repeat(32)}`;
        const wrongSecret = `nsk_${prefix}_${'b'.repeat(32)}`;
        for (const value of [
          unknownPrefix,
          wrongSecret,
          'nsk_short_secret',
          `nsk_${prefix}_`,
          'plain-text',
          '',
          'x'.repeat(600),
          created.key + 'x',
          created.key.toUpperCase(),
        ]) {
          expect(await service().authenticate(value)).toBeNull();
        }
      });

      it('answers null once the key is revoked', async () => {
        const { userId, orgId } = await newWorkspace();
        const created = await service().create(orgId, userId, {
          name: 'k',
          scopes: ['posts:read'],
        });
        expect(await service().authenticate(created.key)).not.toBeNull();

        await service().revoke(orgId, created.id);

        expect(await service().authenticate(created.key)).toBeNull();
      });

      it('answers null when the workspace was deleted, and works again if it is restored', async () => {
        const { userId, orgId } = await newWorkspace();
        const created = await service().create(orgId, userId, {
          name: 'k',
          scopes: ['posts:read'],
        });

        await worker.organization.update({
          where: { id: orgId },
          data: { deletedAt: new Date() },
        });
        const deleted = await service().authenticate(created.key);
        await worker.organization.update({
          where: { id: orgId },
          data: { deletedAt: null },
        });

        expect(deleted).toBeNull();
        expect(await service().authenticate(created.key)).not.toBeNull();
      });

      it('records the last use, and not more than once a minute', async () => {
        const { userId, orgId } = await newWorkspace();
        const created = await service().create(orgId, userId, {
          name: 'k',
          scopes: ['posts:read'],
        });
        expect(created.lastUsedAt).toBeNull();

        await service().authenticate(created.key);
        const first = (
          await worker.apiKey.findUniqueOrThrow({ where: { id: created.id } })
        ).lastUsedAt;
        await new Promise((resolve) => setTimeout(resolve, 20));
        await service().authenticate(created.key);
        const second = (
          await worker.apiKey.findUniqueOrThrow({ where: { id: created.id } })
        ).lastUsedAt;

        expect(first).not.toBeNull();
        expect(second?.getTime()).toBe(first?.getTime());

        await worker.apiKey.update({
          where: { id: created.id },
          data: { lastUsedAt: new Date(Date.now() - 5 * 60 * 1000) },
        });
        await service().authenticate(created.key);
        const third = (
          await worker.apiKey.findUniqueOrThrow({ where: { id: created.id } })
        ).lastUsedAt;
        expect(third!.getTime()).toBeGreaterThan(Date.now() - 60 * 1000);
      });

      it('never records a use for a refused key', async () => {
        const { userId, orgId } = await newWorkspace();
        const created = await service().create(orgId, userId, {
          name: 'k',
          scopes: ['posts:read'],
        });
        await service().revoke(orgId, created.id);

        await service().authenticate(created.key);

        const row = await worker.apiKey.findUniqueOrThrow({ where: { id: created.id } });
        expect(row.lastUsedAt).toBeNull();
      });

      it('a key of workspace X names X and never Y', async () => {
        const x = await newWorkspace();
        const y = await newWorkspace();
        const keyX = await service().create(x.orgId, x.userId, {
          name: 'x',
          scopes: [...API_SCOPES],
        });
        await service().create(y.orgId, y.userId, {
          name: 'y',
          scopes: [...API_SCOPES],
        });

        const found = await service().authenticate(keyX.key);

        expect(found?.organizationId).toBe(x.orgId);
      });
    });

    describe('revoke', () => {
      it('sets revokedAt on the workspace key and answers nothing', async () => {
        const { userId, orgId } = await newWorkspace();
        const created = await service().create(orgId, userId, {
          name: 'k',
          scopes: ['posts:read'],
        });

        await expect(service().revoke(orgId, created.id)).resolves.toBeUndefined();

        const row = await worker.apiKey.findUniqueOrThrow({ where: { id: created.id } });
        expect(row.revokedAt).not.toBeNull();
      });

      it('revoking again changes nothing and is not an error', async () => {
        const { userId, orgId } = await newWorkspace();
        const created = await service().create(orgId, userId, {
          name: 'k',
          scopes: ['posts:read'],
        });
        await service().revoke(orgId, created.id);
        const first = (
          await worker.apiKey.findUniqueOrThrow({ where: { id: created.id } })
        ).revokedAt;
        await new Promise((resolve) => setTimeout(resolve, 10));

        await expect(service().revoke(orgId, created.id)).resolves.toBeUndefined();

        const second = (
          await worker.apiKey.findUniqueOrThrow({ where: { id: created.id } })
        ).revokedAt;
        expect(second?.getTime()).toBe(first?.getTime());
      });

      it("answers 404 for another workspace's key and leaves it working", async () => {
        const x = await newWorkspace();
        const y = await newWorkspace();
        const keyY = await service().create(y.orgId, y.userId, {
          name: 'y',
          scopes: ['posts:read'],
        });

        const err = await failure(service().revoke(x.orgId, keyY.id));

        expect(err?.getStatus()).toBe(404);
        expect(JSON.stringify(err?.getResponse())).not.toContain(y.orgId);
        expect(await service().authenticate(keyY.key)).not.toBeNull();
      });

      it('answers 404 for an unknown id', async () => {
        const { orgId } = await newWorkspace();

        const err = await failure(service().revoke(orgId, randomUUID()));

        expect(err?.getStatus()).toBe(404);
      });
    });
  });

  describe('keys that existed before (migration)', () => {
    // The statements of the migration's data part, which moves each workspace key into an `ApiKey`.
    const dataStatements = () => {
      const sql = fs.readFileSync(
        path.resolve(
          __dirname,
          '../migrations/20261009120000_api_key/migration.sql'
        ),
        'utf8'
      );
      const part = sql.slice(sql.indexOf('-- LegacyKeys'));
      return part
        .split('\n')
        .filter((line) => !line.startsWith('--'))
        .join('\n')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
    };

    // Runs the migration's data part against the database as `migrate deploy` does, in one transaction.
    const migrate = () =>
      worker.$transaction(
        dataStatements().map((statement) => worker.$executeRawUnsafe(statement))
      );

    // The service on the API role, as the backend authenticates.
    const service = () =>
      new ApiKeysService(
        new ApiKeysRepository(new PrismaRepository<any>(apiPrisma as any))
      );

    it('turns each workspace key into a full-scope key named "Legacy key" that the same value still opens', async () => {
      const { orgId } = await newWorkspace();
      const held = 'encrypted-legacy-value-' + randomUUID();
      await worker.organization.update({
        where: { id: orgId },
        data: { apiKey: held },
      });

      await migrate();

      const found = await service().authenticate(held);
      expect(found).toMatchObject({ organizationId: orgId });
      expect(found?.scopes).toEqual([...API_SCOPES]);
      const [view] = await service().list(orgId);
      expect(view).toMatchObject({ name: 'Legacy key', revokedAt: null });
      expect(view.scopes).toEqual([...API_SCOPES]);
    });

    it('leaves no recoverable secret: the column is empty and the row holds only the hash of the whole value', async () => {
      const { orgId } = await newWorkspace();
      const held = 'another-legacy-value-' + randomUUID();
      await worker.organization.update({
        where: { id: orgId },
        data: { apiKey: held },
      });

      await migrate();

      const org = await worker.organization.findUniqueOrThrow({ where: { id: orgId } });
      expect(org.apiKey).toBeNull();
      const rows = await worker.apiKey.findMany({ where: { organizationId: orgId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].secretHash).toBe(sha256(held));
      expect(JSON.stringify(rows[0])).not.toContain(held);
      expect(rows[0].createdBy).toBeNull();
    });

    it('skips a workspace that has no key, and a second run adds nothing', async () => {
      const { orgId } = await newWorkspace();
      const held = 'third-legacy-value-' + randomUUID();
      await worker.organization.update({
        where: { id: orgId },
        data: { apiKey: held },
      });
      const without = await newWorkspace();

      await migrate();
      await migrate();

      expect(await worker.apiKey.count({ where: { organizationId: orgId } })).toBe(1);
      expect(await worker.apiKey.count({ where: { organizationId: without.orgId } })).toBe(0);
    });

    it('a migrated key can be revoked like any other and then stops working', async () => {
      const { orgId } = await newWorkspace();
      const held = 'revocable-legacy-value-' + randomUUID();
      await worker.organization.update({
        where: { id: orgId },
        data: { apiKey: held },
      });
      await migrate();
      const [view] = await service().list(orgId);

      await service().revoke(orgId, view.id);

      expect(await service().authenticate(held)).toBeNull();
    });

    it('a value left in the legacy column and never migrated authenticates nothing', async () => {
      const { orgId } = await newWorkspace();
      const held = 'unmigrated-legacy-value-' + randomUUID();
      await worker.organization.update({
        where: { id: orgId },
        data: { apiKey: held },
      });

      expect(await service().authenticate(held)).toBeNull();
    });
  });

  describe('workspaces made from now on', () => {
    // The real organization service on the worker client.
    const organizations = () => {
      const repo = new PrismaRepository<any>(worker as any);
      return {
        service: new OrganizationService(
          new OrganizationRepository(repo, repo, repo),
          {
            // The email provider stand-in: none is configured.
            hasEmailProvider: () => false,
          } as any,
          new AccountsService(new AccountsRepository(repo, repo, repo))
        ),
        repository: new OrganizationRepository(repo, repo, repo),
      };
    };

    it('createMaxUser answers { id } and writes no legacy key', async () => {
      const created = await organizations().service.createMaxUser(
        randomUUID(),
        'Partner',
        'saas' + randomUUID().slice(0, 8),
        randomUUID() + '@test.local'
      );

      expect(Object.keys(created)).toEqual(['id']);
      const org = await worker.organization.findUniqueOrThrow({ where: { id: created.id } });
      expect(org.apiKey).toBeNull();
    });

    it('createOrgAndUser writes no legacy key', async () => {
      const created = await organizations().repository.createOrgAndUser(
        {
          company: 'Co ' + randomUUID(),
          email: randomUUID() + '@test.local',
          password: 'a-long-enough-password',
          provider: 'LOCAL',
        } as any,
        '127.0.0.1',
        'jest'
      );

      const org = await worker.organization.findUniqueOrThrow({ where: { id: created.id } });
      expect(org.apiKey).toBeNull();
    });

    it('the organization service no longer offers a lookup or rotation by legacy key', () => {
      const { service, repository } = organizations();

      expect((service as any).getOrgByApiKey).toBeUndefined();
      expect((service as any).updateApiKey).toBeUndefined();
      expect((repository as any).getOrgByApiKey).toBeUndefined();
      expect((repository as any).updateApiKey).toBeUndefined();
    });
  });
});
