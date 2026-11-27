// Paid features (api.entitlements): the decorator that names the feature a server-run route needs.
import { SetMetadata } from '@nestjs/common';
import { FeatureKey } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';

export const REQUIRE_FEATURE_KEY = 'require_feature';

// Names the feature a route needs; a plan below the feature's lowest plan is refused.
export const RequireFeature = (feature: FeatureKey) =>
  SetMetadata(REQUIRE_FEATURE_KEY, feature);
