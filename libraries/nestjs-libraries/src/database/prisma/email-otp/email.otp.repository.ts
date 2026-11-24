// Email one-time-code sign-in: storing sign-in codes as keyed hashes and reading the user an address belongs to.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface RequestClaim {
  email: string;
  requestIp: string;
  now: Date;
  windowStart: Date;
  limit: number;
  cooldownSeconds: number;
}

// The outcome of claiming a request: its row id, or the seconds until it may come again.
export type ClaimResult =
  | { claimed: true; id: string }
  | { claimed: false; retryAfterSeconds: number };

// How many times a serialization conflict between concurrent requests is retried before it is refused.
const CLAIM_ATTEMPTS = 20;

// Reads and writes the `EmailOtp` rows and looks up the user an address belongs to.
@Injectable()
export class EmailOtpRepository {
  // Receives the Prisma repositories for `emailOtp` and `user`, and the transaction runner.
  constructor(
    private _emailOtp: PrismaRepository<'emailOtp'>,
    private _user: PrismaRepository<'user'>,
    private _transaction: PrismaTransaction
  ) {}

  // Deletes the rows created before the cutoff.
  async deleteCreatedBefore(cutoff: Date): Promise<void> {
    await this._emailOtp.model.emailOtp.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
  }

  // Counts this request against the address and the client address and stores it as a retired row, or
  // answers when it may come again; serializable, so concurrent requests cannot both take the last place.
  async claimRequest(claim: RequestClaim): Promise<ClaimResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this._transaction.model.$transaction(
          async (tx) => {
            const recent = await tx.emailOtp.findMany({
              where: {
                createdAt: { gte: claim.windowStart },
                OR: [{ email: claim.email }, { requestIp: claim.requestIp }],
              },
              select: { email: true, requestIp: true, createdAt: true },
              orderBy: { createdAt: 'asc' },
            });
            // A new code for the same address is refused until the cooldown since its last request has passed.
            const lastForAddress = recent
              .filter((row) => row.email === claim.email)
              .pop();
            if (lastForAddress && claim.cooldownSeconds > 0) {
              const readyAt =
                lastForAddress.createdAt.getTime() +
                claim.cooldownSeconds * 1000;
              if (readyAt > claim.now.getTime()) {
                return {
                  claimed: false as const,
                  retryAfterSeconds: Math.max(
                    1,
                    Math.ceil((readyAt - claim.now.getTime()) / 1000)
                  ),
                };
              }
            }
            // The time at which these rows reached the request limit, or null while there is room.
            const full = (rows: typeof recent) =>
              rows.length >= claim.limit
                ? rows[rows.length - claim.limit].createdAt
                : null;
            const lifted = [
              full(recent.filter((row) => row.email === claim.email)),
              full(recent.filter((row) => row.requestIp === claim.requestIp)),
            ].filter((at): at is Date => at !== null);
            if (lifted.length) {
              const freeAt = Math.max(...lifted.map((at) => at.getTime()));
              const windowMs = claim.now.getTime() - claim.windowStart.getTime();
              return {
                claimed: false as const,
                retryAfterSeconds: Math.max(
                  1,
                  Math.ceil((freeAt + windowMs - claim.now.getTime()) / 1000)
                ),
              };
            }
            const row = await tx.emailOtp.create({
              data: {
                email: claim.email,
                codeHash: '',
                expiresAt: claim.now,
                consumedAt: claim.now,
                requestIp: claim.requestIp,
                createdAt: claim.now,
              },
              select: { id: true },
            });
            return { claimed: true as const, id: row.id };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (err) {
        const conflict =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2034';
        if (!conflict || attempt >= CLAIM_ATTEMPTS) {
          throw err;
        }
      }
    }
  }

  // Makes the claimed row the address's one usable code and retires every earlier unused one.
  async activate(
    id: string,
    email: string,
    codeHash: string,
    expiresAt: Date,
    now: Date
  ): Promise<void> {
    await this._transaction.model.$transaction([
      this._emailOtp.model.emailOtp.updateMany({
        where: { email, consumedAt: null },
        data: { consumedAt: now },
      }),
      this._emailOtp.model.emailOtp.update({
        where: { id },
        data: { codeHash, expiresAt, consumedAt: null },
      }),
    ]);
  }

  // Makes the row unusable, keeping it so the request still counts.
  async retire(id: string, now: Date): Promise<void> {
    await this._emailOtp.model.emailOtp.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: now },
    });
  }

  // The address's newest unused, unexpired code that still has tries left, or null.
  findUsable(email: string, now: Date, maxTries: number) {
    return this._emailOtp.model.emailOtp.findFirst({
      where: {
        email,
        consumedAt: null,
        expiresAt: { gt: now },
        tries: { lt: maxTries },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Counts one wrong value against the code, unless it is already used or out of tries.
  async addTry(id: string, maxTries: number): Promise<void> {
    await this._emailOtp.model.emailOtp.updateMany({
      where: { id, consumedAt: null, tries: { lt: maxTries } },
      data: { tries: { increment: 1 } },
    });
  }

  // Uses the code; true for exactly one of any number of concurrent callers.
  async consume(id: string, now: Date, maxTries: number): Promise<boolean> {
    const { count } = await this._emailOtp.model.emailOtp.updateMany({
      where: {
        id,
        consumedAt: null,
        expiresAt: { gt: now },
        tries: { lt: maxTries },
      },
      data: { consumedAt: now },
    });
    return count === 1;
  }

  // The oldest user that has this address under any sign-in provider, or null.
  findOldestUserByEmail(email: string) {
    return this._user.model.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }
}
