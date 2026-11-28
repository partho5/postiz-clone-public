// AI video editing (ai.video-editing): reads and writes a workspace's AI edit jobs, and the uploads and captions
// they read their words and proxies from.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// Whether a write failed because the workspace already has a job for that recording and level.
const isTaken = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// An edit job as `create` stores it (its status starts as PENDING).
export interface NewAiVideoEdit {
  organizationId: string;
  userId?: string;
  sessionId: string;
  level: string;
  aiCaptionId?: string;
  audioUploadId?: string;
  proxyUploadIds: string[];
  request: Prisma.InputJsonValue;
  // whole seconds of the recording, rounded up: what the credits were held for
  sourceSeconds: number;
  // the credits held
  cost: number;
}

// What a job changes on its edit.
export interface AiVideoEditChanges {
  status?: string;
  error?: string | null;
  words?: Prisma.InputJsonValue;
  scores?: Prisma.InputJsonValue;
  texts?: Prisma.InputJsonValue;
  moments?: Prisma.InputJsonValue;
  plan?: Prisma.InputJsonValue;
  assets?: Prisma.InputJsonValue;
  delivered?: Prisma.InputJsonValue;
  log?: Prisma.InputJsonValue;
  language?: string | null;
}

@Injectable()
export class AiVideoEditsRepository {
  // Receives the Prisma repositories for the edit jobs, the uploads they read and the captions they reuse.
  constructor(
    private _edit: PrismaRepository<'aiVideoEdit'>,
    private _upload: PrismaRepository<'mobileUpload'>,
    private _caption: PrismaRepository<'aiCaption'>
  ) {}

  // The workspace's upload with this id (its object key, where it stands and what it is for); null when it is
  // not the workspace's.
  upload(organizationId: string, id: string) {
    return this._upload.model.mobileUpload.findFirst({
      where: { id, organizationId },
      select: { id: true, objectKey: true, status: true, purpose: true },
    });
  }

  // The workspace's live caption with this id, as far as an edit reads it; null when it is not the workspace's or
  // is deleted.
  caption(organizationId: string, id: string) {
    return this._caption.model.aiCaption.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: {
        id: true,
        status: true,
        audioSeconds: true,
        segments: true,
        language: true,
      },
    });
  }

  // The workspace's edit of a recording at a level, a deleted one included (the three name one job for good);
  // null when there is none.
  findBySession(organizationId: string, sessionId: string, level: string) {
    return this._edit.model.aiVideoEdit.findFirst({
      where: { organizationId, sessionId, level },
    });
  }

  // Stores a new edit job; null when the recording already has one at that level (P2002), i.e. a repeat that raced.
  async createEdit(data: NewAiVideoEdit) {
    try {
      return await this._edit.model.aiVideoEdit.create({ data });
    } catch (err) {
      if (isTaken(err)) {
        return null;
      }
      throw err;
    }
  }

  // An edit by id for the job that works on it (an edit deleted meanwhile is still finished and settled).
  getEditById(id: string) {
    return this._edit.model.aiVideoEdit.findFirst({ where: { id } });
  }

  // The workspace's live edit; null when it is not the workspace's or is deleted.
  getEdit(organizationId: string, id: string) {
    return this._edit.model.aiVideoEdit.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
  }

  // Changes an edit of the workspace.
  updateEdit(organizationId: string, id: string, data: AiVideoEditChanges) {
    return this._edit.model.aiVideoEdit.update({
      where: { id, organizationId },
      data,
      select: { id: true, status: true },
    });
  }

  // Keeps the words of a live edit of the workspace; false when it was deleted meanwhile (the words of a deleted
  // recording must not come back).
  async saveWords(
    organizationId: string,
    id: string,
    data: Pick<AiVideoEditChanges, 'words' | 'language'>
  ) {
    const { count } = await this._edit.model.aiVideoEdit.updateMany({
      where: { id, organizationId, deletedAt: null },
      data,
    });
    return count === 1;
  }

  // Ends a job that is still in progress and has not changed since `before` (its workflow died, or never started).
  // The write is guarded on both, so a job that moved on or ended meanwhile is left alone; true when this call
  // ended it, i.e. the caller alone settles the credits and deletes the uploads. `updatedAt` moves with the write.
  async closeStale(
    organizationId: string,
    id: string,
    before: Date,
    data: Pick<AiVideoEditChanges, 'status' | 'error'>
  ) {
    const { count } = await this._edit.model.aiVideoEdit.updateMany({
      where: {
        id,
        organizationId,
        // the three final statuses of the service
        status: { notIn: ['READY', 'NO_SPEECH', 'FAILED'] },
        updatedAt: { lt: before },
      },
      data,
    });
    return count === 1;
  }

  // Removes an edit that never started (its credits could not be held), so the recording can ask again.
  deleteEdit(organizationId: string, id: string) {
    return this._edit.model.aiVideoEdit.deleteMany({
      where: { id, organizationId },
    });
  }
}
