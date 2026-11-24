// Stripe removal: PayPal is the only web payment provider, no Stripe code, package or
// variable is left, and credits are the only limit on features. Real provider classes and the
// real billing controller and permissions service; only the providers' own dependencies are empty.
import { Test } from '@nestjs/testing';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { PaymentProviderManager } from '@gitroom/nestjs-libraries/services/payment/payment.provider.manager';
import { PaypalProvider } from '@gitroom/nestjs-libraries/services/payment/providers/paypal.provider';
import { RevenueCatProvider } from '@gitroom/nestjs-libraries/services/payment/providers/revenuecat.provider';
import { PaypalWebhookIntake } from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.webhook.intake';
import { PaypalSubscriptionsService } from '@gitroom/nestjs-libraries/database/prisma/billing/subscriptions/paypal.subscriptions.service';
import { SubscriptionService } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { BillingController } from '@gitroom/backend/api/routes/billing.controller';
import { UsersController } from '@gitroom/backend/api/routes/users.controller';
import { PermissionsService } from '@gitroom/backend/services/auth/permissions/permissions.service';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';

// Modules that pull ESM-only packages ts-jest cannot load, or a live Redis; the providers under
// test only name them as dependencies.
jest.mock('file-type', () => ({}));
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {},
  redis: {},
}));

const REPO_ROOT = join(__dirname, '../../../../..');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.next', '.git']);
// A Hashnode tag named "stripe" in the tag catalogue is Hashnode's data, not a Stripe code path
const CATALOGUE_FILES = new Set(['hashnode.tags.ts']);

// Every .ts and .tsx file under a folder, build output and dependencies left out, and this spec
// (it names what must be gone).
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (SKIPPED_DIRS.has(name)) {
      return [];
    }
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(name) &&
      !CATALOGUE_FILES.has(name) &&
      path !== __filename
      ? [path]
      : [];
  });

// The routes a controller class answers, as "METHOD /path".
const routesOf = (controller: { prototype: object }) =>
  Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => (controller.prototype as any)[name])
    .filter((fn) => typeof fn === 'function')
    .filter((fn) => Reflect.getMetadata('path', fn) !== undefined)
    .map(
      (fn) =>
        `${['GET', 'POST', 'PUT', 'DELETE', 'PATCH'][Reflect.getMetadata('method', fn)]} ${Reflect.getMetadata('path', fn)}`
    );

describe('billing.stripe-removal', () => {
  describe('payment providers', () => {
    let manager: PaymentProviderManager;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          PaymentProviderManager,
          PaypalProvider,
          RevenueCatProvider,
          { provide: PaypalWebhookIntake, useValue: {} },
          { provide: PaypalSubscriptionsService, useValue: {} },
          { provide: SubscriptionService, useValue: {} },
          { provide: OrganizationService, useValue: {} },
        ],
      }).compile();
      manager = moduleRef.get(PaymentProviderManager);
    });

    it('registers only PayPal (web) and RevenueCat (mobile)', () => {
      expect(
        manager
          .getProviders()
          .map((p) => `${p.name}:${p.provider.platform}`)
          .sort()
      ).toEqual(['paypal:web', 'revenuecat:mobile']);
    });

    it('uses PayPal as the default web provider', () => {
      expect(manager.getDefaultProvider('web').name).toBe('paypal');
    });

    it('keeps RevenueCat as the default mobile provider', () => {
      expect(manager.getDefaultProvider('mobile').name).toBe('revenuecat');
    });

    it('refuses a Stripe webhook as an unknown provider', () => {
      expect(() => manager.getProvider('stripe')).toThrow(
        'Payment provider stripe not found'
      );
    });
  });

  describe('routes', () => {
    it('leaves /billing with the mobile sync and the current subscription only', () => {
      expect(routesOf(BillingController).sort()).toEqual([
        'GET /',
        'POST /sync',
      ]);
    });

    it('has no subscription tiers route that lists Stripe prices', () => {
      expect(routesOf(UsersController)).not.toContain(
        'GET /subscription/tiers'
      );
    });
  });

  describe('credits are the only limit on features', () => {
    const permissions = new PermissionsService();
    const requested: Array<[AuthorizationActions, Sections]> = [
      [AuthorizationActions.Create, Sections.CHANNEL],
      [AuthorizationActions.Create, Sections.POSTS_PER_MONTH],
      [AuthorizationActions.Create, Sections.WEBHOOKS],
      [AuthorizationActions.Create, Sections.TEAM_MEMBERS],
      [AuthorizationActions.Create, Sections.AI],
      [AuthorizationActions.Create, Sections.IMPORT_FROM_CHANNELS],
    ];
    const original = process.env.STRIPE_PUBLISHABLE_KEY;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.STRIPE_PUBLISHABLE_KEY;
      } else {
        process.env.STRIPE_PUBLISHABLE_KEY = original;
      }
    });

    it.each([
      ['no STRIPE_* variable', undefined],
      ['a STRIPE_PUBLISHABLE_KEY left in the environment', 'pk_test_left_over'],
    ])('grants every requested permission with %s', async (_name, value) => {
      if (value === undefined) {
        delete process.env.STRIPE_PUBLISHABLE_KEY;
      } else {
        process.env.STRIPE_PUBLISHABLE_KEY = value;
      }
      const ability = await permissions.check(
        'org-1',
        new Date(),
        'USER',
        requested
      );
      for (const [action, section] of requested) {
        expect(ability.can(action, section)).toBe(true);
      }
    });
  });

  describe('no Stripe left in the repository', () => {
    it('has no "stripe" in any apps or libraries source file', () => {
      const offenders = ['apps', 'libraries']
        .flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)))
        .filter((file) => /stripe/i.test(readFileSync(file, 'utf8')))
        .map((file) => file.slice(REPO_ROOT.length + 1));
      expect(offenders).toEqual([]);
    });

    it.each(['package.json', 'pnpm-lock.yaml', '.env.example', 'docker-compose.yaml'])(
      'has no "stripe" in %s',
      (file) => {
        expect(readFileSync(join(REPO_ROOT, file), 'utf8')).not.toMatch(
          /stripe/i
        );
      }
    );
  });
});
