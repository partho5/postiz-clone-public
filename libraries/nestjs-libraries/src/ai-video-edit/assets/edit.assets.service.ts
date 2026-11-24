// AI video editing (ai.video-editing), assets (spec section 15): the resolver `planEdit` uses. A slot's query becomes an
// icon or mp4 clip file in our own storage: the shared cache first (by provider id, for every workspace), else a search
// of the stock catalogue, one model call that picks the best item by its name for all the slots, a download and a store
// in R2. A slot whose asset cannot be had is dropped (the plan simply has no icon there). Sounds are served from
// AI_EDIT_SOUNDS_BASE_URL. Nothing here logs a query: only kinds of failure.
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mediaUrl } from '@gitroom/helpers/utils/media.base.url';
import { EditLevel, LEVEL_RULES, PlanAsset } from '@gitroom/nestjs-libraries/ai-video-edit/contract/edit.contract';
import { IconChoice } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.assembler';
import type { AssetProbe } from '@gitroom/nestjs-libraries/ai-video-edit/core/edit.clientcheck';
import { IconPickSlot, iconPickMessages } from '@gitroom/nestjs-libraries/ai-video-edit/edit.icon.prompt';
import { EditLlmService } from '@gitroom/nestjs-libraries/ai-video-edit/edit.llm.service';
import { iconEditLlm } from '@gitroom/nestjs-libraries/ai-video-edit/edit.llm';
import { LlmUsage } from '@gitroom/nestjs-libraries/ai-video-edit/llm.usage';
import {
  AiEditAssetRow,
  AiEditAssetsRepository,
} from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.edit.assets.repository';
import { R2, R2_BUCKET } from '@gitroom/nestjs-libraries/upload/r2.uploader';
import { FileInfo, assetKey, assetRetentionDays, mp4Info, pngInfo, soundAssets } from './edit.asset.files';
import { AssetKind, IconscoutClient, IconscoutHit } from './iconscout.client';

// The provider the cache rows name.
const PROVIDER = 'iconscout';

// The queries answered lately, to the provider id they ended in (per process; the rows are the shared cache): a repeat
// of a query makes no IconScout call at all. Bounded, the oldest forgotten first.
const MAX_REMEMBERED = 500;

// How many files one purge run reads at a time, and how many reads at most (a backlog goes over a few days).
const PURGE_BATCH = 100;
const PURGE_MAX_BATCHES = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

// The longest a HEAD check waits for one file's server: a slow one is reported, never waited for.
const PROBE_TIMEOUT_MS = 3000;

// The kind of file each asset kind must be served as (the family of its content type).
const CONTENT_FAMILY: Record<PlanAsset['kind'], string> = { video: 'video/', icon: 'image/', sound: 'audio/' };

// What the resolver gives the planner: the icon per slot id, the sound ids the plan may use and every entry the plan
// may name (the plan keeps those it uses).
export interface ResolvedAssets {
  icons: Record<string, IconChoice>;
  sounds: string[];
  planAssets: PlanAsset[];
}

// What became of one slot's query, for the trace: where its file came from (`remembered` a query answered lately,
// `cache_hit` the shared cache by provider id, `stored` freshly downloaded) or why it has none (`no_candidates`: the
// search found nothing, `not_picked`: the model named none of the candidates, `unusable`: the download failed or the
// file was not what it should be).
export interface AssetReport {
  slot_id: string;
  query: string;
  outcome_code: 'remembered' | 'cache_hit' | 'stored' | 'no_candidates' | 'not_picked' | 'unusable';
  candidates: number;
  provider_id?: string;
  asset_id?: string;
  object_key?: string;
}

@Injectable()
export class EditAssetsService {
  private readonly _logger = new Logger(EditAssetsService.name);
  private readonly _remembered = new Map<string, string>();

  // Receives the cache of downloaded files, the IconScout client and the decision calls (the model that picks).
  constructor(
    private _assets: AiEditAssetsRepository,
    private _iconscout: IconscoutClient,
    private _editLlm: EditLlmService
  ) {}

  // Whether the level picks icons and IconScout is set up for them: the picker runs only then.
  iconsWanted(level: EditLevel) {
    return LEVEL_RULES[level].max_icons > 0 && this._iconscout.isConfigured();
  }

  // The assets of an edit: the sounds when the level and the user allow them and the server has a base url for them,
  // and an icon or mp4 clip per query (a slot id to its search words; `texts` are the on-screen texts per slot id,
  // which help the pick). Never throws: whatever cannot be had is left out. `report`, when given, is filled with what
  // became of each query (for the trace), and `usage` with what the model call that picks used (for the ledger); the
  // answer is the same with or without them.
  async resolve(
    input: {
      level: EditLevel;
      soundEffects?: boolean;
      queries: Record<string, string>;
      texts?: Record<string, string>;
    },
    report?: AssetReport[],
    usage?: LlmUsage[]
  ): Promise<ResolvedAssets> {
    const sounds =
      LEVEL_RULES[input.level].sounds && input.soundEffects !== false
        ? soundAssets(process.env.AI_EDIT_SOUNDS_BASE_URL)
        : [];
    const icons: Record<string, IconChoice> = {};
    const planAssets: PlanAsset[] = [...sounds];
    const entries = this.iconsWanted(input.level) ? Object.entries(input.queries) : [];
    const found = await this.filesFor(entries, input.texts || {}, report, usage);
    for (const [slotId, row] of found) {
      const video = row.kind === 'video';
      icons[slotId] = {
        asset_id: row.id,
        kind: video ? 'icon_video' : 'icon_image',
        ...(row.nativeDurationMs ? { native_duration_ms: row.nativeDurationMs } : {}),
      };
      if (!planAssets.some((a) => a.id === row.id)) {
        planAssets.push({
          id: row.id,
          kind: video ? 'video' : 'icon',
          url: mediaUrl(row.objectKey),
          ...(row.nativeDurationMs ? { native_duration_ms: row.nativeDurationMs } : {}),
          ...(row.width ? { width: row.width } : {}),
          ...(row.height ? { height: row.height } : {}),
        });
      }
    }
    return { icons, sounds: sounds.map((s) => s.id), planAssets };
  }

  // Asks each asset's URL with a HEAD request whether the phone can fetch it: a 200 answer whose content type is the
  // kind of file the asset is (video, image or audio). A probe that fails, times out after PROBE_TIMEOUT_MS or has no
  // absolute http(s) URL is reported `unreachable`; a redirect is not followed (it is a `bad_status`), so a probe never
  // leaves the host of our own asset URL. Never throws and never changes a plan; the probes run together.
  async probe(assets: PlanAsset[]): Promise<AssetProbe[]> {
    return Promise.all(assets.map((asset) => this.probeOne(asset)));
  }

  // The probe of one asset.
  private async probeOne(asset: PlanAsset): Promise<AssetProbe> {
    try {
      if (!/^https?:\/\//i.test(asset.url || '')) {
        return { id: asset.id, ok: false, reason_code: 'unreachable' };
      }
      const response = await fetch(asset.url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (response.status !== 200) {
        return { id: asset.id, ok: false, status: response.status, reason_code: 'bad_status' };
      }
      const type = (response.headers.get('content-type') || '').toLowerCase();
      return type.startsWith(CONTENT_FAMILY[asset.kind])
        ? { id: asset.id, ok: true, status: 200 }
        : { id: asset.id, ok: false, status: 200, reason_code: 'bad_content_type' };
    } catch (err) {
      this._logger.warn(`An asset could not be probed: ${(err as Error)?.name}`);
      return { id: asset.id, ok: false, reason_code: 'unreachable' };
    }
  }

  // The file of every slot that can have one, in the order of the entries: a query answered lately is served from the
  // cache, the others are searched, one model call picks among the names of all of them, and each pick becomes a
  // cached file. What became of each slot is added to `report` when given.
  private async filesFor(
    entries: [string, string][],
    texts: Record<string, string>,
    report?: AssetReport[],
    usage?: LlmUsage[]
  ): Promise<[string, AiEditAssetRow][]> {
    const looked = await Promise.all(
      entries.map(async ([slotId, query]) => {
        const known = await this.remembered(query);
        return { slotId, query, known, hits: known ? [] : await this.search(query) };
      })
    );
    const asked = looked
      .filter((l) => l.hits.length)
      .map((l) => ({
        id: l.slotId,
        query: l.query,
        ...(texts[l.slotId] ? { text: texts[l.slotId] } : {}),
        candidates: l.hits.map((h) => ({ uuid: h.id, name: h.name })),
      }));
    const picks = await this.pick(asked, usage);
    const stored = await Promise.all(
      looked.map(async (l): Promise<[string, AiEditAssetRow] | undefined> => {
        const note = (outcome: AssetReport['outcome_code'], row?: AiEditAssetRow) =>
          report?.push({
            slot_id: l.slotId,
            query: l.query,
            outcome_code: outcome,
            candidates: l.hits.length,
            ...(row ? { provider_id: row.providerId, asset_id: row.id, object_key: row.objectKey } : {}),
          });
        if (l.known) {
          note('remembered', l.known);
          return [l.slotId, l.known];
        }
        // a pick counts only when it names one of the slot's own candidates
        const hit = l.hits.find((h) => h.id === picks.get(l.slotId));
        if (!hit) {
          note(l.hits.length ? 'not_picked' : 'no_candidates');
          return undefined;
        }
        const file = await this.fileOf(hit, l.query);
        if (!file.row) {
          note('unusable');
          return undefined;
        }
        this.remember(l.query, hit.id);
        note(file.cached ? 'cache_hit' : 'stored', file.row);
        return [l.slotId, file.row];
      })
    );
    return stored.filter((f): f is [string, AiEditAssetRow] => !!f);
  }

  // The file a query ended in lately, when it is still cached.
  private async remembered(query: string): Promise<AiEditAssetRow | null> {
    const known = this._remembered.get(query);
    try {
      return known ? await this._assets.find(PROVIDER, known) : null;
    } catch (err) {
      this._logger.warn(`The asset cache could not be read: ${(err as Error).name}`);
      return null;
    }
  }

  // The stock items found for a query: the animated clips, else the still icons; none when the search fails.
  private async search(query: string): Promise<IconscoutHit[]> {
    for (const kind of ['video', 'icon'] as AssetKind[]) {
      try {
        const hits = await this._iconscout.search(query, kind);
        if (hits.length) return hits;
      } catch (err) {
        // only the kind of failure is logged, never the query
        this._logger.warn(`An asset could not be searched (${kind}): ${(err as Error).name}`);
      }
    }
    return [];
  }

  // The model's one call for all the slots: the picked uuid per slot id; empty when it fails or answers nothing usable.
  // What the call used is added to `usage`, named by the number of slots it picked for.
  private async pick(asked: IconPickSlot[], usage?: LlmUsage[]): Promise<Map<string, string>> {
    const picks = new Map<string, string>();
    if (!asked.length) return picks;
    const calls: LlmUsage[] = [];
    try {
      const answer = await this._editLlm.pickEditIcons(iconEditLlm(), iconPickMessages(asked), calls);
      for (const item of Array.isArray(answer?.picks) ? answer.picks : []) {
        if (typeof item?.id === 'string' && typeof item.uuid === 'string' && !picks.has(item.id)) {
          picks.set(item.id, item.uuid);
        }
      }
    } catch (err) {
      this._logger.warn(`The icons could not be picked: ${(err as Error).name}`);
    }
    usage?.push(...calls.map((call) => ({ ...call, work: `icon pick for ${asked.length} slots` })));
    return picks;
  }

  // The cached file of a hit (marked as used), else it is downloaded, checked, stored and recorded; no `row` when it
  // cannot be had. `cached` says the file was in the cache already.
  private async fileOf(hit: IconscoutHit, query: string): Promise<{ row?: AiEditAssetRow; cached: boolean }> {
    try {
      const cached = await this._assets.find(PROVIDER, hit.id);
      return cached ? { row: cached, cached: true } : { row: await this.store(hit, query), cached: false };
    } catch (err) {
      this._logger.warn(`An asset could not be stored: ${(err as Error).name}`);
      return { cached: false };
    }
  }

  // Remembers which file a query ended in.
  private remember(query: string, providerId: string) {
    this._remembered.delete(query);
    this._remembered.set(query, providerId);
    if (this._remembered.size > MAX_REMEMBERED) {
      this._remembered.delete(this._remembered.keys().next().value as string);
    }
  }

  // Downloads one hit, checks it is the kind of file it should be, stores it with what is known of it and records it;
  // undefined when the file is not usable.
  private async store(hit: IconscoutHit, query: string): Promise<AiEditAssetRow | undefined> {
    let data: Buffer;
    try {
      data = await this._iconscout.download(hit);
    } catch (err) {
      this._logger.warn(`An asset could not be downloaded: ${(err as Error).name}`);
      return undefined;
    }
    const video = hit.kind === 'video';
    const info: FileInfo | undefined = video ? mp4Info(data) : pngInfo(data);
    const key = assetKey(PROVIDER, hit.id, video ? 'mp4' : 'png');
    if (!info || !key) return undefined;
    await R2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: data,
        ContentType: video ? 'video/mp4' : 'image/png',
      })
    );
    return this._assets.create({
      provider: PROVIDER,
      providerId: hit.id,
      kind: hit.kind,
      objectKey: key,
      name: hit.name,
      query,
      source: 'preview',
      ...(hit.slug ? { slug: hit.slug } : {}),
      ...(hit.price !== undefined ? { price: hit.price } : {}),
      ...(hit.colorCodes ? { colorCodes: hit.colorCodes as Prisma.InputJsonArray } : {}),
      ...(info.nativeDurationMs ? { nativeDurationMs: info.nativeDurationMs } : {}),
      ...(info.width ? { width: info.width } : {}),
      ...(info.height ? { height: info.height } : {}),
    });
  }

  // Deletes the cached files not used for AI_EDIT_ASSET_RETENTION_DAYS days: the object from R2 first, then its row, so a
  // failed delete leaves the row to try again the next day and never an object nothing names. Answers how many went.
  // Never throws.
  async purgeUnused(now: Date = new Date()): Promise<{ purged: number; failed: number }> {
    const cutoff = new Date(now.getTime() - assetRetentionDays(process.env.AI_EDIT_ASSET_RETENTION_DAYS) * DAY_MS);
    let purged = 0;
    let failed = 0;
    try {
      for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
        const rows = await this._assets.findUnusedSince(cutoff, PURGE_BATCH);
        const gone: string[] = [];
        for (const row of rows) {
          try {
            await R2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.objectKey }));
            gone.push(row.id);
          } catch (err) {
            failed++;
            this._logger.warn(`An unused asset could not be deleted: ${(err as Error).name}`);
          }
        }
        purged += await this._assets.deleteByIds(gone);
        // a short read is the end of the rows; a batch that removed nothing would only be read again
        if (rows.length < PURGE_BATCH || !gone.length) break;
      }
    } catch (err) {
      this._logger.warn(`The unused assets could not be purged: ${(err as Error).name}`);
    }
    return { purged, failed };
  }
}
