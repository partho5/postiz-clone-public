// Paid features (api.entitlements): the error a request is refused with when its plan lacks a feature.
import { HttpException } from '@nestjs/common';
import {
  FeatureKey,
  PlanKey,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';

// The plan of the request ranks below the lowest plan of the feature the route needs.
export class FeatureNotInPlanException extends HttpException {
  // Answers 403 FEATURE_NOT_IN_PLAN naming the feature and the lowest plan that unlocks it.
  constructor(feature: FeatureKey, requiredPlan: PlanKey) {
    super(
      { statusCode: 403, code: 'FEATURE_NOT_IN_PLAN', feature, requiredPlan },
      403
    );
  }
}
