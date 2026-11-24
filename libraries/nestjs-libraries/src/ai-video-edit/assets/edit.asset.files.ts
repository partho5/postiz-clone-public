// AI video editing (ai.video-editing), assets (spec section 15): the pure parts of getting icon and mp4 clip files and
// sound urls into a plan: which slots are searched and with what, what a downloaded file must be, the object key it is
// stored under, the plan's sound entries and the entries a plan really uses. No Nest, network or storage import.
import { EditLevel, LEVEL_RULES, Plan, PlanAsset } from '../contract/edit.contract';
import { SOUND_IDS } from '../contract/edit.sounds';
import { SlotScores } from '../core/edit.assembler';
import { HOOK_SLOT_ID, Slot } from '../core/edit.slots';
import { WrittenTexts } from '../core/edit.texts';

// The largest file taken for an icon image or an mp4 clip (a bigger one is not a short overlay).
export const MAX_ICON_BYTES = 2 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 6 * 1024 * 1024;

// An mp4 clip this long or longer is no overlay of a second or two (the plan clamps the item, the speed factor is
// capped at 3), so the resolver keeps it out of the cache.
export const MAX_VIDEO_MS = 15_000;

// How many days a cached file may go unused before the daily purge removes it, when AI_EDIT_ASSET_RETENTION_DAYS is unset
// or is not a whole number of at least 1. The only place that names a number of days.
export const DEFAULT_ASSET_RETENTION_DAYS = 30;

// The most days a retention may name (a hundred years): a larger number would make the purge date invalid and skip the purge.
export const MAX_RETENTION_DAYS = 36_500;

// The retention in days from the environment value: a whole number from 1 to MAX_RETENTION_DAYS, else the default (a typo
// never turns the purge off or makes it immediate).
export const assetRetentionDays = (raw: string | undefined) => {
  const text = (raw || '').trim();
  const value = /^\d+$/.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_RETENTION_DAYS ? value : DEFAULT_ASSET_RETENTION_DAYS;
};

// A file read: what the plan needs to know about it.
export interface FileInfo {
  nativeDurationMs?: number;
  width?: number;
  height?: number;
}

// The objects are stored under this prefix of the media bucket: `ai-edit/assets/<provider>/<id>.<ext>`.
export const ASSET_KEY_PREFIX = 'ai-edit/assets';

// A provider id that may be part of an object key (letters, digits, `-` and `_`, as IconScout's uuids are).
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

// The object key of an asset, or undefined when the provider id could not be part of one.
export const assetKey = (provider: string, providerId: string, ext: 'mp4' | 'png') =>
  SAFE_ID.test(providerId) && SAFE_ID.test(provider)
    ? `${ASSET_KEY_PREFIX}/${provider}/${providerId}.${ext}`
    : undefined;

// One box of an mp4 file: its type and where its content starts and ends (the next box starts at its end).
interface Mp4Box {
  type: string;
  start: number;
  end: number;
}

// The box at `pos` inside `end`: a 32 bit size, or the 64 bit size of a large box (one over 4 GB is refused), or `0`
// for a box that runs to the end; undefined when the header does not fit or the size is not inside the parent.
const readBox = (data: Buffer, pos: number, end: number): Mp4Box | undefined => {
  if (pos + 8 > end) return undefined;
  let size = data.readUInt32BE(pos);
  let header = 8;
  if (size === 1) {
    if (pos + 16 > end || data.readUInt32BE(pos + 8) > 0) return undefined;
    size = data.readUInt32BE(pos + 12);
    header = 16;
  } else if (size === 0) {
    size = end - pos;
  }
  if (size < header || pos + size > end) return undefined;
  return { type: data.toString('latin1', pos + 4, pos + 8), start: pos + header, end: pos + size };
};

// The boxes inside `start..end`, stopping at the first one that is not well formed.
const boxesIn = (data: Buffer, start: number, end: number): Mp4Box[] => {
  const boxes: Mp4Box[] = [];
  for (let pos = start; ; ) {
    const box = readBox(data, pos, end);
    if (!box) return boxes;
    boxes.push(box);
    pos = box.end;
  }
};

// An mp4 clip read: its duration from the movie header and the size of its first video track; undefined when it is
// not an mp4, has no video, is empty or too long to be an overlay. Plain byte reads, every one inside its box.
export const mp4Info = (data: Buffer): FileInfo | undefined => {
  if (data.length < 16 || data.length > MAX_VIDEO_BYTES) return undefined;
  const top = boxesIn(data, 0, data.length);
  const moov = top.find((b) => b.type === 'moov');
  if (top[0]?.type !== 'ftyp' || !moov) return undefined;
  const parts = boxesIn(data, moov.start, moov.end);
  const mvhd = parts.find((b) => b.type === 'mvhd');
  if (!mvhd || mvhd.end - mvhd.start < 4) return undefined;
  const version = data.readUInt8(mvhd.start);
  const timescaleAt = mvhd.start + (version === 1 ? 20 : 12);
  const durationAt = timescaleAt + 4;
  if (version > 1 || durationAt + (version === 1 ? 8 : 4) > mvhd.end) return undefined;
  const timescale = data.readUInt32BE(timescaleAt);
  if (version === 1 && data.readUInt32BE(durationAt) > 0) return undefined;
  const units = data.readUInt32BE(durationAt + (version === 1 ? 4 : 0));
  const nativeDurationMs = timescale > 0 ? Math.round((units / timescale) * 1000) : 0;
  if (nativeDurationMs <= 0 || nativeDurationMs >= MAX_VIDEO_MS) return undefined;
  for (const trak of parts.filter((b) => b.type === 'trak')) {
    const inTrak = boxesIn(data, trak.start, trak.end);
    const mdia = inTrak.find((b) => b.type === 'mdia');
    const hdlr = mdia && boxesIn(data, mdia.start, mdia.end).find((b) => b.type === 'hdlr');
    const tkhd = inTrak.find((b) => b.type === 'tkhd');
    if (!hdlr || !tkhd || hdlr.end - hdlr.start < 12) continue;
    if (data.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
    const tkVersion = data.readUInt8(tkhd.start);
    const sizeAt = tkhd.start + (tkVersion === 1 ? 88 : 76);
    if (tkVersion > 1 || sizeAt + 8 > tkhd.end) return undefined;
    const width = data.readUInt32BE(sizeAt) >>> 16;
    const height = data.readUInt32BE(sizeAt + 4) >>> 16;
    return width > 0 && height > 0 ? { nativeDurationMs, width, height } : undefined;
  }
  return undefined;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A PNG read: its size from the IHDR chunk; undefined when it is not a PNG, is too large or has no size.
export const pngInfo = (data: Buffer): FileInfo | undefined => {
  if (data.length < 24 || data.length > MAX_ICON_BYTES) return undefined;
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('ascii', 12, 16) !== 'IHDR') {
    return undefined;
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
};

// The sound entries of a plan: one `<base>/<id>.wav` per contract sound, none without a base url.
export const soundAssets = (baseUrl: string | undefined): PlanAsset[] => {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  return base
    ? SOUND_IDS.map((id) => ({ id, kind: 'sound' as const, url: `${base}/${id}.wav` }))
    : [];
};

// Words of a slot's keyword that can be searched at a stock provider: English letters and digits, one to three words.
const searchable = (keyword: string) => {
  const words = keyword
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.length && words.length <= 3 && words.join('').length >= 3
    ? words.join(' ').toLowerCase()
    : undefined;
};

// What is searched for which slot: at most twice the level's icon budget (the plan keeps the best that fit), the best
// scored slots first; a slot perception said to leave plain is skipped. The writer's icon query wins, else the slot's
// own keyword when it is English. A level without icons searches nothing.
export const iconQueries = (
  slots: Slot[],
  level: EditLevel,
  scores?: SlotScores,
  written?: WrittenTexts
): Record<string, string> => {
  const limit = 2 * LEVEL_RULES[level].max_icons;
  const out: Record<string, string> = {};
  if (!limit) return out;
  const ranked = [...slots].sort((a, b) => b.score - a.score || a.start_ms - b.start_ms);
  for (const slot of ranked) {
    if (Object.keys(out).length >= limit) break;
    if (scores?.family?.[slot.id] === 'none') continue;
    const query = written?.icon_queries?.[slot.id] || searchable(slot.keyword || '');
    if (query) out[slot.id] = query;
  }
  return out;
};

// The text the writer wrote for each slot id (the hook slot's text is the hook), what the picker reads beside a query.
export const slotTexts = (written?: WrittenTexts): Record<string, string> => ({
  ...(written?.complementary || {}),
  ...(written?.hook ? { [HOOK_SLOT_ID]: written.hook } : {}),
});

// The entries of `all` a plan uses: the asset of every icon or mp4 clip component and every sound. A listed file
// nothing plays is not sent to the phone.
export const usedAssets = (plan: Plan, all: PlanAsset[]): PlanAsset[] => {
  const used = new Set<string>();
  for (const item of plan.items) {
    const component = item.component;
    if (component && component.type !== 'styled_text') used.add(component.asset_id);
    if (item.sound) used.add(item.sound.id);
  }
  return all.filter((a) => used.has(a.id));
};
