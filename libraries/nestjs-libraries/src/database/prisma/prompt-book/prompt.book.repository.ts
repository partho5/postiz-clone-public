// Prompt Book (ai.video-captions): reading and writing the `PromptDefault` and `PromptOverride` rows.
// Every override read and write names its workspace, so one workspace never reaches another's text.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface NewPromptDefault {
  key: string;
  version: number;
  body: string;
  model: string;
  settings: Prisma.InputJsonObject;
  note: string | null;
  createdById: string | null;
}

export interface NewPromptOverride {
  organizationId: string;
  key: string;
  version: number;
  body: string;
  createdById: string | null;
}

// Whether a write failed because a row with that key and version already exists.
const isTaken = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// Reads and writes the versioned prompt rows.
@Injectable()
export class PromptBookRepository {
  // Receives the Prisma repositories for `promptDefault` and `promptOverride`.
  constructor(
    private _promptDefault: PrismaRepository<'promptDefault'>,
    private _promptOverride: PrismaRepository<'promptOverride'>
  ) {}

  // Every key that has a default stored.
  async defaultKeys() {
    const rows = await this._promptDefault.model.promptDefault.findMany({
      select: { key: true },
      distinct: ['key'],
    });
    return rows.map((row) => row.key);
  }

  // The newest default of a key, or null.
  latestDefault(key: string) {
    return this._promptDefault.model.promptDefault.findFirst({
      where: { key },
      orderBy: { version: 'desc' },
    });
  }

  // The newest default of each of the keys that has one.
  latestDefaults(keys: string[]) {
    return this._promptDefault.model.promptDefault.findMany({
      where: { key: { in: keys } },
      orderBy: { version: 'desc' },
      distinct: ['key'],
    });
  }

  // One stored version of a default, or null.
  defaultVersion(key: string, version: number) {
    return this._promptDefault.model.promptDefault.findUnique({
      where: { key_version: { key, version } },
    });
  }

  // Every stored version of a default, newest first.
  defaultHistory(key: string) {
    return this._promptDefault.model.promptDefault.findMany({
      where: { key },
      orderBy: { version: 'desc' },
    });
  }

  // Stores a default version; null when that version of the key already exists (P2002).
  async createDefault(data: NewPromptDefault) {
    try {
      return await this._promptDefault.model.promptDefault.create({ data });
    } catch (err) {
      if (isTaken(err)) {
        return null;
      }
      throw err;
    }
  }

  // The newest text a workspace saved for a key, or null.
  latestOverride(organizationId: string, key: string) {
    return this._promptOverride.model.promptOverride.findFirst({
      where: { organizationId, key },
      orderBy: { version: 'desc' },
    });
  }

  // The newest text a workspace saved for each of the keys it has edited.
  latestOverrides(organizationId: string, keys: string[]) {
    return this._promptOverride.model.promptOverride.findMany({
      where: { organizationId, key: { in: keys } },
      orderBy: { version: 'desc' },
      distinct: ['key'],
    });
  }

  // Stores a workspace's version of a prompt; null when that version already exists (P2002).
  async createOverride(data: NewPromptOverride) {
    try {
      return await this._promptOverride.model.promptOverride.create({ data });
    } catch (err) {
      if (isTaken(err)) {
        return null;
      }
      throw err;
    }
  }

  // Removes every text a workspace saved for a key, so the key reads the default again.
  deleteOverrides(organizationId: string, key: string) {
    return this._promptOverride.model.promptOverride.deleteMany({
      where: { organizationId, key },
    });
  }
}
