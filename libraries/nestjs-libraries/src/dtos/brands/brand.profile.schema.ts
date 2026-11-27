// Brand profile: what a brand stores, its versioned creative profile, and the validated
// shapes of the create and update bodies.
import { z } from 'zod';

// The colour a brand has until it picks one: the product primary (the theme token's value, #612bd3).
export const BRAND_DEFAULT_COLOR = '#612bd3';
// What a workspace created before the brand columns existed reads as.
export const BRAND_DEFAULT_TIMEZONE = 'UTC';
export const BRAND_DEFAULT_LOCALE = 'en';

// The creative profile, version 1. Strict: a field this version does not know is refused.
export const BrandProfileV1 = z
  .object({
    schemaVersion: z.literal(1),
    tagline: z.string().max(160).optional(),
    audience: z.array(z.string().min(1).max(60)).max(20).optional(),
    voice: z.string().max(2000).optional(),
    pillars: z.array(z.string().min(1).max(80)).max(20).optional(),
    bannedWords: z.array(z.string().min(1).max(60)).max(200).optional(),
  })
  .strict();
// The current version of the profile.
export const BrandProfile = BrandProfileV1;
export type BrandProfile = z.infer<typeof BrandProfile>;

export interface BrandView {
  id: string;
  name: string;
  slug: string;
  color: string;
  avatarUrl: string | null;
  timezone: string;
  locale: string;
  profile: BrandProfile;
}

export interface BrandSummary {
  id: string;
  name: string;
  slug: string;
  color: string;
  avatarUrl: string | null;
  // Whether the user is an ADMIN or SUPERADMIN of this brand, so the switcher offers Edit.
  canEdit: boolean;
}

export type CreateBrand = {
  name: string;
  color?: string;
  avatarUrl?: string;
  timezone: string;
  locale?: string;
};
export type UpdateBrand = Partial<CreateBrand> & { profile?: BrandProfile };

// Whether a value is an IANA time zone this runtime knows.
const isTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

// Whether a value is one well-formed BCP 47 language tag.
const isLocale = (value: string) => {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
};

// Whether a value is an absolute http(s) URL.
const isWebUrl = (value: string) => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

const name = z.string().trim().min(1).max(80);
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #612bd3')
  .transform((value) => value.toLowerCase());
const avatarUrl = z
  .string()
  .max(2048)
  .refine(isWebUrl, 'must be an http or https URL');
const timezone = z.string().max(64).refine(isTimezone, 'must be an IANA time zone');
const locale = z.string().max(35).refine(isLocale, 'must be a BCP 47 language tag');

// The body of `POST /brands`.
export const CreateBrandSchema = z
  .object({
    name,
    color: color.optional(),
    avatarUrl: avatarUrl.optional(),
    timezone,
    locale: locale.optional(),
  })
  .strict();

// The body of `PUT /brands/current`: any of the typed fields and the whole profile.
export const UpdateBrandSchema = z
  .object({
    name: name.optional(),
    color: color.optional(),
    avatarUrl: avatarUrl.optional(),
    timezone: timezone.optional(),
    locale: locale.optional(),
    profile: BrandProfile.optional(),
  })
  .strict();
