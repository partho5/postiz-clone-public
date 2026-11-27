// AI captions (ai.video-captions): reads and writes a workspace's caption jobs, the text written for each of
// their channels, the audio uploads they read and the posts made from the texts.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// How many captions one page of the list holds.
const PAGE_SIZE = 20;

// Whether a write failed because a row with that audio upload already exists.
const isTaken = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// A caption job as `create` stores it (its status starts as PENDING).
export interface NewAiCaption {
  organizationId: string;
  userId?: string;
  audioUploadId: string;
  mode: string;
  title?: string;
  userText?: string;
  integrationIds: string[];
  // whole seconds of speech audio, read from the WAV header
  audioSeconds: number;
}

// What a job changes on its caption.
export interface AiCaptionChanges {
  status?: string;
  error?: string | null;
  // where the credits held for the caption stand (see the AiCaption model)
  creditState?: string;
  transcript?: string | null;
  segments?: Prisma.InputJsonValue;
  language?: string | null;
}

// The text written for one channel, as saved.
export interface NewAiCaptionOutput {
  integrationId: string;
  providerIdentifier: string;
  kind: string;
  title?: string;
  text: string;
  hashtags: string[];
  promptKey: string;
  promptVersion: number;
  promptSource: string;
  model: string;
}

@Injectable()
export class AiCaptionsRepository {
  // Receives the Prisma repositories for the captions, their outputs, the audio uploads they read and the
  // posts made from them.
  constructor(
    private _caption: PrismaRepository<'aiCaption'>,
    private _output: PrismaRepository<'aiCaptionOutput'>,
    private _upload: PrismaRepository<'mobileUpload'>,
    private _post: PrismaRepository<'post'>,
    private _transaction: PrismaTransaction
  ) {}

  // The workspace's upload with this id (the audio object's key and where the upload stands); null when it is
  // not the workspace's.
  audioUpload(organizationId: string, id: string) {
    return this._upload.model.mobileUpload.findFirst({
      where: { id, organizationId },
      select: { id: true, objectKey: true, status: true, purpose: true },
    });
  }

  // The caption made from an audio upload of the workspace, a deleted one included (the upload names one
  // caption for good); null when there is none.
  findByAudioUpload(organizationId: string, audioUploadId: string) {
    return this._caption.model.aiCaption.findFirst({
      where: { organizationId, audioUploadId },
    });
  }

  // Stores a new caption job; null when its audio upload already has one (P2002), i.e. a repeat that raced.
  async createCaption(data: NewAiCaption) {
    try {
      return await this._caption.model.aiCaption.create({ data });
    } catch (err) {
      if (isTaken(err)) {
        return null;
      }
      throw err;
    }
  }

  // A caption by id for the job that works on it (a caption deleted meanwhile is still finished and settled).
  getCaptionById(id: string) {
    return this._caption.model.aiCaption.findFirst({ where: { id } });
  }

  // The workspace's live caption with its outputs; null when it is not the workspace's or is deleted.
  getCaption(organizationId: string, id: string) {
    return this._caption.model.aiCaption.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: { outputs: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
  }

  // Where each of these posts of the workspace stands and when it goes out; a post that is deleted, or is not the
  // workspace's, is not in the answer.
  postStates(organizationId: string, ids: string[]) {
    return this._post.model.post.findMany({
      where: { organizationId, id: { in: ids }, deletedAt: null },
      select: { id: true, state: true, publishDate: true },
    });
  }

  // One page (newest first, 1-based) of the workspace's live captions and how many pages there are.
  async listCaptions(organizationId: string, page: number) {
    const where = { organizationId, deletedAt: null as null };
    const pages = Math.ceil(
      (await this._caption.model.aiCaption.count({ where })) / PAGE_SIZE
    );
    const items = await this._caption.model.aiCaption.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        title: true,
        status: true,
        integrationIds: true,
        // not sent to the page: it tells the service which jobs in progress have stopped moving
        updatedAt: true,
      },
      skip: (Math.max(+page || 1, 1) - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
    return { items, pages };
  }

  // Changes a caption of the workspace.
  updateCaption(organizationId: string, id: string, data: AiCaptionChanges) {
    return this._caption.model.aiCaption.update({
      where: { id, organizationId },
      data,
      select: { id: true, status: true },
    });
  }

  // Keeps the transcript of a live caption of the workspace; false when it was deleted meanwhile (deleting drops
  // the words of the recording, and they must not come back).
  async saveTranscript(
    organizationId: string,
    id: string,
    data: Pick<AiCaptionChanges, 'transcript' | 'segments' | 'language'>
  ) {
    const { count } = await this._caption.model.aiCaption.updateMany({
      where: { id, organizationId, deletedAt: null },
      data,
    });
    return count === 1;
  }

  // Ends a job that is still in progress and has not changed since `before` (its workflow died, or never started).
  // The write is guarded on both, so a job that moved on or ended meanwhile is left alone; true when this call
  // ended it, i.e. the caller alone settles the credits and deletes the audio. `updatedAt` moves with the write.
  async closeStale(
    organizationId: string,
    id: string,
    before: Date,
    data: Pick<AiCaptionChanges, 'status' | 'error' | 'creditState'>
  ) {
    const { count } = await this._caption.model.aiCaption.updateMany({
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

  // Removes a caption that never started (its credits could not be held), so its audio can try again.
  deleteCaption(organizationId: string, id: string) {
    return this._caption.model.aiCaption.deleteMany({
      where: { id, organizationId },
    });
  }

  // Hides a live caption of the workspace and drops what it kept of the recording's words; false when the
  // workspace has no such caption.
  async softDeleteCaption(organizationId: string, id: string) {
    const { count } = await this._caption.model.aiCaption.updateMany({
      where: { id, organizationId, deletedAt: null },
      data: {
        deletedAt: new Date(),
        transcript: null,
        segments: Prisma.DbNull,
        userText: null,
      },
    });
    return count === 1;
  }

  // Replaces the caption's outputs with these in one write, so a retry of the job that wrote them leaves one
  // set and a reader never sees half of one.
  replaceOutputs(captionId: string, outputs: NewAiCaptionOutput[]) {
    return this._transaction.model.$transaction([
      this._output.model.aiCaptionOutput.deleteMany({ where: { captionId } }),
      this._output.model.aiCaptionOutput.createMany({
        data: outputs.map((output) => ({ ...output, captionId })),
      }),
    ]);
  }

  // How many outputs the caption has.
  countOutputs(captionId: string) {
    return this._output.model.aiCaptionOutput.count({ where: { captionId } });
  }

  // Records the post (and its group) made for each channel of a READY caption of the workspace, on the output
  // written for that channel. A caption that is not the workspace's, is deleted or is not READY is left alone.
  async linkOutputs(
    organizationId: string,
    captionId: string,
    posts: Array<{ integrationId: string; postId: string }>
  ) {
    const rows = await this._post.model.post.findMany({
      where: { organizationId, id: { in: posts.map((post) => post.postId) } },
      select: { id: true, group: true },
    });
    return this._transaction.model.$transaction(
      posts.map((post) =>
        this._output.model.aiCaptionOutput.updateMany({
          where: {
            captionId,
            integrationId: post.integrationId,
            caption: { organizationId, deletedAt: null, status: 'READY' },
          },
          data: {
            postId: post.postId,
            postGroup: rows.find((row) => row.id === post.postId)?.group,
          },
        })
      )
    );
  }
}
