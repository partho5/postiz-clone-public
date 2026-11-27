// Prompt Book (ai.video-captions): the instructions every AI caption is written from. The owner keeps a
// default per prompt (versioned, with the model it runs on); a workspace may save its own text for an
// editable prompt, also versioned. The text used is read fresh for every job, never cached: the
// workspace's own text, else the default of the key, else the default of its family.
import { HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PromptBookRepository } from '@gitroom/nestjs-libraries/database/prisma/prompt-book/prompt.book.repository';
import {
  PROMPT_BOOK_DEFAULTS,
  PROMPT_BOOK_MODEL,
  PROMPT_BOOK_SETTINGS,
  PromptDefaultEntry,
  PromptGroup,
  PromptSettings,
} from '@gitroom/nestjs-libraries/database/prisma/prompt-book/prompt.book.defaults';
import {
  PROMPT_BODY_MAX_LENGTH,
  PROMPT_DEFAULT_MAX_LENGTH,
} from '@gitroom/nestjs-libraries/dtos/prompt-book/save.prompt.dto';

// The text a job runs with for one key, and where it came from.
export interface ResolvedPrompt {
  // The key whose text this is: the asked key, or the default of its family.
  key: string;
  body: string;
  version: number;
  source: 'default' | 'workspace';
  model: string;
  settings: Required<PromptSettings>;
}

// A prompt as a workspace sees it: its own text when it saved one, else the default's.
export interface PromptBookItem {
  key: string;
  label: string;
  group: PromptGroup;
  provider?: string;
  body: string;
  isDefault: boolean;
  // The version of the workspace's own text; none while the default is shown.
  version?: number;
}

// A default as the owner sees it.
export interface PromptDefaultView {
  key: string;
  label: string;
  group: PromptGroup;
  provider?: string;
  locked: boolean;
  body: string;
  model: string;
  reasoningEffort: string;
  version: number;
  note: string | null;
  createdAt: string;
}

// One stored version of a default.
export interface PromptVersionView {
  version: number;
  body: string;
  model: string;
  reasoningEffort: string;
  note: string | null;
  createdById: string | null;
  createdAt: string;
}

// How often a version number taken by a concurrent writer is drawn again before giving up.
const VERSION_ATTEMPTS = 5;

// Refusal of a key the caller may not use: unknown, or locked to the owner.
class PromptKeyInvalidException extends HttpException {
  // Answers 400 PROMPT_KEY_INVALID with the reason.
  constructor(message: string) {
    super({ statusCode: 400, code: 'PROMPT_KEY_INVALID', message }, 400);
  }
}

// Refusal of a text that is empty or too long.
class PromptBodyInvalidException extends HttpException {
  // Answers 400 PROMPT_BODY_INVALID with the reason.
  constructor(message: string) {
    super({ statusCode: 400, code: 'PROMPT_BODY_INVALID', message }, 400);
  }
}

// No text exists for the key, nor for its family.
class PromptNotFoundException extends HttpException {
  // Answers 404 PROMPT_NOT_FOUND.
  constructor() {
    super({ statusCode: 404, code: 'PROMPT_NOT_FOUND' }, 404);
  }
}

// The default of a key's family (`captions.video.tumblr` -> `captions.video.default`); null for a key
// that is already a `default` or has no family.
const familyDefault = (key: string) => {
  const dot = key.lastIndexOf('.');
  if (dot < 0) {
    return null;
  }
  const fallback = `${key.slice(0, dot)}.default`;
  return fallback === key ? null : fallback;
};

// The settings of a stored row, over the starting ones.
const settingsOf = (
  value: Prisma.JsonValue | null | undefined
): Required<PromptSettings> => {
  const stored =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as PromptSettings)
      : {};
  return {
    ...PROMPT_BOOK_SETTINGS,
    ...(stored.reasoningEffort
      ? { reasoningEffort: stored.reasoningEffort }
      : {}),
  };
};

// The Prompt Book: resolving, listing, saving and resetting prompts, and the owner's defaults.
@Injectable()
export class PromptBookService implements OnModuleInit {
  private readonly _logger = new Logger(PromptBookService.name);

  // Receives the repository that stores the prompts.
  constructor(private _promptBookRepository: PromptBookRepository) {}

  // Adds the defaults file's new keys at start-up and logs which, if any.
  async onModuleInit() {
    const created = await this.seed();
    if (created.length) {
      this._logger.log(`Prompt Book seeded: ${created.join(', ')}`);
    }
  }

  // Stores the first version of every key of the defaults file that has no default yet; a key that has
  // one is never touched, so an owner's edit survives. Returns the keys added.
  async seed(): Promise<string[]> {
    const stored = new Set(await this._promptBookRepository.defaultKeys());
    const created: string[] = [];
    for (const entry of PROMPT_BOOK_DEFAULTS) {
      if (stored.has(entry.key)) {
        continue;
      }
      // null: another process added it first
      const row = await this._promptBookRepository.createDefault({
        key: entry.key,
        version: 1,
        body: entry.body,
        model: PROMPT_BOOK_MODEL,
        settings: { ...PROMPT_BOOK_SETTINGS },
        note: 'From the defaults file',
        createdById: null,
      });
      if (row) {
        created.push(entry.key);
      }
    }
    return created;
  }

  // The text, version, source and model a job runs with for a key in a workspace: the workspace's own
  // text, else the default of the key, else the same for the default of the key's family.
  async resolve(orgId: string, key: string): Promise<ResolvedPrompt> {
    for (
      let current: string | null = key;
      current;
      current = familyDefault(current)
    ) {
      const resolved = await this.resolveOwn(orgId, current);
      if (resolved) {
        return resolved;
      }
    }
    throw new PromptNotFoundException();
  }

  // Every editable prompt of the book as the workspace sees it: its own text, else the default's.
  async list(orgId: string): Promise<PromptBookItem[]> {
    const entries = PROMPT_BOOK_DEFAULTS.filter((entry) => !entry.locked);
    const keys = entries.map((entry) => entry.key);
    const [defaults, overrides] = await Promise.all([
      this._promptBookRepository.latestDefaults(keys),
      this._promptBookRepository.latestOverrides(orgId, keys),
    ]);
    const defaultByKey = new Map(defaults.map((row) => [row.key, row] as const));
    const overrideByKey = new Map(overrides.map((row) => [row.key, row] as const));
    return entries.flatMap((entry) => {
      const stored = defaultByKey.get(entry.key);
      const override = overrideByKey.get(entry.key);
      if (!stored) {
        return [];
      }
      return [
        this.item(
          entry,
          override ? override.body : stored.body,
          override?.version
        ),
      ];
    });
  }

  // Saves the workspace's own text for an editable key as its next version.
  async save(
    orgId: string,
    key: string,
    body: string,
    userId?: string
  ): Promise<PromptBookItem> {
    const entry = this.editableEntry(key);
    const text = this.checkedBody(body, PROMPT_BODY_MAX_LENGTH);
    for (let attempt = 0; attempt < VERSION_ATTEMPTS; attempt += 1) {
      const last = await this._promptBookRepository.latestOverride(orgId, key);
      const version = (last?.version ?? 0) + 1;
      const row = await this._promptBookRepository.createOverride({
        organizationId: orgId,
        key,
        version,
        body: text,
        createdById: userId ?? null,
      });
      if (row) {
        return this.item(entry, row.body, row.version);
      }
    }
    throw new Error(`Prompt Book could not settle a version of ${key}`);
  }

  // Removes the workspace's own text for an editable key, so it reads the default again.
  async reset(orgId: string, key: string): Promise<PromptBookItem> {
    const entry = this.editableEntry(key);
    await this._promptBookRepository.deleteOverrides(orgId, key);
    const stored = await this._promptBookRepository.latestDefault(key);
    if (!stored) {
      throw new PromptNotFoundException();
    }
    return this.item(entry, stored.body);
  }

  // Every prompt of the book, locked frames included, with its current default.
  async listDefaults(): Promise<PromptDefaultView[]> {
    const keys = PROMPT_BOOK_DEFAULTS.map((entry) => entry.key);
    const defaults = await this._promptBookRepository.latestDefaults(keys);
    const defaultByKey = new Map(defaults.map((row) => [row.key, row] as const));
    return PROMPT_BOOK_DEFAULTS.flatMap((entry) => {
      const stored = defaultByKey.get(entry.key);
      return stored ? [this.defaultView(entry, stored)] : [];
    });
  }

  // Saves a new version of a default; a model or reasoning effort left out stays as it was.
  async saveDefault(
    userId: string,
    input: {
      key: string;
      body: string;
      model?: string;
      reasoningEffort?: PromptSettings['reasoningEffort'];
      note?: string;
    }
  ): Promise<PromptDefaultView> {
    const entry = this.knownEntry(input.key);
    const text = this.checkedBody(input.body, PROMPT_DEFAULT_MAX_LENGTH);
    return this.storeDefault(
      entry,
      userId,
      text,
      input.model?.trim() || undefined,
      input.reasoningEffort,
      input.note?.trim() || null
    );
  }

  // Every stored version of a default, newest first.
  async history(key: string): Promise<PromptVersionView[]> {
    this.knownEntry(key);
    const rows = await this._promptBookRepository.defaultHistory(key);
    return rows.map((row) => ({
      version: row.version,
      body: row.body,
      model: row.model ?? PROMPT_BOOK_MODEL,
      reasoningEffort: settingsOf(row.settings).reasoningEffort,
      note: row.note,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // Brings an earlier version of a default back as a new version, so the history keeps every step.
  async restore(
    userId: string,
    key: string,
    version: number
  ): Promise<PromptDefaultView> {
    const entry = this.knownEntry(key);
    const target = await this._promptBookRepository.defaultVersion(key, version);
    if (!target) {
      throw new PromptNotFoundException();
    }
    return this.storeDefault(
      entry,
      userId,
      target.body,
      target.model ?? undefined,
      settingsOf(target.settings).reasoningEffort,
      `Restored from version ${version}`
    );
  }

  // Stores the next version of a default; model and reasoning effort not given stay as the current ones.
  private async storeDefault(
    entry: PromptDefaultEntry,
    userId: string,
    body: string,
    model: string | undefined,
    reasoningEffort: PromptSettings['reasoningEffort'],
    note: string | null
  ): Promise<PromptDefaultView> {
    for (let attempt = 0; attempt < VERSION_ATTEMPTS; attempt += 1) {
      const last = await this._promptBookRepository.latestDefault(entry.key);
      const row = await this._promptBookRepository.createDefault({
        key: entry.key,
        version: (last?.version ?? 0) + 1,
        body,
        model: model ?? last?.model ?? PROMPT_BOOK_MODEL,
        settings: {
          ...settingsOf(last?.settings),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
        note,
        createdById: userId,
      });
      if (row) {
        return this.defaultView(entry, row);
      }
    }
    throw new Error(`Prompt Book could not settle a version of ${entry.key}`);
  }

  // The text for exactly this key: the workspace's own, else the default; null when neither exists.
  // A locked key never reads a workspace text.
  private async resolveOwn(
    orgId: string,
    key: string
  ): Promise<ResolvedPrompt | null> {
    const locked = !!PROMPT_BOOK_DEFAULTS.find((entry) => entry.key === key)
      ?.locked;
    const [stored, override] = await Promise.all([
      this._promptBookRepository.latestDefault(key),
      locked
        ? Promise.resolve(null)
        : this._promptBookRepository.latestOverride(orgId, key),
    ]);
    if (!stored && !override) {
      return null;
    }
    return {
      key,
      body: override ? override.body : stored!.body,
      version: override ? override.version : stored!.version,
      source: override ? 'workspace' : 'default',
      model: stored?.model ?? PROMPT_BOOK_MODEL,
      settings: settingsOf(stored?.settings),
    };
  }

  // The key's entry in the defaults file; refused when the key is not in the book.
  private knownEntry(key: string) {
    const entry = PROMPT_BOOK_DEFAULTS.find((candidate) => candidate.key === key);
    if (!entry) {
      throw new PromptKeyInvalidException(`Unknown prompt ${key}`);
    }
    return entry;
  }

  // The key's entry when a workspace may edit it; refused when the key is unknown or locked.
  private editableEntry(key: string) {
    const entry = this.knownEntry(key);
    if (entry.locked) {
      throw new PromptKeyInvalidException(`Prompt ${key} is locked`);
    }
    return entry;
  }

  // The text without outer blanks; refused when empty or longer than the limit.
  private checkedBody(body: string, maxLength: number) {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) {
      throw new PromptBodyInvalidException('The prompt text is required');
    }
    if (text.length > maxLength) {
      throw new PromptBodyInvalidException(
        `The prompt text is longer than ${maxLength} characters`
      );
    }
    return text;
  }

  // A prompt as a workspace sees it.
  private item(
    entry: PromptDefaultEntry,
    body: string,
    version?: number
  ): PromptBookItem {
    return {
      key: entry.key,
      label: entry.label,
      group: entry.group,
      ...(entry.provider ? { provider: entry.provider } : {}),
      body,
      isDefault: version === undefined,
      ...(version === undefined ? {} : { version }),
    };
  }

  // A default as the owner sees it.
  private defaultView(
    entry: PromptDefaultEntry,
    row: {
      body: string;
      model: string | null;
      settings: Prisma.JsonValue | null;
      version: number;
      note: string | null;
      createdAt: Date;
    }
  ): PromptDefaultView {
    return {
      key: entry.key,
      label: entry.label,
      group: entry.group,
      ...(entry.provider ? { provider: entry.provider } : {}),
      locked: !!entry.locked,
      body: row.body,
      model: row.model ?? PROMPT_BOOK_MODEL,
      reasoningEffort: settingsOf(row.settings).reasoningEffort,
      version: row.version,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
