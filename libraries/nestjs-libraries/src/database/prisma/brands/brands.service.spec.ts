// Brand profile: creating a brand, reading and changing it, and listing a user's
// brands. Runs the real service, repository, credit engine and account attach against a real
// Postgres (migrated and given the API role by the jest global setup), on both database roles.
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
  selectWorkerDatabase,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { BrandsRepository } from '@gitroom/nestjs-libraries/database/prisma/brands/brands.repository';
import { BrandsService } from '@gitroom/nestjs-libraries/database/prisma/brands/brands.service';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { CreditsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { PricingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import {
  BRAND_DEFAULT_COLOR,
  BrandProfile,
} from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

// The error a call rejects with, or undefined when it resolves.
const failure = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (err) {
    return err as HttpException;
  }
  return undefined;
};

describeDb('BrandsService (Postgres)', () => {
  let api: PrismaService;
  let workerService: PrismaService;
  let worker: PrismaClient;
  let setupAccounts: AccountsService;
  const savedWorkerUrl = process.env.DATABASE_WORKER_URL;

  // The brand, credit and account services on a given client, wired as the database module wires them.
  const wire = (prisma: PrismaService) => {
    const repo = new PrismaRepository<any>(prisma);
    const accounts = new AccountsService(
      new AccountsRepository(repo, repo, repo)
    );
    const scope = new MoneyScope(new PrismaTransaction(prisma), accounts);
    const credits = new CreditsService(
      new CreditsRepository(scope, repo, repo, repo),
      accounts,
      scope
    );
    const brands = new BrandsService(
      new BrandsRepository(repo, repo),
      credits,
      accounts
    );
    return { brands, credits, accounts };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    api = new PrismaService();
    await api.$connect();
    process.env.DATABASE_WORKER_URL = url;
    selectWorkerDatabase();
    workerService = new PrismaService();
    expect(api.role).toBe('api');
    expect(workerService.role).toBe('worker');
    await workerService.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    const repo = new PrismaRepository<any>(api);
    setupAccounts = new AccountsService(new AccountsRepository(repo, repo, repo));
    const pricing = new PricingService(
      new PricingRepository(new PrismaTransaction(api), repo, repo),
      wire(api).credits,
      setupAccounts
    );
    await pricing.sync();
  });

  afterAll(async () => {
    await api.$disconnect();
    await workerService.$disconnect();
    await worker.$disconnect();
    if (savedWorkerUrl === undefined) {
      delete process.env.DATABASE_WORKER_URL;
    } else {
      process.env.DATABASE_WORKER_URL = savedWorkerUrl;
    }
  });

  // A user who is SUPERADMIN of one workspace, attached to their account, holding credits.
  const owner = async (credits = 0) => {
    const user = await worker.user.create({
      data: {
        email: randomUUID() + '@test.local',
        providerName: 'LOCAL',
        timezone: 0,
      },
    });
    const org = await worker.organization.create({
      data: {
        name: 'ws-' + randomUUID(),
        users: { create: { role: 'SUPERADMIN', userId: user.id } },
      },
    });
    const accountId = await setupAccounts.getAccountIdForOrganization(org.id);
    if (credits > 0) {
      await wire(workerService).credits.grant(accountId, {
        type: 'GRANT',
        amount: credits,
      });
    }
    return { userId: user.id, orgId: org.id, accountId };
  };

  // Runs a block with `brand.create` priced at `cost`, then puts the price back.
  const withPrice = async (cost: number, run: () => Promise<void>) => {
    const before = await worker.creditAction.findUniqueOrThrow({
      where: { key: 'brand.create' },
    });
    await worker.creditAction.update({
      where: { key: 'brand.create' },
      data: { cost },
    });
    try {
      await run();
    } finally {
      await worker.creditAction.update({
        where: { key: 'brand.create' },
        data: { cost: before.cost },
      });
    }
  };

  // A new user as a member of a workspace with the given role; returns the user's id.
  const joinWorkspace = async (organizationId: string, role: 'USER' | 'ADMIN' | 'SUPERADMIN') => {
    const user = await worker.user.create({
      data: {
        email: randomUUID() + '@test.local',
        providerName: 'LOCAL',
        timezone: 0,
      },
    });
    await worker.userOrganization.create({
      data: { organizationId, userId: user.id, role },
    });
    return user.id;
  };

  // The workspaces a user is a member of, by name.
  const orgsNamed = (name: string) =>
    worker.organization.findMany({ where: { name } });

  describe.each([
    ['API role', () => api],
    ['worker role', () => workerService],
  ])('on the %s', (_role, client) => {
    // The services wired to the role's client.
    const service = () => wire(client());

    describe('create', () => {
      it('makes a workspace with the user as SUPERADMIN, attached to their account, with the defaults', async () => {
        const { userId, accountId } = await owner();

        const brand = await service().brands.create(userId, {
          name: 'Acme Studio',
          timezone: 'Europe/Berlin',
        });

        expect(brand).toMatchObject({
          name: 'Acme Studio',
          slug: 'acme-studio',
          color: BRAND_DEFAULT_COLOR,
          avatarUrl: null,
          timezone: 'Europe/Berlin',
          locale: 'en',
          profile: { schemaVersion: 1 },
        });
        const row = await worker.organization.findUniqueOrThrow({
          where: { id: brand.id },
          include: { users: true },
        });
        expect(row.accountId).toBe(accountId);
        expect(row.users).toHaveLength(1);
        expect(row.users[0]).toMatchObject({ userId, role: 'SUPERADMIN' });
      });

      it('stores the colour, avatar and locale it was given', async () => {
        const { userId } = await owner();

        const brand = await service().brands.create(userId, {
          name: 'Blue Co',
          color: '#0A84FF',
          avatarUrl: 'https://cdn.test/a.png',
          timezone: 'UTC',
          locale: 'pt-BR',
        });

        expect(brand).toMatchObject({
          color: '#0a84ff',
          avatarUrl: 'https://cdn.test/a.png',
          locale: 'pt-BR',
        });
      });

      it('gives a second brand with the same name the next free slug in the account', async () => {
        const { userId } = await owner();

        const first = await service().brands.create(userId, {
          name: 'Same Name',
          timezone: 'UTC',
        });
        const second = await service().brands.create(userId, {
          name: 'Same Name',
          timezone: 'UTC',
        });

        expect(first.slug).toBe('same-name');
        expect(second.slug).toBe('same-name-2');
      });

      it('charges brand.create once under the brand key and takes the credits from the account', async () => {
        const { userId, orgId } = await owner(10);

        await withPrice(3, async () => {
          const brand = await service().brands.create(userId, {
            name: 'Paid Brand',
            timezone: 'UTC',
          });

          const ledger = await worker.creditLedger.findUniqueOrThrow({
            where: { idempotencyKey: `brand:${brand.id}:create` },
          });
          expect(ledger).toMatchObject({
            actionKey: 'brand.create',
            status: 'COMMITTED',
            committed: 3,
            organizationId: orgId,
          });
          expect(await service().credits.balance(orgId)).toEqual({
            available: 7,
            reserved: 0,
          });
        });
      });

      it('answers 402 INSUFFICIENT_CREDITS and creates nothing when the balance is short', async () => {
        const { userId, orgId } = await owner(2);

        await withPrice(3, async () => {
          const err = await failure(
            service().brands.create(userId, {
              name: 'Too Dear ' + userId,
              timezone: 'UTC',
            })
          );

          expect(err!.getStatus()).toBe(402);
          expect(err!.getResponse()).toMatchObject({
            code: 'INSUFFICIENT_CREDITS',
            required: 3,
            available: 2,
          });
          expect(await orgsNamed('Too Dear ' + userId)).toHaveLength(0);
          expect(await service().credits.balance(orgId)).toEqual({
            available: 2,
            reserved: 0,
          });
        });
      });

      it('answers 400 INVALID_BRAND with each failing path and stores nothing', async () => {
        const { userId } = await owner();
        const name = 'Invalid ' + userId;

        const err = await failure(
          service().brands.create(userId, {
            name,
            color: 'red',
            timezone: 'Mars/Olympus',
            locale: 'not a locale',
          } as any)
        );

        expect(err!.getStatus()).toBe(400);
        const body = err!.getResponse() as any;
        expect(body.code).toBe('INVALID_BRAND');
        expect(body.fields.map((f: any) => f.path).sort()).toEqual([
          'color',
          'locale',
          'timezone',
        ]);
        expect(await orgsNamed(name)).toHaveLength(0);
      });

      it('refuses an avatar that is not an http or https URL and a field it does not know', async () => {
        const { userId } = await owner();

        const avatar = await failure(
          service().brands.create(userId, {
            name: 'Script',
            avatarUrl: 'javascript:alert(1)',
            timezone: 'UTC',
          })
        );
        const unknown = await failure(
          service().brands.create(userId, {
            name: 'Slug',
            slug: 'mine',
            timezone: 'UTC',
          } as any)
        );

        expect((avatar!.getResponse() as any).code).toBe('INVALID_BRAND');
        expect((unknown!.getResponse() as any).code).toBe('INVALID_BRAND');
      });

      it('answers 409 when the user is SUPERADMIN of no workspace', async () => {
        const user = await worker.user.create({
          data: {
            email: randomUUID() + '@test.local',
            providerName: 'LOCAL',
            timezone: 0,
          },
        });

        const err = await failure(
          service().brands.create(user.id, { name: 'Nowhere', timezone: 'UTC' })
        );

        expect(err!.getStatus()).toBe(409);
      });

      it('hides the workspace and releases the charge when the account attach fails', async () => {
        const { userId, orgId } = await owner(10);
        const wired = service();
        jest
          .spyOn(wired.accounts, 'attachOrganizationToOwner')
          .mockRejectedValueOnce(new Error('attach failed'));
        const name = 'Attach Fails ' + userId;

        await withPrice(3, async () => {
          const err = await failure(
            wired.brands.create(userId, { name, timezone: 'UTC' })
          );

          expect(err).toBeDefined();
          const rows = await orgsNamed(name);
          expect(rows.every((row) => row.deletedAt !== null)).toBe(true);
          expect(await wired.credits.balance(orgId)).toEqual({
            available: 10,
            reserved: 0,
          });
          expect(await wired.brands.listForUser(userId)).toHaveLength(1);
        });
      });

      it('never changes another brand of the user', async () => {
        const { userId, orgId } = await owner();
        const before = await worker.organization.findUniqueOrThrow({
          where: { id: orgId },
        });

        await service().brands.create(userId, { name: 'Other', timezone: 'UTC' });

        const after = await worker.organization.findUniqueOrThrow({
          where: { id: orgId },
        });
        expect(after).toEqual(before);
      });
    });

    describe('get', () => {
      it('reads a workspace made before the brand columns as slug from name, primary colour, no avatar, UTC, en and an empty profile', async () => {
        const { orgId } = await owner();
        await worker.organization.update({
          where: { id: orgId },
          data: { name: 'Old Shop###' + randomUUID() },
        });

        const brand = await service().brands.get(orgId);

        expect(brand).toEqual({
          id: orgId,
          name: 'Old Shop',
          slug: 'old-shop',
          color: BRAND_DEFAULT_COLOR,
          avatarUrl: null,
          timezone: 'UTC',
          locale: 'en',
          profile: { schemaVersion: 1 },
        });
      });

      it('answers 404 for a workspace that does not exist', async () => {
        const err = await failure(service().brands.get(randomUUID()));

        expect(err!.getStatus()).toBe(404);
      });
    });

    describe('update', () => {
      it('changes the typed fields and the profile and reads them back', async () => {
        const { userId } = await owner();
        const brand = await service().brands.create(userId, {
          name: 'Before',
          timezone: 'UTC',
        });
        const profile: BrandProfile = {
          schemaVersion: 1,
          tagline: 'Make it count',
          audience: ['founders', 'makers'],
          voice: 'Plain and warm.',
          pillars: ['craft'],
          bannedWords: ['synergy'],
        };

        const updated = await service().brands.update(brand.id, {
          name: 'After',
          color: '#112233',
          timezone: 'Asia/Tokyo',
          locale: 'ja',
          profile,
        });

        expect(updated).toMatchObject({
          id: brand.id,
          name: 'After',
          slug: brand.slug,
          color: '#112233',
          timezone: 'Asia/Tokyo',
          locale: 'ja',
          profile,
        });
        expect(await service().brands.get(brand.id)).toEqual(updated);
      });

      it('rejects an invalid profile field with 400 INVALID_BRAND and stores nothing', async () => {
        const { userId } = await owner();
        const brand = await service().brands.create(userId, {
          name: 'Keep',
          timezone: 'UTC',
        });

        const tooLong = await failure(
          service().brands.update(brand.id, {
            name: 'Changed',
            profile: { schemaVersion: 1, tagline: 'x'.repeat(161) },
          })
        );
        const unknown = await failure(
          service().brands.update(brand.id, {
            profile: { schemaVersion: 1, mood: 'sunny' } as any,
          })
        );

        expect((tooLong!.getResponse() as any).fields[0].path).toBe(
          'profile.tagline'
        );
        expect((unknown!.getResponse() as any).code).toBe('INVALID_BRAND');
        expect((await service().brands.get(brand.id)).name).toBe('Keep');
      });

      it('changes nothing for an empty update', async () => {
        const { userId } = await owner();
        const brand = await service().brands.create(userId, {
          name: 'Same',
          timezone: 'UTC',
        });

        expect(await service().brands.update(brand.id, {})).toEqual(brand);
      });
    });

    describe('listForUser', () => {
      it('lists the enabled, not deleted workspaces of the user, oldest first, and no one else\'s', async () => {
        const { userId, orgId } = await owner();
        const second = await service().brands.create(userId, {
          name: 'Second',
          timezone: 'UTC',
        });
        const hidden = await service().brands.create(userId, {
          name: 'Hidden',
          timezone: 'UTC',
        });
        await worker.organization.update({
          where: { id: hidden.id },
          data: { deletedAt: new Date() },
        });
        const stranger = await owner();

        const list = await service().brands.listForUser(userId);

        expect(list.map((b) => b.id)).toEqual([orgId, second.id]);
        expect(list[1]).toEqual({
          id: second.id,
          name: 'Second',
          slug: 'second',
          color: BRAND_DEFAULT_COLOR,
          avatarUrl: null,
          canEdit: true,
        });
        expect(list.map((b) => b.id)).not.toContain(stranger.orgId);
      });

      it('says canEdit only for the brands the user is an ADMIN or SUPERADMIN of', async () => {
        const { orgId } = await owner();
        const memberId = await joinWorkspace(orgId, 'USER');

        const list = await service().brands.listForUser(memberId);

        expect(list).toEqual([expect.objectContaining({ id: orgId, canEdit: false })]);
      });

      it('leaves out a workspace whose membership is disabled', async () => {
        const { userId, orgId } = await owner();
        await worker.userOrganization.updateMany({
          where: { userId, organizationId: orgId },
          data: { disabled: true },
        });

        expect(await service().brands.listForUser(userId)).toEqual([]);
      });
    });

    describe('getForUser', () => {
      it('reads the brand to a USER member of it', async () => {
        const { orgId } = await owner();
        const memberId = await joinWorkspace(orgId, 'USER');

        expect(await service().brands.getForUser(memberId, orgId)).toMatchObject({
          id: orgId,
        });
      });

      it('answers 404 BRAND_NOT_FOUND to a user who is no member of it', async () => {
        const { orgId } = await owner();
        const stranger = await owner();

        const err = await failure(service().brands.getForUser(stranger.userId, orgId));

        expect((err!.getResponse() as any).code).toBe('BRAND_NOT_FOUND');
      });
    });

    describe('updateForUser', () => {
      it('changes the brand of another workspace for its ADMIN and reads it back', async () => {
        const { orgId } = await owner();
        const adminId = await joinWorkspace(orgId, 'ADMIN');

        const updated = await service().brands.updateForUser(adminId, orgId, {
          name: 'Renamed elsewhere',
          timezone: 'Europe/Paris',
        });

        expect(updated).toMatchObject({ id: orgId, name: 'Renamed elsewhere', timezone: 'Europe/Paris' });
        expect(await service().brands.get(orgId)).toEqual(updated);
      });

      it('answers 403 ADMIN_REQUIRED to a USER member and changes nothing', async () => {
        const { orgId } = await owner();
        const before = await service().brands.get(orgId);
        const memberId = await joinWorkspace(orgId, 'USER');

        const err = await failure(
          service().brands.updateForUser(memberId, orgId, { name: 'Hijacked' })
        );

        expect((err!.getResponse() as any).code).toBe('ADMIN_REQUIRED');
        expect(await service().brands.get(orgId)).toEqual(before);
      });

      it('answers 404 BRAND_NOT_FOUND to a user who is no member of it', async () => {
        const { orgId } = await owner();
        const stranger = await owner();

        const err = await failure(
          service().brands.updateForUser(stranger.userId, orgId, { name: 'Nope' })
        );

        expect((err!.getResponse() as any).code).toBe('BRAND_NOT_FOUND');
        expect((await service().brands.get(orgId)).name).not.toBe('Nope');
      });
    });
  });
});
