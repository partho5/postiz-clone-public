// api.entitlements (E1): the plan of a request is the better of the user's own account and the account
// that owns the workspace, read fresh on every call. The first block runs on a hand-made repository and
// needs no database; the second reads real rows and runs only with TEST_DATABASE_URL.
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  PrismaRepository,
  PrismaService,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { EntitlementsRepository } from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlements.repository';
import { EntitlementsService } from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlements.service';

const pricing = () => new PricingService({} as any, {} as any, {} as any);
// These cases never sign a token (entitlements.token.spec.ts does)
const signer = () => ({} as any);

describe('api.entitlements: EntitlementsService', () => {
  let repo: any;
  let service: EntitlementsService;

  // The plan the user's own account has and the plan of the workspace's account (null: no such account)
  const plans = (own: string | null, workspace: string | null) => {
    repo.ownPlan.mockResolvedValue(own);
    repo.workspacePlan.mockResolvedValue(workspace);
  };

  beforeEach(() => {
    repo = { ownPlan: jest.fn(), workspacePlan: jest.fn() };
    plans(null, null);
    service = new EntitlementsService(repo, pricing(), signer());
  });

  describe('planFor', () => {
    it('takes the own plan when it is richer than the workspace one', async () => {
      plans('PRO', 'FREE');

      await expect(service.planFor('user-1', 'org-1')).resolves.toBe('PRO');
      expect(repo.ownPlan).toHaveBeenCalledWith('user-1');
      expect(repo.workspacePlan).toHaveBeenCalledWith('org-1');
    });

    it('takes the workspace plan when it is richer than the own one', async () => {
      plans('FREE', 'AGENCY');

      await expect(service.planFor('user-1', 'org-1')).resolves.toBe('AGENCY');
    });

    it('takes the workspace plan when the user has no account of their own', async () => {
      plans(null, 'STARTER');

      await expect(service.planFor('user-1', 'org-1')).resolves.toBe('STARTER');
    });

    it('takes the own plan when the workspace has no account yet', async () => {
      plans('PRO', null);

      await expect(service.planFor('user-1', 'org-1')).resolves.toBe('PRO');
    });

    it('answers the shared plan when both are the same, and FREE when neither account exists', async () => {
      plans('STARTER', 'STARTER');
      await expect(service.planFor('user-1', 'org-1')).resolves.toBe('STARTER');

      plans(null, null);
      await expect(service.planFor('user-1', 'org-1')).resolves.toBe('FREE');
    });

    it('ranks the plans by the order of the pricing file, not by name', async () => {
      plans('STARTER', 'PRO');
      await expect(service.planFor('user-1', 'org-1')).resolves.toBe('PRO');

      plans('AGENCY', 'PRO');
      await expect(service.planFor('user-1', 'org-1')).resolves.toBe('AGENCY');
    });

    it('uses only the workspace plan for an API key (no user)', async () => {
      plans('AGENCY', 'PRO');

      await expect(service.planFor(null, 'org-1')).resolves.toBe('PRO');
      expect(repo.ownPlan).not.toHaveBeenCalled();
    });

    it('uses only the own plan when there is no workspace', async () => {
      plans('PRO', 'AGENCY');

      await expect(service.planFor('user-1', null)).resolves.toBe('PRO');
      expect(repo.workspacePlan).not.toHaveBeenCalled();
    });

    it('is FREE for an anonymous call and reads nothing', async () => {
      plans('AGENCY', 'AGENCY');

      await expect(service.planFor(null, null)).resolves.toBe('FREE');
      expect(repo.ownPlan).not.toHaveBeenCalled();
      expect(repo.workspacePlan).not.toHaveBeenCalled();
    });

    it('reads the plans again on every call, so a plan just confirmed shows at once', async () => {
      plans('FREE', 'FREE');
      await expect(service.planFor('user-1', 'org-1')).resolves.toBe('FREE');

      plans('PRO', 'FREE');
      await expect(service.planFor('user-1', 'org-1')).resolves.toBe('PRO');

      plans('FREE', 'FREE');
      await expect(service.planFor('user-1', 'org-1')).resolves.toBe('FREE');
      expect(repo.ownPlan).toHaveBeenCalledTimes(3);
      expect(repo.workspacePlan).toHaveBeenCalledTimes(3);
    });

    it('fails on a stored plan the pricing file does not know, rather than guess', async () => {
      plans('ENTERPRISE', 'FREE');

      await expect(service.planFor('user-1', 'org-1')).rejects.toMatchObject({ status: 500 });
    });
  });

  describe('has', () => {
    it('is true for a free feature on every plan and false for a paid one on FREE', async () => {
      plans('FREE', 'FREE');

      await expect(service.has('user-1', 'org-1', 'auto_publish')).resolves.toBe(true);
      await expect(service.has('user-1', 'org-1', 'crop_4_5')).resolves.toBe(false);
      await expect(service.has('user-1', 'org-1', 'bg_replace')).resolves.toBe(false);
    });

    it('grants a feature from the lowest plan up', async () => {
      plans('STARTER', 'FREE');
      await expect(service.has('user-1', 'org-1', 'crop_1_1')).resolves.toBe(true);
      await expect(service.has('user-1', 'org-1', 'bg_custom')).resolves.toBe(false);

      plans('PRO', 'FREE');
      await expect(service.has('user-1', 'org-1', 'bg_custom')).resolves.toBe(true);
    });

    it('counts the workspace plan, and the own plan in another workspace', async () => {
      plans('FREE', 'AGENCY');
      await expect(service.has('user-1', 'org-1', 'bg_custom')).resolves.toBe(true);

      plans('PRO', 'FREE');
      await expect(service.has('user-1', 'org-2', 'bg_custom')).resolves.toBe(true);
    });

    it('uses the workspace plan for an API key', async () => {
      plans('AGENCY', 'FREE');

      await expect(service.has(null, 'org-1', 'crop_4_5')).resolves.toBe(false);
    });

    it('is false for a feature the pricing file does not have', async () => {
      plans('AGENCY', 'AGENCY');

      await expect(service.has('user-1', 'org-1', 'teleport' as any)).resolves.toBe(false);
    });
  });
});

// Runs against a real Postgres, migrated and given the API role by the jest global setup.
// The service runs as the API role (the backend); rows are made with the worker role.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('api.entitlements: EntitlementsRepository (Postgres)', () => {
  let api: PrismaService;
  let worker: PrismaClient;
  let service: EntitlementsService;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_API_URL;
    api = new PrismaService();
    await api.$connect();
    worker = new PrismaClient({ datasourceUrl: url });
    const repo = new PrismaRepository<any>(api);
    service = new EntitlementsService(
      new EntitlementsRepository(repo, repo),
      pricing(),
      signer()
    );
  });

  afterAll(async () => {
    await api.$disconnect();
    await worker.$disconnect();
  });

  // A user, with an account of their own on `plan` when one is given
  const user = async (plan?: string) => {
    const { id } = await worker.user.create({
      data: { email: randomUUID() + '@test.local', providerName: 'LOCAL', timezone: 0 },
    });
    if (plan) {
      await worker.account.create({ data: { ownerId: id, planKey: plan } });
    }
    return id;
  };

  // A workspace billed to the account of `ownerId`, which gets `plan`
  const workspace = async (ownerId: string, plan: string) => {
    const account = await worker.account.upsert({
      where: { ownerId },
      create: { ownerId, planKey: plan },
      update: { planKey: plan },
    });
    const org = await worker.organization.create({
      data: { name: 'ws-' + randomUUID(), accountId: account.id },
    });
    return org.id;
  };

  it('gives a member with a PRO account of their own PRO in a FREE workspace', async () => {
    const member = await user('PRO');
    const org = await workspace(await user(), 'FREE');

    await expect(service.planFor(member, org)).resolves.toBe('PRO');
  });

  it('gives a FREE member the plan of an AGENCY workspace', async () => {
    const member = await user('FREE');
    const org = await workspace(await user(), 'AGENCY');

    await expect(service.planFor(member, org)).resolves.toBe('AGENCY');
  });

  it('gives a user with no account the plan of the workspace, and an API key the same', async () => {
    const member = await user();
    const org = await workspace(await user(), 'STARTER');

    await expect(service.planFor(member, org)).resolves.toBe('STARTER');
    await expect(service.planFor(null, org)).resolves.toBe('STARTER');
  });

  it('is FREE for a user with no account in a workspace with none, and for an unknown workspace', async () => {
    const member = await user();
    const org = await worker.organization.create({ data: { name: 'ws-' + randomUUID() } });

    await expect(service.planFor(member, org.id)).resolves.toBe('FREE');
    await expect(service.planFor(member, randomUUID())).resolves.toBe('FREE');
    await expect(service.planFor(null, null)).resolves.toBe('FREE');
  });

  it('reads Account.planKey fresh on every call', async () => {
    const owner = await user();
    const org = await workspace(owner, 'FREE');
    await expect(service.planFor(owner, org)).resolves.toBe('FREE');

    await worker.account.update({ where: { ownerId: owner }, data: { planKey: 'PRO' } });
    await expect(service.planFor(owner, org)).resolves.toBe('PRO');
    await expect(service.planFor(null, org)).resolves.toBe('PRO');

    await worker.account.update({ where: { ownerId: owner }, data: { planKey: 'FREE' } });
    await expect(service.planFor(owner, org)).resolves.toBe('FREE');
  });
});
