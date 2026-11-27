// PayPal subscriptions: the plans created at PayPal for the pricing tiers and the paid plan
// each account holds, mirrored from PayPal's own state.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { PAYPAL_PROVIDER } from '@gitroom/nestjs-libraries/services/payment/payment.providers';

export interface StoredSubscription {
  accountId: string;
  externalId: string;
  tierKey: string;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface StoredPlan {
  tierKey: string;
  // The PayPal API host the plan was created on; null for a plan stored before it was recorded.
  environment: string | null;
  productId: string;
  planId: string;
  priceCents: number;
  currency: string;
}

// True when Prisma refused a write because a unique value is already taken.
const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

@Injectable()
export class PaypalSubscriptionsRepository {
  constructor(
    private readonly _subscription: PrismaRepository<'billingSubscription'>,
    private readonly _plan: PrismaRepository<'paypalPlan'>,
    private readonly _account: PrismaRepository<'account'>
  ) {}

  // The subscription an account holds, or null.
  getByAccount(accountId: string) {
    return this._subscription.model.billingSubscription.findUnique({
      where: { accountId },
    });
  }

  // The subscription stored under a PayPal subscription id, or null.
  getByExternalId(externalId: string) {
    return this._subscription.model.billingSubscription.findUnique({
      where: { externalId },
    });
  }

  // Stores the account's subscription, replacing the one it held. Prisma's upsert reads then
  // inserts, so a concurrent first write is retried as an update of the winner's row.
  async save(subscription: StoredSubscription) {
    const data = { ...subscription, provider: PAYPAL_PROVIDER };
    try {
      return await this._subscription.model.billingSubscription.upsert({
        where: { accountId: subscription.accountId },
        create: data,
        update: data,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      return this._subscription.model.billingSubscription.update({
        where: { accountId: subscription.accountId },
        data,
      });
    }
  }

  // The PayPal plan created for a tier in a PayPal environment, or null.
  getPlanByTier(tierKey: string, environment: string) {
    return this._plan.model.paypalPlan.findUnique({
      where: { tierKey_environment: { tierKey, environment } },
    });
  }

  // The tier's plan stored before environments were recorded, or null.
  getUnrecordedPlan(tierKey: string) {
    return this._plan.model.paypalPlan.findFirst({
      where: { tierKey, environment: null },
    });
  }

  // Records the environment of a plan stored without one; when a concurrent writer already stored
  // the tier's plan for that environment, that plan is returned instead.
  async recordEnvironment(id: string, tierKey: string, environment: string) {
    try {
      return await this._plan.model.paypalPlan.update({
        where: { id },
        data: { environment },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      return this.getPlanByTier(tierKey, environment);
    }
  }

  // The PayPal plan with this PayPal plan id, or null.
  getPlanByPlanId(planId: string) {
    return this._plan.model.paypalPlan.findUnique({ where: { planId } });
  }

  // Stores the PayPal plan of a tier in its environment; a concurrent writer's row is updated to
  // these values.
  async savePlan(plan: StoredPlan & { environment: string }) {
    const where = {
      tierKey_environment: {
        tierKey: plan.tierKey,
        environment: plan.environment,
      },
    };
    try {
      return await this._plan.model.paypalPlan.upsert({
        where,
        create: plan,
        update: plan,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      return this._plan.model.paypalPlan.update({ where, data: plan });
    }
  }

  // Sets the plan key an account is on.
  setPlanKey(accountId: string, planKey: string) {
    return this._account.model.account.update({
      where: { id: accountId },
      data: { planKey },
    });
  }
}
