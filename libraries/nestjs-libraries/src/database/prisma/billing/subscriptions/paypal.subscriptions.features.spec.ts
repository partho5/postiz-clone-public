// api.entitlements (E4): GET /billing/plans lists, for each tier, the app features that tier grants. Runs the
// real controller, subscriptions service and pricing service on hand-made repositories, with a copy of the
// pricing file each test may edit; needs no database.
import { PlansController } from '@gitroom/backend/api/routes/plans.controller';
import {
  FEATURE_KEYS,
  PRICING,
  PricingConfig,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { PaypalSubscriptionsService } from '@gitroom/nestjs-libraries/database/prisma/billing/subscriptions/paypal.subscriptions.service';

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

const ORG = 'org-1';
const ACCOUNT = 'account-1';

describe('api.entitlements: GET /billing/plans features', () => {
  let stored: any;
  let controller: PlansController;

  beforeEach(() => {
    stored = null;
    const service = new PaypalSubscriptionsService(
      {} as any,
      {} as any,
      { getByAccount: jest.fn(async () => stored) } as any,
      new PricingService({} as any, {} as any, {} as any),
      {} as any,
      { getAccountIdForOrganization: jest.fn(async () => ACCOUNT) } as any
    );
    controller = new PlansController(service);
  });

  afterEach(() => {
    Object.assign(PRICING, structuredClone(FILE));
  });

  it('gives each tier the features its plan grants, the free ones included, in the order of the feature list', async () => {
    const { tiers } = await controller.plans({ id: ORG } as any);

    expect(Object.fromEntries(tiers.map((tier) => [tier.key, tier.features]))).toEqual({
      STARTER: [
        'crop_9_16',
        'floating_cam',
        'drawing_board',
        'slide_ink',
        'auto_publish',
        'crop_4_5',
        'crop_1_1',
        'ai_captions',
      ],
      PRO: [
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
      ],
      AGENCY: [...FEATURE_KEYS],
    });
  });

  it('keeps every field the plans screen already read, unchanged (additive)', async () => {
    const { tiers } = await controller.plans({ id: ORG } as any);

    expect(tiers.map(({ features, ...rest }) => rest)).toEqual(FILE.tiers);
  });

  it('answers the subscription as before', async () => {
    expect((await controller.plans({ id: ORG } as any)).current).toBeNull();

    stored = {
      accountId: ACCOUNT,
      externalId: 'I-1',
      tierKey: 'PRO',
      status: 'ACTIVE',
      currentPeriodEnd: new Date('2026-11-20T00:00:00.000Z'),
      cancelAtPeriodEnd: false,
    };

    expect((await controller.plans({ id: ORG } as any)).current).toEqual({
      accountId: ACCOUNT,
      provider: 'paypal',
      tierKey: 'PRO',
      status: 'ACTIVE',
      currentPeriodEnd: '2026-11-20T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    });
  });

  it('follows the file: a feature moved to another plan moves in the lists, with no other change', async () => {
    PRICING.features.bg_custom = 'AGENCY';
    PRICING.features.crop_1_1 = 'PRO';

    const { tiers } = await controller.plans({ id: ORG } as any);
    const featuresOf = (key: string) => tiers.find((tier) => tier.key === key)!.features;

    expect(featuresOf('STARTER')).not.toContain('crop_1_1');
    expect(featuresOf('PRO')).toContain('crop_1_1');
    expect(featuresOf('PRO')).not.toContain('bg_custom');
    expect(featuresOf('AGENCY')).toContain('bg_custom');
  });

  it('lists a tier added to the file with the features of its rank', async () => {
    PRICING.tiers.push({
      key: 'ENTERPRISE' as any,
      name: 'Enterprise',
      monthlyPriceCents: 19900,
      currency: 'USD',
      monthlyCredits: 10000,
    });
    PRICING.features.bg_custom = 'ENTERPRISE' as any;

    const { tiers } = await controller.plans({ id: ORG } as any);

    expect(tiers.map((tier) => tier.key)).toEqual(['STARTER', 'PRO', 'AGENCY', 'ENTERPRISE']);
    expect(tiers[3].features).toEqual([...FEATURE_KEYS]);
    expect(tiers[2].features).not.toContain('bg_custom');
  });
});
