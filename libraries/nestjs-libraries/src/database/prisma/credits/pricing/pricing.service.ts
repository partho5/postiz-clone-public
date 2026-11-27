// Pricing config: syncs the pricing file into the database at start-up and
// serves every tunable money value other than action prices (those go through CreditsService.quote).
import {
  HttpException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { CreditAction, CreditPlanOverride, CreditUnit } from '@prisma/client';
import { z } from 'zod';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  FEATURE_KEYS,
  FeatureKey,
  PlanKey,
  PRICING,
  PricingConfig,
  Tier,
  TopupPack,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.config';
import {
  PricingRepository,
  SyncedAction,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';

dayjs.extend(utc);

// The pricing file is invalid; the process must not start with it.
export class PricingConfigError extends Error {}

type SettingKey = 'free.monthlyGrant' | 'free.monthlyAiCap';

export interface PricingSyncReport {
  created: string[];
  repriced: { key: string; version: number }[];
  removed: string[];
  scheduled: { key: SettingKey; value: number; effectiveFrom: Date }[];
}

export interface PricingView {
  plan: string;
  actions: {
    key: string;
    unit: CreditUnit;
    unitCost: number;
    description: string;
  }[];
  tiers: Tier[];
  topupPacks: TopupPack[];
  free: { monthlyGrant: number; monthlyAiCap: number };
}

// One plan as the app lists it: FREE, then the tiers of the file.
export interface PlanSummary {
  key: PlanKey;
  name: string;
  monthlyPriceCents: number;
  currency: 'USD';
}

// The plan every account starts on; it is no tier of the file, so the plan list adds it first.
const FREE_PLAN: PlanSummary = {
  key: 'FREE',
  name: 'Free',
  monthlyPriceCents: 0,
  currency: 'USD',
};

// How often one action's sync re-reads after another process changed it first.
const SYNC_ATTEMPTS = 5;

const keyFormat = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const amount = z.number().int().nonnegative();
const pricingSchema = z
  .object({
    actions: z.array(
      z
        .object({
          key: z.string().regex(keyFormat),
          cost: amount,
          unit: z.nativeEnum(CreditUnit),
          description: z.string(),
          planCosts: z
            .record(
              z.enum([
                'FREE',
                'STARTER',
                'PRO',
                'AGENCY',
              ] as const satisfies readonly PlanKey[]),
              amount
            )
            .optional(),
        })
        .strict()
    ),
    free: z.object({ monthlyGrant: amount, monthlyAiCap: amount }).strict(),
    tiers: z.array(
      z
        .object({
          key: z.enum([
            'STARTER',
            'PRO',
            'AGENCY',
          ] as const satisfies readonly PlanKey[]),
          name: z.string().min(1),
          monthlyPriceCents: amount,
          currency: z.literal('USD'),
          monthlyCredits: amount,
        })
        .strict()
    ),
    topupPacks: z.array(
      z
        .object({
          key: z.string().regex(keyFormat),
          credits: amount,
          priceCents: amount,
          currency: z.literal('USD'),
        })
        .strict()
    ),
    lowBalanceRatio: z.number().gt(0).lt(1),
    features: z.record(
      z.string(),
      z.enum([
        'FREE',
        'STARTER',
        'PRO',
        'AGENCY',
      ] as const satisfies readonly PlanKey[])
    ),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const list of ['actions', 'tiers', 'topupPacks'] as const) {
      const seen = new Set<string>();
      config[list].forEach((item, index) => {
        if (seen.has(item.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [list, index, 'key'],
            message: `Duplicate key ${item.key}`,
          });
        }
        seen.add(item.key);
      });
    }

    // Every feature needs a lowest plan that exists: FREE or a tier of the file.
    const tierKeys = new Set<string>(config.tiers.map((tier) => tier.key));
    const known: readonly string[] = FEATURE_KEYS;
    for (const [feature, plan] of Object.entries(config.features)) {
      if (!known.includes(feature)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['features', feature],
          message: `Unknown feature ${feature}`,
        });
      } else if (plan !== 'FREE' && !tierKeys.has(plan)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['features', feature],
          message: `Plan ${plan} is not FREE or a tier`,
        });
      }
    }
    for (const feature of FEATURE_KEYS) {
      if (!(feature in config.features)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['features', feature],
          message: `Missing feature ${feature}`,
        });
      }
    }
  });

// Checks the pricing file; throws PricingConfigError naming every problem.
const validatePricing = (config: PricingConfig): PricingConfig => {
  const result = pricingSchema.safeParse(config);
  if (!result.success) {
    throw new PricingConfigError(
      'Invalid pricing config: ' +
        result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')
    );
  }
  return config;
};

@Injectable()
export class PricingService implements OnModuleInit {
  private readonly _logger = new Logger(PricingService.name);

  constructor(
    private _pricingRepository: PricingRepository,
    private _creditsService: CreditsService,
    private _accountsService: AccountsService
  ) {
    // Checked while the module is built, so an invalid file stops every process.
    validatePricing(PRICING);
  }

  // Syncs the pricing file at start-up and logs what changed, if anything.
  async onModuleInit() {
    const report = await this.sync();
    const changes =
      report.created.length +
      report.repriced.length +
      report.removed.length +
      report.scheduled.length;
    if (changes) {
      this._logger.log(`Pricing synced: ${JSON.stringify(report)}`);
    }
  }

  // Brings the database in line with the pricing file and reports what changed.
  async sync(): Promise<PricingSyncReport> {
    const config = validatePricing(PRICING);
    const report: PricingSyncReport = {
      created: [],
      repriced: [],
      removed: [],
      scheduled: [],
    };

    const stored = await this._pricingRepository.listActions();
    for (const action of config.actions) {
      await this.syncAction(
        {
          key: action.key,
          cost: action.cost,
          unit: action.unit,
          description: action.description,
          planCosts: Object.entries(action.planCosts ?? {})
            .filter(
              (entry): entry is [string, number] => entry[1] !== undefined
            )
            .map(([planKey, cost]) => ({ planKey, cost })),
        },
        report
      );
    }

    const fileKeys = new Set(config.actions.map((action) => action.key));
    const removed = stored
      .map((action) => action.key)
      .filter((key) => !fileKeys.has(key));
    if (removed.length) {
      await this._pricingRepository.removeActions(removed);
      report.removed = removed;
    }

    const now = new Date();
    await this.syncSetting(
      'free.monthlyGrant',
      config.free.monthlyGrant,
      now,
      report
    );
    await this.syncSetting(
      'free.monthlyAiCap',
      config.free.monthlyAiCap,
      now,
      report
    );
    return report;
  }

  // Free monthly grant in effect for the UTC month of `at`.
  freeMonthlyGrant(at = new Date()) {
    return this.settingFor('free.monthlyGrant', at);
  }

  // Free-plan monthly AI cap in effect for the UTC month of `at`.
  freeMonthlyAiCap(at = new Date()) {
    return this.settingFor('free.monthlyAiCap', at);
  }

  // Credits a plan brings each month: the tier's credits, or the free grant on FREE.
  async monthlyAllotment(planKey: string, at = new Date()) {
    if (planKey === 'FREE') {
      return this.freeMonthlyGrant(at);
    }
    const tier = this.tier(planKey);
    if (!tier) {
      throw new HttpException(`Unknown plan ${planKey}`, 500);
    }
    return tier.monthlyCredits;
  }

  // Paid plan tiers as the pricing file lists them.
  tiers(): Tier[] {
    return PRICING.tiers;
  }

  // One paid plan tier, or undefined.
  tier(key: string): Tier | undefined {
    return PRICING.tiers.find((tier) => tier.key === key);
  }

  // Top-up packs as the pricing file lists them.
  topupPacks(): TopupPack[] {
    return PRICING.topupPacks;
  }

  // One top-up pack, or undefined.
  topupPack(key: string): TopupPack | undefined {
    return PRICING.topupPacks.find((pack) => pack.key === key);
  }

  // Share of the monthly allotment below which a balance is low.
  lowBalanceRatio() {
    return PRICING.lowBalanceRatio;
  }

  // Each gateable feature with the lowest plan that unlocks it, as the pricing file lists them.
  features(): Record<FeatureKey, PlanKey> {
    return PRICING.features;
  }

  // FREE, then the tiers in the order the pricing file lists them: that order is the rank.
  plans(): PlanSummary[] {
    return [
      { ...FREE_PLAN },
      ...PRICING.tiers.map(({ key, name, monthlyPriceCents, currency }) => ({
        key,
        name,
        monthlyPriceCents,
        currency,
      })),
    ];
  }

  // Position of a plan in `plans()`: 0 for FREE, higher for a richer plan.
  planRank(planKey: string): number {
    const rank = this.plans().findIndex((plan) => plan.key === planKey);
    if (rank < 0) {
      throw new HttpException(`Unknown plan ${planKey}`, 500);
    }
    return rank;
  }

  // Every feature a plan grants, the free ones included: those whose lowest plan ranks at or below it.
  featuresFor(planKey: string): FeatureKey[] {
    const rank = this.planRank(planKey);
    return FEATURE_KEYS.filter(
      (feature) => this.planRank(PRICING.features[feature]) <= rank
    );
  }

  // Everything a workspace's account pays and gets, priced for its plan.
  async view(organizationId: string): Promise<PricingView> {
    const accountId = await this._accountsService.getAccountIdForOrganization(
      organizationId
    );
    const account = await this._accountsService.getAccountById(accountId);
    const plan = account!.planKey;
    const actions = await Promise.all(
      PRICING.actions.map(async (action) => ({
        key: action.key,
        unit: action.unit,
        unitCost: (
          await this._creditsService.quote(action.key, 1, plan)
        ).unitCost,
        description: action.description,
      }))
    );
    return {
      plan,
      actions,
      tiers: this.tiers(),
      topupPacks: this.topupPacks(),
      free: {
        monthlyGrant: await this.freeMonthlyGrant(),
        monthlyAiCap: await this.freeMonthlyAiCap(),
      },
    };
  }

  // Creates or reprices one action to match the file; a concurrent sync that got
  // there first is re-read, so each change bumps the version once.
  private async syncAction(action: SyncedAction, report: PricingSyncReport) {
    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
      const stored = await this._pricingRepository.getAction(action.key);
      if (!stored) {
        if (await this._pricingRepository.createAction(action)) {
          report.created.push(action.key);
          return;
        }
        continue;
      }
      if (this.samePrice(action, stored)) {
        if (stored.description !== action.description) {
          await this._pricingRepository.describeAction(
            action.key,
            action.description
          );
        }
        return;
      }
      const version = await this._pricingRepository.repriceAction(
        action,
        stored.version
      );
      if (version !== null) {
        report.repriced.push({ key: action.key, version });
        return;
      }
    }
    throw new Error(`Pricing sync could not settle action ${action.key}`);
  }

  // Stores a period-scoped value: in effect now on the first sync, otherwise from the
  // next UTC month; a file set back to the current value cancels the pending change.
  private async syncSetting(
    key: SettingKey,
    value: number,
    now: Date,
    report: PricingSyncReport
  ) {
    const thisMonth = this.monthStart(now);
    const current = await this._pricingRepository.settingInEffect(
      key,
      thisMonth
    );
    if (!current) {
      await this._pricingRepository.setSetting(key, value, thisMonth);
      return;
    }
    if (current.value === value) {
      await this._pricingRepository.deleteSettingsAfter(key, thisMonth);
      return;
    }
    const nextMonth = this.monthStart(now, 1);
    await this._pricingRepository.deleteSettingsAfter(key, nextMonth);
    if (await this._pricingRepository.setSetting(key, value, nextMonth)) {
      report.scheduled.push({ key, value, effectiveFrom: nextMonth });
    }
  }

  // True when the registry already charges what the file says (description aside).
  private samePrice(
    file: SyncedAction,
    stored: CreditAction & { planOverrides: CreditPlanOverride[] }
  ) {
    return (
      file.cost === stored.cost &&
      file.unit === stored.unit &&
      file.planCosts.length === stored.planOverrides.length &&
      file.planCosts.every((planCost) =>
        stored.planOverrides.some(
          (override) =>
            override.planKey === planCost.planKey &&
            override.cost === planCost.cost
        )
      )
    );
  }

  // Start of the UTC calendar month that contains `at`, shifted by `months`.
  private monthStart(at: Date, months = 0) {
    return dayjs.utc(at).startOf('month').add(months, 'month').toDate();
  }

  // Value of a setting for the UTC month of `at`; months before the first sync get its first value.
  private async settingFor(key: SettingKey, at: Date) {
    const setting =
      (await this._pricingRepository.settingInEffect(
        key,
        this.monthStart(at)
      )) ?? (await this._pricingRepository.firstSetting(key));
    if (!setting) {
      throw new Error(`Pricing setting ${key} has never been synced`);
    }
    return setting.value;
  }
}
