// api.entitlements (E1): the feature map of the pricing file, the plan ranking and the plan list.
// Needs no database: the service is built with stand-ins for its collaborators and each test edits a
// copy of the file.
import { HttpException } from '@nestjs/common';
import {
  PricingConfigError,
  PricingService,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import {
  FEATURE_KEYS,
  PRICING,
  PricingConfig,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';

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

const build = () => new PricingService({} as any, {} as any, {} as any);

describe('api.entitlements: pricing features', () => {
  afterEach(() => {
    Object.assign(PRICING, structuredClone(FILE));
  });

  describe('feature map', () => {
    it('holds the starting map and serves it as it is', () => {
      expect(build().features()).toEqual({
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
      });
    });

    it('has a plan for every feature key', () => {
      expect(Object.keys(FILE.features).sort()).toEqual([...FEATURE_KEYS].sort());
    });

    it('reads a moved feature from the file directly', () => {
      PRICING.features.bg_custom = 'AGENCY';

      expect(build().features().bg_custom).toBe('AGENCY');
    });
  });

  describe('plans and rank', () => {
    it('lists FREE first and then the tiers in the order of the file, without credits', () => {
      expect(build().plans()).toEqual([
        { key: 'FREE', name: 'Free', monthlyPriceCents: 0, currency: 'USD' },
        { key: 'STARTER', name: 'Starter', monthlyPriceCents: 900, currency: 'USD' },
        { key: 'PRO', name: 'Pro', monthlyPriceCents: 2900, currency: 'USD' },
        { key: 'AGENCY', name: 'Agency', monthlyPriceCents: 7900, currency: 'USD' },
      ]);
    });

    it('ranks FREE below STARTER, PRO and AGENCY, in that order', () => {
      const pricing = build();
      const ranks = ['FREE', 'STARTER', 'PRO', 'AGENCY'].map((plan) => pricing.planRank(plan));

      expect(ranks).toEqual([0, 1, 2, 3]);
    });

    it('takes the rank from the order of the tiers in the file', () => {
      PRICING.tiers.reverse();
      const pricing = build();

      expect(pricing.plans().map((plan) => plan.key)).toEqual(['FREE', 'AGENCY', 'PRO', 'STARTER']);
      expect(pricing.planRank('AGENCY')).toBe(1);
      expect(pricing.planRank('STARTER')).toBe(3);
    });

    it('fails on a plan it does not know', () => {
      const pricing = build();

      expect(() => pricing.planRank('ENTERPRISE')).toThrow(HttpException);
      expect(() => pricing.planRank('')).toThrow(HttpException);
      expect(() => pricing.featuresFor('ENTERPRISE')).toThrow(HttpException);
    });
  });

  describe('featuresFor', () => {
    it('grants every feature whose lowest plan ranks at or below the plan', () => {
      const pricing = build();
      const free = ['crop_9_16', 'floating_cam', 'drawing_board', 'slide_ink', 'auto_publish'];
      const starter = [...free, 'crop_4_5', 'crop_1_1', 'ai_captions'];

      expect(pricing.featuresFor('FREE')).toEqual(free);
      expect(pricing.featuresFor('STARTER')).toEqual(starter);
      expect(pricing.featuresFor('PRO')).toEqual([...starter, 'bg_replace', 'bg_custom']);
      expect(pricing.featuresFor('AGENCY')).toEqual([...FEATURE_KEYS]);
    });

    it('moves a feature to another plan with one edit of the file', () => {
      const pricing = build();
      PRICING.features.bg_custom = 'AGENCY';
      PRICING.features.crop_1_1 = 'FREE';

      expect(pricing.featuresFor('PRO')).not.toContain('bg_custom');
      expect(pricing.featuresFor('AGENCY')).toContain('bg_custom');
      expect(pricing.featuresFor('FREE')).toContain('crop_1_1');
    });
  });

  describe('an invalid map', () => {
    const invalid: [string, (config: PricingConfig) => void][] = [
      ['an unknown feature', (c) => ((c.features as any).teleport = 'FREE')],
      ['a missing feature', (c) => delete (c.features as any).crop_1_1],
      ['an unknown plan', (c) => (c.features.crop_1_1 = 'ENTERPRISE' as any)],
      ['a plan key in lower case', (c) => (c.features.crop_1_1 = 'pro' as any)],
      ['an empty plan', (c) => (c.features.crop_1_1 = '' as any)],
      [
        'a plan that is no tier of the file',
        (c) => {
          c.tiers = c.tiers.filter((tier) => tier.key !== 'AGENCY');
          c.features.bg_custom = 'AGENCY';
        },
      ],
    ];

    it('is accepted when it is the checked-in one', () => {
      expect(build).not.toThrow();
    });

    it.each(invalid)('with %s stops the process at start-up: the service cannot be built', (_, breakIt) => {
      breakIt(PRICING);

      expect(build).toThrow(PricingConfigError);
    });

    it('names the feature in the error', () => {
      PRICING.features.bg_custom = 'ENTERPRISE' as any;

      expect(build).toThrow(/features\.bg_custom/);
    });
  });
});
