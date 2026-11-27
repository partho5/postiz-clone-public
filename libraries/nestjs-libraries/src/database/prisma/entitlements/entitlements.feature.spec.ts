// api.entitlements (E3): @RequireFeature and FeatureGuard. Runs the real guard, entitlements service and
// pricing service on a hand-made repository and a fake request, with a copy of the pricing file each test may
// edit (to make auto_publish a paid feature); needs no database. The two public routes that carry the
// decorator are read from the controller's source with the TypeScript parser, because the real controller
// pulls in ES-module-only packages jest here cannot load.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PRICING,
  PricingConfig,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { EntitlementsService } from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlements.service';
import { FeatureNotInPlanException } from '@gitroom/backend/services/auth/scopes/feature.exceptions';
import { FeatureGuard } from '@gitroom/backend/services/auth/scopes/feature.guard';
import {
  REQUIRE_FEATURE_KEY,
  RequireFeature,
} from '@gitroom/backend/services/auth/scopes/require.feature';

// The file under test is a copy each test may edit; the checked-in values stay in FILE.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config',
  () => {
    const actual = jest.requireActual(
      '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config'
    );
    return { ...actual, PRICING: structuredClone(actual.PRICING) };
  }
);
const FILE: PricingConfig = jest.requireActual(
  '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config'
).PRICING;

const root = path.resolve(__dirname, '../../../../../..');
const publicController =
  'apps/backend/src/public-api/routes/v1/public.integrations.controller.ts';

const USER = 'user-1';
const ORG = 'org-1';

// Routes as a controller declares them: one for the feature that is free in the file, one for a paid
// one, and one that names no feature.
class Probe {
  @RequireFeature('auto_publish')
  autoPublish() {}

  @RequireFeature('bg_custom')
  customBackground() {}

  open() {}
}

// What the authentication middleware sets on the request of a device token (a user and the workspace
// it acts in) and of an API key (the key's workspace only; no user).
const deviceRequest = { user: { id: USER }, org: { id: ORG } };
const keyRequest = { org: { id: ORG } };

// The execution context of a call to a route handler.
const contextOf = (handler: () => void, request: object) =>
  ({
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext);

// The decorators of a node, as { name, args } with string-literal arguments unquoted.
const decoratorsOf = (node: ts.Node) =>
  (ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []).flatMap(
    (decorator) => {
      const expression = decorator.expression;
      if (
        !ts.isCallExpression(expression) ||
        !ts.isIdentifier(expression.expression)
      ) {
        return [];
      }
      return [
        {
          name: expression.expression.text,
          args: expression.arguments.map((arg) =>
            ts.isStringLiteralLike(arg) ? arg.text : arg.getText()
          ),
        },
      ];
    }
  );

describe('api.entitlements: @RequireFeature and FeatureGuard', () => {
  let repo: any;
  let guard: FeatureGuard;

  // The plan the user's own account has and the plan of the workspace's account (null: no such account)
  const plans = (own: string | null, workspace: string | null) => {
    repo.ownPlan.mockResolvedValue(own);
    repo.workspacePlan.mockResolvedValue(workspace);
  };

  // Runs the guard for a route of the probe and answers what it threw, or true when it let the call through
  const run = (
    handler: () => void,
    request: object = deviceRequest
  ): Promise<unknown> =>
    guard.canActivate(contextOf(handler, request)).catch((err) => err);

  // Expects the guard to have refused with the exact body the contract gives
  const expectRefused = (result: unknown, feature: string, requiredPlan: string) => {
    expect(result).toBeInstanceOf(FeatureNotInPlanException);
    const refusal = result as FeatureNotInPlanException;
    expect(refusal.getStatus()).toBe(403);
    expect(refusal.getResponse()).toEqual({
      statusCode: 403,
      code: 'FEATURE_NOT_IN_PLAN',
      feature,
      requiredPlan,
    });
  };

  beforeEach(() => {
    repo = { ownPlan: jest.fn(), workspacePlan: jest.fn() };
    plans(null, null);
    const pricing = new PricingService({} as any, {} as any, {} as any);
    guard = new FeatureGuard(
      new Reflector(),
      new EntitlementsService(repo, pricing, {} as any),
      pricing
    );
  });

  afterEach(() => {
    Object.assign(PRICING, structuredClone(FILE));
  });

  describe('the decorator', () => {
    it('stores the feature on the route handler, where the guard reads it', () => {
      expect(Reflect.getMetadata(REQUIRE_FEATURE_KEY, Probe.prototype.autoPublish)).toBe(
        'auto_publish'
      );
      expect(
        Reflect.getMetadata(REQUIRE_FEATURE_KEY, Probe.prototype.customBackground)
      ).toBe('bg_custom');
      expect(Reflect.getMetadata(REQUIRE_FEATURE_KEY, Probe.prototype.open)).toBeUndefined();
    });
  });

  describe('a route that names no feature', () => {
    it('passes without reading any plan', async () => {
      plans(null, null);

      await expect(run(Probe.prototype.open)).resolves.toBe(true);
      await expect(run(Probe.prototype.open, keyRequest)).resolves.toBe(true);
      await expect(run(Probe.prototype.open, {})).resolves.toBe(true);
      expect(repo.ownPlan).not.toHaveBeenCalled();
      expect(repo.workspacePlan).not.toHaveBeenCalled();
    });
  });

  describe('a free feature (auto_publish in the checked-in file)', () => {
    it('passes for a FREE user, a user and workspace with no account, and a FREE key', async () => {
      plans('FREE', 'FREE');
      await expect(run(Probe.prototype.autoPublish)).resolves.toBe(true);

      plans(null, null);
      await expect(run(Probe.prototype.autoPublish)).resolves.toBe(true);
      await expect(run(Probe.prototype.autoPublish, keyRequest)).resolves.toBe(true);
    });

    it('passes on every plan', async () => {
      for (const plan of ['FREE', 'STARTER', 'PRO', 'AGENCY']) {
        plans(plan, plan);

        await expect(run(Probe.prototype.autoPublish)).resolves.toBe(true);
      }
    });

    it('reads no plan, so the route behaves as it did before it was decorated (even on a corrupt stored plan)', async () => {
      plans('ENTERPRISE', 'ENTERPRISE');

      await expect(run(Probe.prototype.autoPublish)).resolves.toBe(true);
      await expect(run(Probe.prototype.autoPublish, keyRequest)).resolves.toBe(true);
      expect(repo.ownPlan).not.toHaveBeenCalled();
      expect(repo.workspacePlan).not.toHaveBeenCalled();
    });
  });

  describe('a feature moved to PRO in the file', () => {
    beforeEach(() => {
      PRICING.features.auto_publish = 'PRO';
    });

    it('refuses a FREE user with 403 FEATURE_NOT_IN_PLAN, the feature and its lowest plan', async () => {
      plans('FREE', 'FREE');

      expectRefused(await run(Probe.prototype.autoPublish), 'auto_publish', 'PRO');
      expect(repo.ownPlan).toHaveBeenCalledWith(USER);
      expect(repo.workspacePlan).toHaveBeenCalledWith(ORG);
    });

    it('refuses a user and workspace with no account (FREE) and a plan below PRO', async () => {
      plans(null, null);
      expectRefused(await run(Probe.prototype.autoPublish), 'auto_publish', 'PRO');

      plans('STARTER', 'FREE');
      expectRefused(await run(Probe.prototype.autoPublish), 'auto_publish', 'PRO');
    });

    it('lets a PRO user through, and an AGENCY one (a higher rank)', async () => {
      plans('PRO', 'FREE');
      await expect(run(Probe.prototype.autoPublish)).resolves.toBe(true);

      plans('AGENCY', 'FREE');
      await expect(run(Probe.prototype.autoPublish)).resolves.toBe(true);
    });

    it('lets a FREE member of a PRO workspace through (the better plan counts)', async () => {
      plans('FREE', 'PRO');

      await expect(run(Probe.prototype.autoPublish)).resolves.toBe(true);
    });

    it('names the lowest plan of the file, so moving the feature again changes the answer', async () => {
      PRICING.features.auto_publish = 'AGENCY';
      plans('PRO', 'FREE');

      expectRefused(await run(Probe.prototype.autoPublish), 'auto_publish', 'AGENCY');
    });

    it('reads the plan on every call, so a plan just confirmed lets the next call through', async () => {
      plans('FREE', 'FREE');
      expectRefused(await run(Probe.prototype.autoPublish), 'auto_publish', 'PRO');

      plans('PRO', 'FREE');
      await expect(run(Probe.prototype.autoPublish)).resolves.toBe(true);

      plans('FREE', 'FREE');
      expectRefused(await run(Probe.prototype.autoPublish), 'auto_publish', 'PRO');
    });
  });

  describe('an API key (no user)', () => {
    beforeEach(() => {
      PRICING.features.auto_publish = 'PRO';
    });

    it('uses the plan of the key\'s workspace: PRO passes', async () => {
      plans('AGENCY', 'PRO');

      await expect(run(Probe.prototype.autoPublish, keyRequest)).resolves.toBe(true);
      expect(repo.ownPlan).not.toHaveBeenCalled();
      expect(repo.workspacePlan).toHaveBeenCalledWith(ORG);
    });

    it('uses the plan of the key\'s workspace: FREE is refused, whatever its members pay', async () => {
      plans('AGENCY', 'FREE');

      expectRefused(await run(Probe.prototype.autoPublish, keyRequest), 'auto_publish', 'PRO');
      expect(repo.ownPlan).not.toHaveBeenCalled();
    });

    it('treats a workspace with no account yet as FREE', async () => {
      plans(null, null);

      expectRefused(await run(Probe.prototype.autoPublish, keyRequest), 'auto_publish', 'PRO');
    });
  });

  describe('the other paid features of the file', () => {
    it('refuses a STARTER plan for a PRO feature and names PRO', async () => {
      plans('STARTER', 'FREE');

      expectRefused(await run(Probe.prototype.customBackground), 'bg_custom', 'PRO');
    });

    it('lets PRO through', async () => {
      plans('PRO', 'FREE');

      await expect(run(Probe.prototype.customBackground)).resolves.toBe(true);
    });
  });

  describe('a stored plan the pricing file does not know, on a paid feature', () => {
    it('is a 500, never a pass and never a 403', async () => {
      plans('ENTERPRISE', 'FREE');

      const result = await run(Probe.prototype.customBackground);

      expect(result).toMatchObject({ status: 500 });
      expect(result).not.toBeInstanceOf(FeatureNotInPlanException);
    });
  });

  describe('the public auto-publish routes', () => {
    // The `VERB path feature` of every route of the public controller that names a feature, and the
    // controller's guards in the order they run.
    const gatedRoutes = () => {
      const full = path.resolve(root, publicController);
      const source = ts.createSourceFile(
        full,
        fs.readFileSync(full, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      const found = { routes: [] as string[], guards: [] as string[] };
      // Walks the file for the controller class and reads its decorators and its routes'.
      const visit = (node: ts.Node) => {
        if (
          ts.isClassDeclaration(node) &&
          node.name?.text === 'PublicIntegrationsController'
        ) {
          found.guards = decoratorsOf(node)
            .filter((d) => d.name === 'UseGuards')
            .flatMap((d) => d.args);
          for (const member of node.members) {
            const decorators = ts.isMethodDeclaration(member)
              ? decoratorsOf(member)
              : [];
            const verb = decorators.find((d) =>
              ['Get', 'Post', 'Put', 'Delete', 'Patch'].includes(d.name)
            );
            const feature = decorators.find((d) => d.name === 'RequireFeature');
            if (verb && feature) {
              found.routes.push(
                `${verb.name.toUpperCase()} ${verb.args[0]} ${feature.args[0]}`
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    };

    it('name auto_publish on POST /auto-publish and PUT /auto-publish/channels/:integrationId, ai_captions on POST /ai-captions, and on no other route', () => {
      expect(gatedRoutes().routes.sort()).toEqual([
        'POST /ai-captions ai_captions',
        'POST /auto-publish auto_publish',
        'PUT /auto-publish/channels/:integrationId auto_publish',
      ]);
    });

    it('run the scope guard first and the feature guard second', () => {
      expect(gatedRoutes().guards).toEqual(['ScopeGuard', 'FeatureGuard']);
    });

    it('are free in the checked-in file, so the decorator changes nothing for anyone today', () => {
      expect(FILE.features.auto_publish).toBe('FREE');
    });
  });
});
