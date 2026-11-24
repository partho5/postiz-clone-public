// Paid features (api.entitlements): which plan a request has, and so which features it may use.
import { Injectable } from '@nestjs/common';
import {
  FeatureKey,
  PlanKey,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import {
  PlanSummary,
  PricingService,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { EntitlementsRepository } from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlements.repository';
import {
  EntitlementClaims,
  EntitlementTokenSigner,
} from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlement.token.signer';

// How long the app should wait before asking again, in seconds (it refreshes about every 6 hours while online).
export const REFRESH_AFTER_SECONDS = 6 * 60 * 60;

// The device that asks: its user, its session (the `sid` of the token) and the workspace the call is for.
export interface EntitlementsCaller {
  userId: string;
  sessionId: string;
  organizationId: string | null;
}

// What GET /entitlements answers: the signed token, and the plan and feature map the app shows.
export interface EntitlementsResponse {
  token: string;
  plan: PlanKey;
  refreshAfter: number;
  catalogue: {
    plans: PlanSummary[];
    features: Record<FeatureKey, PlanKey>;
  };
}

@Injectable()
export class EntitlementsService {
  constructor(
    private _entitlementsRepository: EntitlementsRepository,
    private _pricingService: PricingService,
    private _entitlementTokenSigner: EntitlementTokenSigner
  ) {}

  // The plan of a request: the better of the user's own account and the account that owns the
  // workspace, so a payer keeps their features in any workspace and a member of a paid workspace gets
  // its features there. No user (an API key, an anonymous call) leaves the workspace's plan, and neither
  // leaves FREE. Read from the database on every call and never cached, so a plan that was just
  // confirmed shows on the next call. Whether the user belongs to the workspace is for the caller to check.
  async planFor(
    userId: string | null,
    organizationId: string | null
  ): Promise<PlanKey> {
    const plans = await Promise.all([
      userId ? this._entitlementsRepository.ownPlan(userId) : null,
      organizationId
        ? this._entitlementsRepository.workspacePlan(organizationId)
        : null,
    ]);
    let best: PlanKey = 'FREE';
    for (const plan of plans) {
      if (
        plan &&
        this._pricingService.planRank(plan) >
          this._pricingService.planRank(best)
      ) {
        best = plan as PlanKey;
      }
    }
    return best;
  }

  // Whether the plan of this request grants the feature.
  async has(
    userId: string | null,
    organizationId: string | null,
    feature: FeatureKey
  ): Promise<boolean> {
    const plan = await this.planFor(userId, organizationId);
    return this._pricingService.featuresFor(plan).includes(feature);
  }

  // The signed token for a device and the catalogue it goes with; no caller is an anonymous request, which
  // gets FREE and a token without session, user or workspace. A signed-in token always carries its session.
  async issue(
    caller: EntitlementsCaller | null
  ): Promise<EntitlementsResponse> {
    const plan = await this.planFor(
      caller?.userId ?? null,
      caller?.organizationId ?? null
    );
    const claims: EntitlementClaims = {
      plan,
      features: this._pricingService.featuresFor(plan),
    };
    if (caller) {
      claims.sid = caller.sessionId;
      claims.sub = caller.userId;
      if (caller.organizationId) {
        claims.ws = caller.organizationId;
      }
    }
    return {
      token: this._entitlementTokenSigner.sign(claims),
      plan,
      refreshAfter: REFRESH_AFTER_SECONDS,
      catalogue: {
        plans: this._pricingService.plans(),
        features: this._pricingService.features(),
      },
    };
  }
}
