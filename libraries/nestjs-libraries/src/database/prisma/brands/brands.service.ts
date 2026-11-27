// Brand profile: creating a brand, and reading and changing a brand's typed fields and
// validated creative profile.
import { HttpException, Injectable } from '@nestjs/common';
import { Organization, Prisma, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  BRAND_DEFAULT_COLOR,
  BRAND_DEFAULT_LOCALE,
  BRAND_DEFAULT_TIMEZONE,
  BrandProfile,
  BrandSummary,
  BrandView,
  CreateBrand,
  CreateBrandSchema,
  UpdateBrand,
  UpdateBrandSchema,
} from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';
import {
  BrandChanges,
  BrandsRepository,
} from '@gitroom/nestjs-libraries/database/prisma/brands/brands.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';

export type { BrandSummary, BrandView };

// How often a taken slug is drawn again (a concurrent create took it) before giving up.
const SLUG_ATTEMPTS = 5;
// The longest slug derived from a name.
const SLUG_MAX_LENGTH = 48;
// Workspaces created before brands carry the creating user's id after this marker in their name.
const NAME_SUFFIX_MARKER = '###';

// A typed field or the profile failed validation: { statusCode, code, message, fields }.
class InvalidBrandException extends HttpException {
  // Answers 400 INVALID_BRAND with each failing path and why.
  constructor(fields: { path: string; message: string }[]) {
    super(
      {
        statusCode: 400,
        code: 'INVALID_BRAND',
        message: 'The brand has invalid fields',
        fields,
      },
      400
    );
  }
}

// The workspace has no brand with this id.
class BrandNotFoundException extends HttpException {
  // Answers 404 BRAND_NOT_FOUND.
  constructor() {
    super({ statusCode: 404, code: 'BRAND_NOT_FOUND' }, 404);
  }
}

// The caller is a member of the brand but not an admin of it.
export class AdminRequiredException extends HttpException {
  // Answers 403 ADMIN_REQUIRED.
  constructor() {
    super({ statusCode: 403, code: 'ADMIN_REQUIRED' }, 403);
  }
}

// The user owns no workspace the creation can be booked against.
class NoOwnedWorkspaceException extends HttpException {
  // Answers 409 NO_OWNED_WORKSPACE.
  constructor() {
    super({ statusCode: 409, code: 'NO_OWNED_WORKSPACE' }, 409);
  }
}

// Whether a role may change the brand.
export const canEditRole = (role: Role | undefined) =>
  role === Role.ADMIN || role === Role.SUPERADMIN;

// What a workspace is called to the user: its name without the marker older sign-ups append.
export const displayName = (name: string) =>
  name.split(NAME_SUFFIX_MARKER)[0].trim() || name;

// A URL-safe slug from a name: lower case letters and digits joined by single dashes.
const slugify = (name: string) => {
  const slug = displayName(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'brand';
};

// The brands of a user: how they are made, read and changed.
@Injectable()
export class BrandsService {
  // Receives the repository, the credit engine and the account attach.
  constructor(
    private _brandsRepository: BrandsRepository,
    private _creditsService: CreditsService,
    private _accountsService: AccountsService
  ) {}

  // Makes a workspace with the user as SUPERADMIN, attached to the user's account and charged
  // `brand.create`; a refused charge or a failed write leaves nothing behind.
  async create(userId: string, input: CreateBrand): Promise<BrandView> {
    const body = this.parse(CreateBrandSchema, input);
    const payer = await this._brandsRepository.findPayerOrganization(userId);
    if (!payer) {
      throw new NoOwnedWorkspaceException();
    }
    const organizationId = randomUUID();
    return this._creditsService.spend(
      {
        organizationId: payer,
        userId,
        actionKey: 'brand.create',
        idempotencyKey: `brand:${organizationId}:create`,
        metadata: { organizationId },
      },
      () => this.write(userId, organizationId, body)
    );
  }

  // The brand of a workspace; 404 when it does not exist.
  async get(organizationId: string): Promise<BrandView> {
    const row = await this._brandsRepository.findById(organizationId);
    if (!row) {
      throw new BrandNotFoundException();
    }
    return this.view(row);
  }

  // Changes the given fields of a workspace's brand; nothing is stored when any of them is invalid.
  async update(organizationId: string, input: UpdateBrand): Promise<BrandView> {
    const body = this.parse(UpdateBrandSchema, input);
    const changes: BrandChanges = {
      ...body,
      profile: body.profile as Prisma.InputJsonValue | undefined,
    };
    const defined = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined)
    ) as BrandChanges;
    if (!(await this._brandsRepository.findById(organizationId))) {
      throw new BrandNotFoundException();
    }
    if (!Object.keys(defined).length) {
      return this.get(organizationId);
    }
    return this.view(await this._brandsRepository.update(organizationId, defined));
  }

  // The brand of a workspace the user is a member of; 404 when they are not, so no other brand is revealed.
  async getForUser(userId: string, organizationId: string): Promise<BrandView> {
    const membership = await this._brandsRepository.findMembership(userId, organizationId);
    if (!membership) {
      throw new BrandNotFoundException();
    }
    return this.view(membership.organization);
  }

  // Changes a workspace's brand for an ADMIN or SUPERADMIN of it; 404 when the user is not a member, 403 when they are a USER.
  async updateForUser(
    userId: string,
    organizationId: string,
    input: UpdateBrand
  ): Promise<BrandView> {
    const membership = await this._brandsRepository.findMembership(userId, organizationId);
    if (!membership) {
      throw new BrandNotFoundException();
    }
    if (!canEditRole(membership.role)) {
      throw new AdminRequiredException();
    }
    return this.update(organizationId, input);
  }

  // The user's enabled, not deleted workspaces as summaries, oldest first; canEdit says whether the user is an admin of each.
  async listForUser(userId: string): Promise<BrandSummary[]> {
    const rows = await this._brandsRepository.listForUser(userId);
    return rows.map((row) => {
      const { id, name, slug, color, avatarUrl } = this.view(row);
      return {
        id,
        name,
        slug,
        color,
        avatarUrl,
        canEdit: canEditRole(row.users[0]?.role),
      };
    });
  }

  // Writes the workspace under a slug free in the user's account and attaches it to that account;
  // a workspace whose attach fails is hidden again before the failure is rethrown.
  private async write(
    userId: string,
    organizationId: string,
    body: z.output<typeof CreateBrandSchema>
  ): Promise<BrandView> {
    const account = await this._accountsService.getAccountByOwner(userId);
    const taken = new Set(
      (account ? await this._brandsRepository.accountSlugs(account.id) : []).map(
        (row) => row.slug ?? slugify(row.name)
      )
    );
    const base = slugify(body.name);
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
      const slug = this.freeSlug(base, taken);
      const row = await this._brandsRepository.create({
        id: organizationId,
        userId,
        accountId: account?.id ?? null,
        name: body.name,
        slug,
        color: body.color ?? BRAND_DEFAULT_COLOR,
        avatarUrl: body.avatarUrl ?? null,
        timezone: body.timezone,
        locale: body.locale ?? BRAND_DEFAULT_LOCALE,
        profile: { schemaVersion: 1 },
      });
      if (row) {
        try {
          await this._accountsService.attachOrganizationToOwner(row.id, userId);
        } catch (err) {
          await this._brandsRepository.discard(row.id);
          throw err;
        }
        return this.view(row);
      }
      taken.add(slug);
    }
    throw new Error('Could not find a free brand slug');
  }

  // The base slug, or the base with the lowest number that is not taken.
  private freeSlug(base: string, taken: Set<string>) {
    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) {
      slug = `${base}-${n}`;
    }
    return slug;
  }

  // Validates an input against a schema; every failing path is answered as INVALID_BRAND.
  private parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
    const result = schema.safeParse(input);
    if (!result.success) {
      throw new InvalidBrandException(
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }))
      );
    }
    return result.data;
  }

  // The brand a row reads as; a column never written reads as its default, and a stored profile
  // that does not parse reads as the empty profile until the next save replaces it.
  private view(row: Organization): BrandView {
    const parsed = BrandProfile.safeParse(row.profile ?? { schemaVersion: 1 });
    return {
      id: row.id,
      name: displayName(row.name),
      slug: row.slug ?? slugify(row.name),
      color: row.color ?? BRAND_DEFAULT_COLOR,
      avatarUrl: row.avatarUrl ?? null,
      timezone: row.timezone ?? BRAND_DEFAULT_TIMEZONE,
      locale: row.locale ?? BRAND_DEFAULT_LOCALE,
      profile: parsed.success ? parsed.data : { schemaVersion: 1 },
    };
  }
}
