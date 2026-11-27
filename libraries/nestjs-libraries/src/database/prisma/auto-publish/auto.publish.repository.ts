// Mobile auto-publish (api.mobile-auto-publish): reads and writes a workspace's preset (its Set, its
// excluded channels and the text channels it switched on), and reads the state of posts by id.
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class AutoPublishRepository {
  // Receives the Prisma repositories for the preset, the Sets it points at and the posts it reads.
  constructor(
    private _preset: PrismaRepository<'autoPublishPreset'>,
    private _sets: PrismaRepository<'sets'>,
    private _post: PrismaRepository<'post'>
  ) {}

  // The workspace's preset row with the Set it points at (set null in automatic mode); null when the
  // workspace has no row.
  getPreset(organizationId: string) {
    return this._preset.model.autoPublishPreset.findUnique({
      where: { organizationId },
      include: { set: true },
    });
  }

  // A Set of the workspace, by id; null when it is not the workspace's.
  getSet(organizationId: string, id: string) {
    return this._sets.model.sets.findFirst({
      where: { id, organizationId },
    });
  }

  // Makes the Set the workspace's preset, replacing the one it had.
  setPreset(organizationId: string, setId: string, timing: string) {
    return this._preset.model.autoPublishPreset.upsert({
      where: { organizationId },
      create: { organizationId, setId, timing },
      update: { setId, timing },
    });
  }

  // Stops using a Set (back to automatic mode); the row and its excluded channels stay. Nothing
  // happens when the workspace has no row.
  clearPreset(organizationId: string) {
    return this._preset.model.autoPublishPreset.updateMany({
      where: { organizationId },
      data: { setId: null, timing: 'now' },
    });
  }

  // The ids of the channels auto-publish skips; [] when the workspace has no row.
  async getExcluded(organizationId: string) {
    const row = await this._preset.model.autoPublishPreset.findUnique({
      where: { organizationId },
      select: { excludedIntegrations: true },
    });
    return row?.excludedIntegrations || [];
  }

  // Adds the channel to (or removes it from) the skipped ones, creating the row with no Set when the
  // workspace has none; a channel is listed once.
  async setExcluded(
    organizationId: string,
    integrationId: string,
    excluded: boolean
  ) {
    const current = await this.getExcluded(organizationId);
    const excludedIntegrations = excluded
      ? [...new Set([...current, integrationId])]
      : current.filter((id) => id !== integrationId);
    return this._preset.model.autoPublishPreset.upsert({
      where: { organizationId },
      create: { organizationId, excludedIntegrations },
      update: { excludedIntegrations },
    });
  }

  // The ids of the text-only channels switched on for a text post from a recording (AI captions); []
  // when the workspace has no row.
  async getTextIntegrations(organizationId: string) {
    const row = await this._preset.model.autoPublishPreset.findUnique({
      where: { organizationId },
      select: { textIntegrations: true },
    });
    return row?.textIntegrations || [];
  }

  // Adds the channel to (or removes it from) the switched-on text channels, creating the row with no
  // Set when the workspace has none; a channel is listed once. Answers the list as it is now.
  async setTextIntegration(
    organizationId: string,
    integrationId: string,
    enabled: boolean
  ) {
    const current = await this.getTextIntegrations(organizationId);
    const textIntegrations = enabled
      ? [...new Set([...current, integrationId])]
      : current.filter((id) => id !== integrationId);
    await this._preset.model.autoPublishPreset.upsert({
      where: { organizationId },
      create: { organizationId, textIntegrations },
      update: { textIntegrations },
    });
    return textIntegrations;
  }

  // The state of the workspace's main posts (not comments) with these ids, deleted ones included.
  postStatuses(organizationId: string, ids: string[]) {
    return this._post.model.post.findMany({
      where: { organizationId, id: { in: ids }, parentPostId: null },
      select: {
        id: true,
        state: true,
        publishDate: true,
        releaseURL: true,
        error: true,
        deletedAt: true,
      },
    });
  }
}
