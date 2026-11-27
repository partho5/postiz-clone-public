// Idempotency-Key: storing the keys claimed by mutations and the answers kept for a retry.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface IdempotencyScope {
  principal: string;
  workspaceId: string;
  key: string;
}

export interface StoredAnswer {
  statusCode: number;
  // null when the answer was streamed and cannot be replayed
  body: Buffer | null;
  contentType: string | null;
}

@Injectable()
export class IdempotencyRepository {
  constructor(
    private _idempotencyRecord: PrismaRepository<'idempotencyRecord'>
  ) {}

  // Claims the scope for a running handler; false when a record already holds it (P2002).
  async claim(
    scope: IdempotencyScope,
    fingerprint: string,
    expiresAt: Date
  ): Promise<boolean> {
    try {
      await this._idempotencyRecord.model.idempotencyRecord.create({
        data: { ...scope, fingerprint, state: 'RUNNING', expiresAt },
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

  // The record holding the scope, or null.
  find(scope: IdempotencyScope) {
    return this._idempotencyRecord.model.idempotencyRecord.findUnique({
      where: { principal_workspaceId_key: scope },
    });
  }

  // Frees the scope when its record expired before `now`; false when nothing expired was there.
  async deleteIfExpired(scope: IdempotencyScope, now: Date): Promise<boolean> {
    const { count } =
      await this._idempotencyRecord.model.idempotencyRecord.deleteMany({
        where: { ...scope, expiresAt: { lte: now } },
      });
    return count > 0;
  }

  // Turns the running record into the stored answer; false when it is no longer this request's.
  async complete(
    scope: IdempotencyScope,
    fingerprint: string,
    answer: StoredAnswer,
    expiresAt: Date
  ): Promise<boolean> {
    const { count } =
      await this._idempotencyRecord.model.idempotencyRecord.updateMany({
        where: { ...scope, fingerprint, state: 'RUNNING' },
        data: {
          state: 'DONE',
          statusCode: answer.statusCode,
          responseBody: answer.body,
          responseHeaders: answer.contentType
            ? { 'content-type': answer.contentType }
            : Prisma.DbNull,
          expiresAt,
        },
      });
    return count > 0;
  }

  // Drops the running record of this request so a retry runs the handler again.
  async release(scope: IdempotencyScope, fingerprint: string) {
    await this._idempotencyRecord.model.idempotencyRecord.deleteMany({
      where: { ...scope, fingerprint, state: 'RUNNING' },
    });
  }

  // Deletes every record that expired before `now`; how many went.
  async deleteExpired(now: Date): Promise<number> {
    const { count } =
      await this._idempotencyRecord.model.idempotencyRecord.deleteMany({
        where: { expiresAt: { lte: now } },
      });
    return count;
  }
}
