// Web handoff (B2): the body of POST /public/v1/web-link, the page the app wants opened signed in.
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsString,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { PRICING } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';

// The web pages the app can open: a provider's panel on the app credentials page, its connect flow, the
// plans page on a tier, an AI caption's page, or the content plan page (which takes no identifier).
export const WEB_LINK_TARGETS = [
  'credentials',
  'connect',
  'billing',
  'ai-caption',
  'content-plan',
] as const;
export type WebLinkTarget = (typeof WEB_LINK_TARGETS)[number];

// The key of the pricing file's tier a text names in any letter case; undefined when it names none.
const tierKeyOf = (text: unknown) =>
  typeof text === 'string'
    ? PRICING.tiers.find(
        (tier) => tier.key.toLowerCase() === text.toLowerCase()
      )?.key
    : undefined;

// The longest caption id the app can name (the ids are uuids; the server checks the caption is the workspace's).
const CAPTION_ID_MAX_LENGTH = 100;

// Whether the identifier fits the target: a tier key for the plans page, any id for a caption (the service checks
// it is the workspace's), a provider for the others.
@ValidatorConstraint({ name: 'checkWebLinkIdentifier', async: false })
export class WebLinkIdentifier implements ValidatorConstraintInterface {
  validate(identifier: unknown, args: ValidationArguments) {
    switch ((args.object as WebLinkRequestDto).target) {
      case 'billing':
        return !!tierKeyOf(identifier);
      case 'ai-caption':
        return (
          typeof identifier === 'string' &&
          identifier.length > 0 &&
          identifier.length <= CAPTION_ID_MAX_LENGTH
        );
      default:
        return socialIntegrationList.some((p) => p.identifier === identifier);
    }
  }

  defaultMessage(args: ValidationArguments) {
    switch ((args.object as WebLinkRequestDto).target) {
      case 'billing':
        return 'identifier must be a plan tier key';
      case 'ai-caption':
        return 'identifier must be a caption id';
      default:
        return 'identifier must be a known provider';
    }
  }
}

// The page to open and what it is for (a provider, a tier, or a caption; the content plan page needs none); an unknown target, provider or tier is a
// 400. A tier key is kept in the pricing file's own letter case, whatever case the app sent.
export class WebLinkRequestDto {
  @IsIn(WEB_LINK_TARGETS)
  target: WebLinkTarget;

  @ValidateIf((o) => o.target !== 'content-plan')
  @IsString()
  @Transform(({ value, obj }) =>
    obj?.target === 'billing' ? tierKeyOf(value) ?? value : value
  )
  @Validate(WebLinkIdentifier)
  identifier?: string;
}
