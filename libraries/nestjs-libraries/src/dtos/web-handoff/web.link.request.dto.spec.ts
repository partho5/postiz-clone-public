// api.web-handoff / api.entitlements (E4): the body of POST /public/v1/web-link. `billing` takes a tier key of
// the pricing file in any letter case and keeps the file's own; `credentials` and `connect` still take a
// provider; `ai-caption` (ai.video-captions) takes a caption id. Runs the body through Nest's own ValidationPipe, as main.ts sets it up; needs no database.
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  PRICING,
  PricingConfig,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import {
  WEB_LINK_TARGETS,
  WebLinkRequestDto,
} from '@gitroom/nestjs-libraries/dtos/web-handoff/web.link.request.dto';

// The provider list is a stand-in: the real one builds every social provider, which this spec does not need.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  socialIntegrationList: [
    { identifier: 'x' },
    { identifier: 'facebook' },
    { identifier: 'linkedin-page' },
  ],
}));
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

// The pipe of main.ts: the body becomes a DTO instance (so @Transform runs), then it is validated.
const pipe = new ValidationPipe({ transform: true });
const check = (body: unknown): Promise<WebLinkRequestDto> =>
  pipe.transform(body, { type: 'body', metatype: WebLinkRequestDto });

// The messages of the 400 the pipe throws for a body.
const refusal = async (body: unknown) => {
  const err = await check(body).catch((e) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  expect(err.getStatus()).toBe(400);
  return JSON.stringify(err.getResponse());
};

describe('api.web-handoff: web link request', () => {
  afterEach(() => {
    Object.assign(PRICING, structuredClone(FILE));
  });

  it('knows the credentials, connect, billing, ai-caption and content-plan targets', () => {
    expect([...WEB_LINK_TARGETS]).toEqual([
      'credentials',
      'connect',
      'billing',
      'ai-caption',
      'content-plan',
    ]);
  });

  describe('content-plan', () => {
    it('takes no identifier, and accepts any that is sent', async () => {
      await expect(check({ target: 'content-plan' })).resolves.toMatchObject({
        target: 'content-plan',
      });
      await expect(
        check({ target: 'content-plan', identifier: 'anything' })
      ).resolves.toMatchObject({ target: 'content-plan' });
    });
  });

  describe('billing', () => {
    it('takes each tier key of the pricing file as it is written there', async () => {
      for (const key of FILE.tiers.map((tier) => tier.key)) {
        await expect(check({ target: 'billing', identifier: key })).resolves.toMatchObject({
          target: 'billing',
          identifier: key,
        });
      }
    });

    it('takes a tier key in any letter case and hands on the pricing file\'s own key', async () => {
      const lower = await check({ target: 'billing', identifier: 'pro' });
      const mixed = await check({ target: 'billing', identifier: 'StArTeR' });
      const upper = await check({ target: 'billing', identifier: 'AGENCY' });

      expect(lower.identifier).toBe('PRO');
      expect(mixed.identifier).toBe('STARTER');
      expect(upper.identifier).toBe('AGENCY');
    });

    it('refuses FREE (no tier of the file), an unknown plan, an empty or padded text with a 400', async () => {
      for (const identifier of ['FREE', 'free', 'platinum', '', ' PRO', 'PRO ', 'PR0']) {
        expect(await refusal({ target: 'billing', identifier })).toContain('identifier');
      }
    });

    it('refuses a provider, a missing identifier and a value that is not text with a 400', async () => {
      for (const body of [
        { target: 'billing', identifier: 'x' },
        { target: 'billing', identifier: 'facebook' },
        { target: 'billing' },
        { target: 'billing', identifier: 1 },
        { target: 'billing', identifier: ['PRO'] },
        { target: 'billing', identifier: null },
      ]) {
        expect(await refusal(body)).toContain('identifier');
      }
    });

    it('follows the file: a tier added to it is accepted, a tier taken out is refused', async () => {
      PRICING.tiers.push({
        key: 'ENTERPRISE' as any,
        name: 'Enterprise',
        monthlyPriceCents: 19900,
        currency: 'USD',
        monthlyCredits: 10000,
      });
      expect((await check({ target: 'billing', identifier: 'enterprise' })).identifier).toBe(
        'ENTERPRISE'
      );

      PRICING.tiers.splice(
        PRICING.tiers.findIndex((tier) => tier.key === 'PRO'),
        1
      );
      expect(await refusal({ target: 'billing', identifier: 'PRO' })).toContain('identifier');
    });
  });

  describe('ai-caption', () => {
    it('takes a caption id as it is, in the letter case it came in', async () => {
      for (const identifier of [
        '0b1f6a52-9d3c-4c8e-8a53-5f1f0e7c2b11',
        'Cap-1',
        'abc',
      ]) {
        await expect(check({ target: 'ai-caption', identifier })).resolves.toMatchObject({
          target: 'ai-caption',
          identifier,
        });
      }
    });

    it('is no provider and no tier: those names are just ids here', async () => {
      for (const identifier of ['x', 'PRO']) {
        await expect(check({ target: 'ai-caption', identifier })).resolves.toMatchObject({
          identifier,
        });
      }
    });

    it('refuses a missing, empty or over-long identifier and a value that is not text with a 400', async () => {
      for (const body of [
        { target: 'ai-caption' },
        { target: 'ai-caption', identifier: '' },
        { target: 'ai-caption', identifier: 'a'.repeat(101) },
        { target: 'ai-caption', identifier: 1 },
        { target: 'ai-caption', identifier: ['cap-1'] },
        { target: 'ai-caption', identifier: null },
      ]) {
        expect(await refusal(body)).toContain('identifier');
      }
    });
  });

  describe.each(['credentials', 'connect'] as const)('%s', (target) => {
    it('still takes a provider of the list, unchanged', async () => {
      for (const identifier of ['x', 'facebook', 'linkedin-page']) {
        await expect(check({ target, identifier })).resolves.toMatchObject({
          target,
          identifier,
        });
      }
    });

    it('does not change the letter case of a provider, and refuses another case or an unknown one with a 400', async () => {
      for (const identifier of ['FACEBOOK', 'Facebook', 'myspace', '']) {
        expect(await refusal({ target, identifier })).toContain('identifier');
      }
    });

    it('refuses a tier key, in any letter case, with a 400', async () => {
      for (const identifier of ['PRO', 'pro', 'STARTER', 'FREE']) {
        expect(await refusal({ target, identifier })).toContain('identifier');
      }
    });

    it('refuses a missing identifier and a value that is not text with a 400', async () => {
      for (const body of [{ target }, { target, identifier: 1 }, { target, identifier: null }]) {
        expect(await refusal(body)).toContain('identifier');
      }
    });
  });

  describe('target', () => {
    it('refuses an unknown or missing target with a 400', async () => {
      for (const body of [
        { target: 'plans', identifier: 'PRO' },
        { target: 'BILLING', identifier: 'PRO' },
        { identifier: 'PRO' },
      ]) {
        expect(await refusal(body)).toContain('target');
      }
    });
  });
});
