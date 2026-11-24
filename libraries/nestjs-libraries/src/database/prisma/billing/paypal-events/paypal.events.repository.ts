// PayPal webhook intake: storing each PayPal event by its id and running its handlers
// under the event's row lock, so an event is acted on once.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export const PAYPAL_PROVIDER_KEY = 'paypal';

// Handlers call PayPal (with retries) while the lock is held, so the transaction outlives Prisma's default 5 s.
const HANDLER_TX_OPTIONS = { maxWait: 15000, timeout: 120000 };

export interface StoredPaypalEvent {
  id: string;
  eventType: string;
  resourceId: string | null;
  payload: unknown;
}

@Injectable()
export class PaypalEventsRepository {
  constructor(
    private readonly _transaction: PrismaTransaction,
    private readonly _event: PrismaRepository<'paymentEvent'>
  ) {}

  // Stores the event under its PayPal id; an id already stored is left as it is.
  async record(event: StoredPaypalEvent) {
    await this._event.model.paymentEvent.createMany({
      data: {
        id: event.id,
        provider: PAYPAL_PROVIDER_KEY,
        eventType: event.eventType,
        resourceId: event.resourceId,
        payload: event.payload as Prisma.InputJsonValue,
      },
      skipDuplicates: true,
    });
  }

  // Runs `run` while holding the event's row lock and marks the event processed when it returns;
  // false, with `run` not called, when the event is already processed. A concurrent delivery
  // waits for the lock, then finds it processed. When `run` throws, the attempt is still counted
  // and the error is rethrown after the transaction commits.
  async runOnce(id: string, run: () => Promise<void>) {
    let failure: { error: unknown } | undefined;
    const ran = await this._transaction.model.$transaction(async (tx) => {
      const claimed = await tx.paymentEvent.updateMany({
        where: { id, processedAt: null },
        data: { attempts: { increment: 1 } },
      });
      if (!claimed.count) {
        return false;
      }
      try {
        await run();
        await tx.paymentEvent.update({
          where: { id },
          data: { processedAt: new Date() },
        });
      } catch (error) {
        failure = { error };
      }
      return true;
    }, HANDLER_TX_OPTIONS);
    if (failure) {
      throw failure.error;
    }
    return ran;
  }

  // Which of the given event ids are already processed.
  async processedIds(ids: string[]) {
    const rows = await this._event.model.paymentEvent.findMany({
      where: { id: { in: ids }, processedAt: { not: null } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  // The most recently received processed event of this type about this resource, or null.
  async findProcessed(eventType: string, resourceId: string) {
    const row = await this._event.model.paymentEvent.findFirst({
      where: { eventType, resourceId, processedAt: { not: null } },
      orderBy: { receivedAt: 'desc' },
      select: { payload: true },
    });
    return row ? row.payload : null;
  }
}
