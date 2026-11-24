// PayPal top-ups: storing the credit-pack orders an account owner buys once.
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export type TopupStatus = 'CREATED' | 'APPROVED' | 'CAPTURED' | 'FAILED';

export interface NewTopupOrder {
  id: string;
  accountId: string;
  userId: string;
  paypalOrderId: string;
  packKey: string;
  credits: number;
  priceCents: number;
  currency: string;
}

@Injectable()
export class TopupsRepository {
  constructor(private _topup: PrismaRepository<'topupOrder'>) {}

  // Stores a new order in the CREATED state.
  create(order: NewTopupOrder) {
    return this._topup.model.topupOrder.create({
      data: { ...order, status: 'CREATED' },
    });
  }

  // The account's order with this PayPal order id, or null (another account's order is not found).
  findForAccount(accountId: string, paypalOrderId: string) {
    return this._topup.model.topupOrder.findFirst({
      where: { accountId, paypalOrderId },
    });
  }

  // The order PayPal knows by the row id it was given as `custom_id`, or by its own order id.
  findByReference(
    rowId: string | undefined,
    paypalOrderId: string | undefined
  ) {
    const or = [
      ...(rowId ? [{ id: rowId }] : []),
      ...(paypalOrderId ? [{ paypalOrderId }] : []),
    ];
    if (!or.length) {
      return Promise.resolve(null);
    }
    return this._topup.model.topupOrder.findFirst({ where: { OR: or } });
  }

  // The order whose payment was captured under this capture id, or null.
  findByCapture(captureId: string) {
    return this._topup.model.topupOrder.findUnique({ where: { captureId } });
  }

  // Sets the order's state without touching its capture or grant.
  setStatus(id: string, status: TopupStatus) {
    return this._topup.model.topupOrder.update({
      where: { id },
      data: { status },
    });
  }

  // Records the capture the order was paid by; `grantedAt` is set once, when credits were granted.
  async markCaptured(id: string, captureId: string, granted: boolean) {
    await this._topup.model.topupOrder.update({
      where: { id },
      data: { captureId, status: 'CAPTURED' },
    });
    if (granted) {
      await this._topup.model.topupOrder.updateMany({
        where: { id, grantedAt: null },
        data: { grantedAt: new Date() },
      });
    }
    return this._topup.model.topupOrder.findUniqueOrThrow({ where: { id } });
  }
}
