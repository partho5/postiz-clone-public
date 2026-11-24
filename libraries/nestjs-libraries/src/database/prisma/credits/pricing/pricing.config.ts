// Pricing config: the one place every tunable money value is edited.
// Start-up syncs it into the database; nothing else is a source of these values.
import { CreditUnit } from '@prisma/client';

export type PlanKey = 'FREE' | 'STARTER' | 'PRO' | 'AGENCY';

// Every feature of the FaceCam app a plan can unlock (api.entitlements). A new gateable feature is
// a key here and a line in PRICING.features.
export const FEATURE_KEYS = [
  'crop_9_16',
  'floating_cam',
  'drawing_board',
  'slide_ink',
  'auto_publish',
  'crop_4_5',
  'crop_1_1',
  'ai_captions',
  'bg_replace',
  'bg_custom',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface PricingConfig {
  actions: {
    key: string;
    cost: number;
    unit: CreditUnit;
    description: string;
    planCosts?: Partial<Record<PlanKey, number>>;
  }[];
  free: { monthlyGrant: number; monthlyAiCap: number };
  tiers: {
    key: Exclude<PlanKey, 'FREE'>;
    name: string;
    monthlyPriceCents: number;
    currency: 'USD';
    monthlyCredits: number;
  }[];
  topupPacks: {
    key: string;
    credits: number;
    priceCents: number;
    currency: 'USD';
  }[];
  // Below this share of the monthly allotment the balance counts as low; 0 < r < 1
  lowBalanceRatio: number;
  // The lowest plan that unlocks each feature; a plan grants every feature at or below its own rank
  features: Record<FeatureKey, PlanKey>;
}

export type Tier = PricingConfig['tiers'][number];
export type TopupPack = PricingConfig['topupPacks'][number];

export const PRICING: PricingConfig = {
  actions: [
    { key: 'post.publish', cost: 1, unit: 'ITEM', description: 'Publish a post to one channel' },
    { key: 'ai.text', cost: 1, unit: 'CALL', description: 'Generate or rewrite text' },
    { key: 'ai.image', cost: 5, unit: 'ITEM', description: 'Generate one image' },
    { key: 'ai.video.per_second', cost: 2, unit: 'SECOND', description: 'Generate video, per second' },
    { key: 'ai.clip.per_minute', cost: 5, unit: 'ITEM', description: 'Clip a video, per source minute' },
    { key: 'ai.captions.per_minute', cost: 1, unit: 'ITEM', description: 'Write captions from a video, per whole minute' },
    { key: 'ai.edit.basic', cost: 1, unit: 'ITEM', description: 'AI edit a video at Basic, per started 3 minutes' },
    { key: 'ai.edit.standard', cost: 2, unit: 'ITEM', description: 'AI edit a video at Standard, per started 3 minutes' },
    { key: 'ai.edit.heavy', cost: 3, unit: 'ITEM', description: 'AI edit a video at Heavy, per started 3 minutes' },
    { key: 'brand.create', cost: 0, unit: 'CALL', description: 'Create a workspace' },
    { key: 'channel.connect', cost: 0, unit: 'CALL', description: 'Connect a channel' },
    { key: 'plan.setup_round', cost: 0, unit: 'CALL', description: 'Plan a business: one question round' },
    { key: 'plan.proposal', cost: 0, unit: 'CALL', description: 'Plan a business: write the plan structure' },
    { key: 'plan.instant', cost: 0, unit: 'CALL', description: "Plan a business: refine the owner's own idea" },
    { key: 'plan.week', cost: 0, unit: 'CALL', description: 'Plan a business: write a week of videos' },
    { key: 'plan.day', cost: 0, unit: 'CALL', description: 'Plan a business: rewrite one video' },
    { key: 'plan.roadmap', cost: 0, unit: 'CALL', description: 'Plan a business: extend the roadmap' },
  ],
  free: { monthlyGrant: 50, monthlyAiCap: 25 },
  tiers: [
    { key: 'STARTER', name: 'Starter', monthlyPriceCents: 900, currency: 'USD', monthlyCredits: 300 },
    { key: 'PRO', name: 'Pro', monthlyPriceCents: 2900, currency: 'USD', monthlyCredits: 1200 },
    { key: 'AGENCY', name: 'Agency', monthlyPriceCents: 7900, currency: 'USD', monthlyCredits: 4000 },
  ],
  topupPacks: [
    { key: 'pack.100', credits: 100, priceCents: 500, currency: 'USD' },
    { key: 'pack.500', credits: 500, priceCents: 2000, currency: 'USD' },
    { key: 'pack.2000', credits: 2000, priceCents: 7000, currency: 'USD' },
  ],
  lowBalanceRatio: 0.2,
  features: {
    crop_9_16: 'FREE',
    floating_cam: 'FREE',
    drawing_board: 'FREE',
    slide_ink: 'FREE',
    auto_publish: 'FREE',
    crop_4_5: 'STARTER',
    crop_1_1: 'STARTER',
    ai_captions: 'STARTER',
    bg_replace: 'PRO',
    bg_custom: 'PRO',
  },
};
