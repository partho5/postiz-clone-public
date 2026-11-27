// Pricing config: the action registry and period-scoped settings the sync writes.
import { Injectable } from '@nestjs/common';
import { CreditUnit, Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface SyncedAction {
  key: string;
  cost: number;
  unit: CreditUnit;
  description: string;
  planCosts: { planKey: string; cost: number }[];
}

@Injectable()
export class PricingRepository {
  constructor(
    private readonly _transaction: PrismaTransaction,
    private readonly _creditAction: PrismaRepository<'creditAction'>,
    private readonly _creditSetting: PrismaRepository<'creditSetting'>
  ) {}

  // Every registered action with its plan overrides.
  listActions() {
    return this._creditAction.model.creditAction.findMany({
      include: { planOverrides: true },
    });
  }

  // One registered action with its plan overrides, or null.
  getAction(key: string) {
    return this._creditAction.model.creditAction.findUnique({
      where: { key },
      include: { planOverrides: true },
    });
  }

  // Registers an action and its plan overrides at version 1; false when it already exists.
  async createAction(action: SyncedAction) {
    try {
      await this._creditAction.model.creditAction.create({
        data: {
          key: action.key,
          cost: action.cost,
          unit: action.unit,
          description: action.description,
          planOverrides: { create: action.planCosts },
        },
      });
      return true;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return false;
      }
      throw err;
    }
  }

  // Replaces an action's price and overrides and bumps its version by one, only if
  // it is still at `version`; returns the new version, or null when it moved.
  repriceAction(action: SyncedAction, version: number) {
    return this._transaction.model.$transaction(async (tx) => {
      const { count } = await tx.creditAction.updateMany({
        where: { key: action.key, version },
        data: {
          cost: action.cost,
          unit: action.unit,
          description: action.description,
          version: { increment: 1 },
        },
      });
      if (!count) {
        return null;
      }
      await tx.creditPlanOverride.deleteMany({
        where: { actionKey: action.key },
      });
      await tx.creditPlanOverride.createMany({
        data: action.planCosts.map((planCost) => ({
          ...planCost,
          actionKey: action.key,
        })),
      });
      return version + 1;
    });
  }

  // Changes an action's description only.
  describeAction(key: string, description: string) {
    return this._creditAction.model.creditAction.updateMany({
      where: { key },
      data: { description },
    });
  }

  // Unregisters actions together with their plan overrides.
  removeActions(keys: string[]) {
    return this._transaction.model.$transaction(async (tx) => {
      await tx.creditPlanOverride.deleteMany({
        where: { actionKey: { in: keys } },
      });
      await tx.creditAction.deleteMany({ where: { key: { in: keys } } });
    });
  }

  // The setting row in effect at `monthStart`: the latest one starting at or before it.
  settingInEffect(key: string, monthStart: Date) {
    return this._creditSetting.model.creditSetting.findFirst({
      where: { key, effectiveFrom: { lte: monthStart } },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  // The first value ever stored for a setting.
  firstSetting(key: string) {
    return this._creditSetting.model.creditSetting.findFirst({
      where: { key },
      orderBy: { effectiveFrom: 'asc' },
    });
  }

  // Stores a setting value from `effectiveFrom`; false when it was already stored.
  // Prisma's upsert reads then inserts, so two processes can both insert: the loser updates.
  async setSetting(key: string, value: number, effectiveFrom: Date) {
    const where = { key_effectiveFrom: { key, effectiveFrom } };
    const existing = await this._creditSetting.model.creditSetting.findUnique({
      where,
    });
    if (existing?.value === value) {
      return false;
    }
    try {
      await this._creditSetting.model.creditSetting.upsert({
        where,
        create: { key, value, effectiveFrom },
        update: { value },
      });
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2002'
      ) {
        throw err;
      }
      await this._creditSetting.model.creditSetting.update({
        where,
        data: { value },
      });
    }
    return true;
  }

  // Drops the values of a setting that start after `after`.
  deleteSettingsAfter(key: string, after: Date) {
    return this._creditSetting.model.creditSetting.deleteMany({
      where: { key, effectiveFrom: { gt: after } },
    });
  }
}
