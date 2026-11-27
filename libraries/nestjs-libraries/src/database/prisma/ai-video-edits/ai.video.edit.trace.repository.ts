// AI video editing (ai.video-editing), tracing: appends and reads the `AiVideoEditTrace` rows of an edit job.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// How many times an append tries again when another writer took its `seq` first.
const SEQ_TRIES = 5;

// How many rows one read answers at most.
const READ_LIMIT = 5000;

// Whether a write failed because the `seq` is already taken.
const isTaken = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// A row as the service hands it over; the repository adds `seq`.
export interface NewAiVideoEditTrace {
  editId: string;
  organizationId: string;
  step: string;
  kind: string;
  attempt?: number;
  durationMs?: number;
  ok?: boolean;
  payload: Prisma.InputJsonValue;
  payloadBytes: number;
  payloadSha256: string;
}

// Which rows a read answers.
export interface AiVideoEditTraceFilter {
  step?: string;
  kind?: string;
}

@Injectable()
export class AiVideoEditTraceRepository {
  // Receives the Prisma repositories of the trace rows and of the edit jobs they belong to.
  constructor(
    private _trace: PrismaRepository<'aiVideoEditTrace'>,
    private _edit: PrismaRepository<'aiVideoEdit'>
  ) {}

  // The workspace an edit belongs to; null when there is no such edit.
  async organizationOf(editId: string) {
    const edit = await this._edit.model.aiVideoEdit.findUnique({
      where: { id: editId },
      select: { organizationId: true },
    });
    return edit?.organizationId ?? null;
  }

  // Appends a row with the next `seq` of its edit. `seq` is unique with the edit, so a writer that lost the race reads
  // the new last number and tries again; throws when every try lost or the write failed otherwise.
  async append(row: NewAiVideoEditTrace) {
    for (let tries = 0; tries < SEQ_TRIES; tries++) {
      const last = await this._trace.model.aiVideoEditTrace.findFirst({
        where: { editId: row.editId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      try {
        return await this._trace.model.aiVideoEditTrace.create({
          data: { ...row, seq: (last?.seq ?? 0) + 1 },
        });
      } catch (err) {
        if (!isTaken(err)) {
          throw err;
        }
      }
    }
    throw new Error('trace seq taken');
  }

  // The rows of the workspace's edit in `seq` order, narrowed by step and kind; empty when the edit is not the
  // workspace's.
  list(organizationId: string, editId: string, filter: AiVideoEditTraceFilter = {}) {
    return this._trace.model.aiVideoEditTrace.findMany({
      where: {
        editId,
        organizationId,
        ...(filter.step ? { step: filter.step } : {}),
        ...(filter.kind ? { kind: filter.kind } : {}),
      },
      orderBy: { seq: 'asc' },
      take: READ_LIMIT,
    });
  }

  // Deletes the rows made before the cutoff; answers how many went.
  async deleteCreatedBefore(cutoff: Date) {
    const { count } = await this._trace.model.aiVideoEditTrace.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }
}
