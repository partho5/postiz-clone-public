// Paid features (api.entitlements): the guard that refuses a request whose plan does not grant the feature a route needs.
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Organization, User } from '@prisma/client';
import { FeatureKey } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { EntitlementsService } from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlements.service';
import { REQUIRE_FEATURE_KEY } from '@gitroom/backend/services/auth/scopes/require.feature';
import { FeatureNotInPlanException } from '@gitroom/backend/services/auth/scopes/feature.exceptions';

// Refuses a request whose plan is below the lowest plan of the feature the route names. The plan is the
// better of the user's own account and the workspace's account; an API key or an OAuth-app token carries no
// user, so only the workspace's account counts. A route that names no feature, or a feature every plan has
// (FREE in the pricing file), passes without a read.
@Injectable()
export class FeatureGuard implements CanActivate {
  // Receives the reflector that reads the route's feature, and the services that tell the plan of the request.
  constructor(
    private _reflector: Reflector,
    private _entitlementsService: EntitlementsService,
    private _pricingService: PricingService
  ) {}

  // Lets the request through, or throws FEATURE_NOT_IN_PLAN naming the feature and its lowest plan.
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this._reflector.get<FeatureKey | undefined>(
      REQUIRE_FEATURE_KEY,
      context.getHandler()
    );
    if (!required) {
      return true;
    }
    // Every plan grants a free feature, so no plan is read for it.
    const requiredPlan = this._pricingService.features()[required];
    if (requiredPlan === 'FREE') {
      return true;
    }
    const { user, org } = context
      .switchToHttp()
      .getRequest<Request & { user?: User; org?: Organization }>();
    if (
      !(await this._entitlementsService.has(
        user?.id ?? null,
        org?.id ?? null,
        required
      ))
    ) {
      throw new FeatureNotInPlanException(required, requiredPlan);
    }
    return true;
  }
}
