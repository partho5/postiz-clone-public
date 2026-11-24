// Mobile direct upload (api.mobile-direct-upload): reads and writes a workspace's MobileUpload rows.
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  MOBILE_UPLOAD_PURPOSE_AUDIO,
  MOBILE_UPLOAD_PURPOSE_EDIT_PROXY,
  MobileUploadPurpose,
} from '@gitroom/nestjs-libraries/dtos/mobile-upload/mobile.upload.create.dto';

@Injectable()
export class MobileUploadRepository {
  // Receives the Prisma repositories for the upload rows, the media rows they became, the caption jobs that
  // took a speech audio and the AI edit jobs that took a speech audio or proxy videos.
  constructor(
    private _upload: PrismaRepository<'mobileUpload'>,
    private _media: PrismaRepository<'media'>,
    private _aiCaption: PrismaRepository<'aiCaption'>,
    private _aiVideoEdit: PrismaRepository<'aiVideoEdit'>
  ) {}

  // Stores a new pending upload; `size` is a plain number here and a BigInt in the table.
  create(data: {
    organizationId: string;
    objectKey: string;
    uploadId: string;
    filename: string;
    size: number;
    partSize: number;
    partCount: number;
    expiresAt: Date;
    purpose: MobileUploadPurpose;
  }) {
    return this._upload.model.mobileUpload.create({
      data: { ...data, size: BigInt(data.size) },
    });
  }

  // An upload of the workspace, by id; null when it is not the workspace's.
  findByIdAndOrg(organizationId: string, id: string) {
    return this._upload.model.mobileUpload.findFirst({
      where: { id, organizationId },
    });
  }

  // How many uploads of the workspace made for the purpose are still pending (media and caption audio
  // are counted apart).
  countPendingByOrg(organizationId: string, purpose: MobileUploadPurpose) {
    return this._upload.model.mobileUpload.count({
      where: { organizationId, status: 'pending', purpose },
    });
  }

  // Moves an upload of the workspace from one status to another in one statement, so only one of
  // two simultaneous callers wins; true when this call made the move.
  async transitionStatus(
    organizationId: string,
    id: string,
    from: string,
    to: string
  ) {
    const { count } = await this._upload.model.mobileUpload.updateMany({
      where: { id, organizationId, status: from },
      data: { status: to },
    });
    return count === 1;
  }

  // Ends a claimed upload as completed and stores the media it became (a caption audio becomes none).
  async markCompleted(organizationId: string, id: string, mediaId?: string) {
    const { count } = await this._upload.model.mobileUpload.updateMany({
      where: { id, organizationId, status: 'completing' },
      data: { status: 'completed', mediaId },
    });
    return count === 1;
  }

  // The uploads the sweep may close, oldest first, at most `take`, across every workspace.
  findStale(now: Date, completingBefore: Date, take: number) {
    return this._upload.model.mobileUpload.findMany({
      where: this.staleWhere(now, completingBefore),
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  // Moves a stale upload to expired in one statement, so a complete or abort that got there first
  // wins; true when this call made the move.
  async expireStale(id: string, now: Date, completingBefore: Date) {
    const { count } = await this._upload.model.mobileUpload.updateMany({
      where: { id, ...this.staleWhere(now, completingBefore) },
      data: { status: 'expired' },
    });
    return count === 1;
  }

  // The completed work file uploads (caption audio, edit proxy) untouched since `before`, oldest first, at most
  // `take`, across every workspace.
  findOldAudio(before: Date, take: number) {
    return this._upload.model.mobileUpload.findMany({
      where: this.oldAudioWhere(before),
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  // Moves an old work file upload to expired in one statement, so a call that moved it first wins;
  // true when this call made the move.
  async expireAudio(id: string, before: Date) {
    const { count } = await this._upload.model.mobileUpload.updateMany({
      where: { id, ...this.oldAudioWhere(before) },
      data: { status: 'expired' },
    });
    return count === 1;
  }

  // True when a caption job or an AI edit job names the work file upload (as its audio or one of its proxies),
  // so that job owns its object and deletes it.
  async hasCaption(uploadId: string) {
    const captions = await this._aiCaption.model.aiCaption.count({
      where: { audioUploadId: uploadId },
    });
    if (captions > 0) {
      return true;
    }
    const edits = await this._aiVideoEdit.model.aiVideoEdit.count({
      where: {
        OR: [
          { audioUploadId: uploadId },
          { proxyUploadIds: { has: uploadId } },
        ],
      },
    });
    return edits > 0;
  }

  // True when the workspace has a media row for the object, so its file is in use.
  async hasMedia(organizationId: string, objectKey: string) {
    const count = await this._media.model.media.count({
      where: { organizationId, name: objectKey },
    });
    return count > 0;
  }

  // Completed work file uploads (caption audio, edit proxy) untouched since `before`.
  private oldAudioWhere(before: Date) {
    return {
      purpose: {
        in: [MOBILE_UPLOAD_PURPOSE_AUDIO, MOBILE_UPLOAD_PURPOSE_EDIT_PROXY],
      },
      status: 'completed',
      updatedAt: { lte: before },
    };
  }

  // Pending uploads past their expiry, and completing ones untouched since `completingBefore` (a
  // complete that died after claiming the row); completed uploads never match.
  private staleWhere(now: Date, completingBefore: Date) {
    return {
      OR: [
        { status: 'pending', expiresAt: { lte: now } },
        { status: 'completing', updatedAt: { lte: completingBefore } },
      ],
    };
  }
}
