// PayPal reversals and lapse: the read of the PayPal subscriptions the daily poll visits.
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { PAYPAL_PROVIDER } from '@gitroom/nestjs-libraries/services/payment/payment.providers';

@Injectable()
export class ReversalsRepository {
  constructor(
    private readonly _subscription: PrismaRepository<'billingSubscription'>
  ) {}

  // PayPal subscription ids (PayPal's own) after `cursor`, in id order, with the row id to continue from.
  async paypalSubscriptions(cursor: string | undefined, take: number) {
    return this._subscription.model.billingSubscription.findMany({
      where: {
        provider: PAYPAL_PROVIDER,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take,
      select: { id: true, externalId: true },
    });
  }
}
