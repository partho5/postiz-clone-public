// AI video editing (ai.video-editing), planner core: where an overlay may sit (spec sections 13, 16 and 17 rule 6).
// An overlay stays inside the safe rectangle of every requested output, outside its caption band and clear of the
// facecam circle. The server does not know the fonts, so a text block is estimated from its length; the assembler
// picks a zone with the same functions the validator checks it with. Pure functions, no Nest or Prisma import.
import {
  EditRequestOutput,
  OUTPUTS,
  PlanFacecamKey,
  TextLook,
  ZONES,
  ZoneId,
} from '../contract/edit.contract';
import { drawnText, segmenterOf, titleCase, wordSegments } from '../contract/edit.case';
import { lookSizeFactor } from '../contract/edit.styles';

// Title Case and the word segmenter live in the contract folder (the look vectors need them); one source, re-exported here.
export { drawnText, titleCase, wordSegments };

// A rectangle in an output's frame, as fractions of its width and height.
export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// What an overlay draws: a text block (with the language its words are counted in, and the look it is drawn in when that
// is known: its box and border make the block larger than the text, see `lookSizeFactor`) or an icon or mp4 clip square.
export type OverlayShape = { type: 'text'; text: string; language?: string; look?: TextLook } | { type: 'icon' };

// A stretch of the output timeline where a part of the master frame holds the content (the user's ink, the slide's title),
// which a text or an icon must not cover. `region` is in master fractions (x, y, w, h), like a brush entry's.
export interface ContentKeepOut {
  start_ms: number;
  end_ms: number;
  region: { x: number; y: number; w: number; h: number };
}

// What the geometry needs to know: the master's size, the enabled outputs, the facecam on the output timeline and (when
// the request shows content to keep clear) its keep-outs on the output timeline.
export interface GeometryContext {
  video: { width: number; height: number };
  outputs: EditRequestOutput[];
  facecam: PlanFacecamKey[];
  keepouts?: ContentKeepOut[];
}

// The estimate of an overlay's size. A character of the normal width class is `char_w` of the output width wide (the
// other classes scale it, see `WIDTH_FACTOR`), a line `line_h` of it tall (look padding and tilt included), a block is
// at most `max_w` wide (a longer one is shrunk or wrapped on at most `max_lines` lines) and an icon is `icon_w` wide;
// `pad` is added on every axis. `min_scale` is the smallest share of its size the phone shrinks a text to before it
// gives the text up (the phone's floor, see the contract's text size section). `s_w` is the text size `s` as a share of
// the output width (the same in every ratio), which turns a look's size factor (in `s`) into a share of the frame.
export const OVERLAY_SIZE = {
  char_w: 0.058,
  line_h: 0.15,
  max_w: 0.84,
  icon_w: 0.18,
  pad: 0.02,
  max_lines: 2,
  min_scale: 0.5,
  s_w: 0.0889,
};

// The margin kept around the facecam circle, as a fraction of the output.
export const FACECAM_MARGIN = 0.02;

// The margin kept around content (ink, a slide title), as a fraction of the output.
export const CONTENT_MARGIN = 0.02;

// Zones in the order the planner tries them; the first one fitting every output is used.
export const ZONE_ORDER: ZoneId[] = [
  'upper_center',
  'upper_left',
  'upper_right',
  'middle_center',
  'lower_center',
];

const EPS = 1e-9;

// The text as the user sees its characters: one entry per grapheme cluster (a Bengali conjunct, an emoji with its
// modifiers or a letter with its marks is one).
export const graphemes = (text: string): string[] =>
  Array.from(segmenterOf('grapheme').segment(text), (part) => part.segment);

// The words of a text. A text with no letters or digits (only symbols or emoji) has one word per space-separated piece.
export const words = (text: string, language?: string): string[] => {
  const found = wordSegments(text, language)
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);
  return found.length ? found : text.split(/\s+/).filter(Boolean);
};

// The number of words of a text.
export const wordCount = (text: string, language?: string) => words(text, language).length;

// How wide a character is, relative to a character of the normal class (a Latin letter).
export type WidthClass = 'narrow' | 'normal' | 'wide';
export const WIDTH_FACTOR: Record<WidthClass, number> = { narrow: 0.85, normal: 1, wide: 1.6 };

// The Unicode scripts of the narrow and the normal class; a script in neither list is wide (the conservative default
// for a script not known here), as are emoji and the full width forms (which are `Common`, so they are listed first).
const WIDE_FIRST = new RegExp('^[\\p{Extended_Pictographic}\\u3000-\\u303F\\uFF00-\\uFFEF]', 'u');
export const WIDTH_SCRIPTS: Record<Exclude<WidthClass, 'wide'>, string[]> = {
  narrow: ['Hebrew', 'Thai', 'Lao'],
  normal: ['Common', 'Inherited', 'Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Arabic', 'Syriac', 'Thaana'],
};
const SCRIPT_TESTS = (Object.keys(WIDTH_SCRIPTS) as Array<keyof typeof WIDTH_SCRIPTS>).map(
  (width) =>
    [width, new RegExp(`^[${WIDTH_SCRIPTS[width].map((s) => `\\p{Script=${s}}`).join('')}]`, 'u')] as const
);

// The width class of one grapheme, from the Unicode script of its first character.
export const widthClass = (grapheme: string): WidthClass => {
  if (WIDE_FIRST.test(grapheme)) return 'wide';
  const found = SCRIPT_TESTS.find(([, test]) => test.test(grapheme));
  return found ? found[0] : 'wide';
};

// The code points that are drawn as a letter or a number of their own. Marks, joiners, virama and variation selectors
// are not: they sit on or join a letter. A grapheme cluster such as a Bengali or Devanagari conjunct is one cluster
// on a current Unicode but the phone draws one glyph for each base letter in it, so the estimate counts those.
const BASE_LETTER = /[\p{L}\p{N}]/gu;
const PICTOGRAPH_FIRST = /^\p{Extended_Pictographic}/u;

// How many characters of its class one grapheme is wide: its base letters and numbers (at least 1; an emoji with its
// modifiers or joined family stays 1, as it is drawn as one picture).
export const graphemeWeight = (grapheme: string) =>
  PICTOGRAPH_FIRST.test(grapheme) ? 1 : Math.max(1, (grapheme.match(BASE_LETTER) || []).length);

// The width of a text in characters of the normal class (a Latin text counts its characters).
export const textUnits = (text: string) =>
  graphemes(text.trim()).reduce((sum, g) => sum + graphemeWeight(g) * WIDTH_FACTOR[widthClass(g)], 0);

// How many lines the estimate puts a text on: 1 when it fits a line, or when it is one word the phone shrinks (down to
// `min_scale`); 2 when more words wrap; `Infinity` when the phone could not lay it out. `extra` is the width a look adds
// around its text on every line (box padding and border, as a share of the output width; 0 for no look), which takes
// room from the text.
export const textLines = (text: string, language?: string, extra = 0) => {
  const o = OVERLAY_SIZE;
  const line = textUnits(text) * o.char_w;
  if (line + extra <= o.max_w) return 1;
  if (wordCount(text, language) < 2) return line + extra <= o.max_w / o.min_scale ? 1 : Infinity;
  return line + o.max_lines * extra <= o.max_lines * o.max_w ? 2 : Infinity;
};

// How much wider and taller than the text a look makes its overlay, as shares of the frame's width and of its height
// (the look's size factor in `s`; none for no look or a look inside the estimate's baseline).
export const lookGrowth = (look: TextLook | undefined, aspect = 1) => {
  const factor = look ? lookSizeFactor(look) : { w: 0, h: 0 };
  return { w: factor.w * OVERLAY_SIZE.s_w, h: factor.h * OVERLAY_SIZE.s_w * aspect };
};

// The box of an overlay centred on a zone of one output (zones are fractions of the output's safe rectangle).
export const overlayBox = (
  shape: OverlayShape,
  zone: ZoneId,
  output: EditRequestOutput
): Box => {
  const spec = OUTPUTS[output.ratio];
  const aspect = spec.width / spec.height;
  const [zx, zy] = ZONES[zone];
  const cx = spec.safe.x0 + zx * (spec.safe.x1 - spec.safe.x0);
  const cy = spec.safe.y0 + zy * (spec.safe.y1 - spec.safe.y0);
  const o = OVERLAY_SIZE;
  let w: number;
  let h: number;
  if (shape.type === 'icon') {
    w = o.icon_w;
    h = o.icon_w * aspect;
  } else {
    const grow = lookGrowth(shape.look, aspect);
    const line = textUnits(shape.text) * o.char_w;
    const lines = textLines(shape.text, shape.language, grow.w) > 1 ? 2 : 1;
    w = lines === 2 ? o.max_w : Math.min(o.max_w, line + grow.w);
    h = lines * o.line_h * aspect + grow.h;
  }
  w += o.pad;
  h += o.pad;
  return { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
};

// Whether two boxes share any area.
export const boxesOverlap = (a: Box, b: Box) =>
  a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;

// The facecam keys that show while [startMs, endMs): the one active at the start and every change inside.
export const facecamKeysIn = (
  track: PlanFacecamKey[],
  startMs: number,
  endMs: number
): PlanFacecamKey[] => {
  if (!track.length) return [];
  const sorted = [...track].sort((a, b) => a.t_ms - b.t_ms);
  let active = sorted[0];
  for (const k of sorted) {
    if (k.t_ms <= startMs) active = k;
  }
  return [active, ...sorted.filter((k) => k.t_ms > startMs && k.t_ms < endMs)];
};

// The facecam circle's box (with margin) in one output's frame, or null when no part of it lies inside the crop.
export const facecamBox = (
  key: PlanFacecamKey,
  video: { width: number; height: number },
  output: EditRequestOutput
): Box | null => {
  const c = output.crop;
  if (c.w <= 0 || c.h <= 0 || video.height <= 0) return null;
  const rx = key.radius / c.w;
  const ry = (key.radius * (video.width / video.height)) / c.h;
  const fx = (key.cx - c.x) / c.w;
  const fy = (key.cy - c.y) / c.h;
  const box = {
    x0: fx - rx - FACECAM_MARGIN,
    x1: fx + rx + FACECAM_MARGIN,
    y0: fy - ry - FACECAM_MARGIN,
    y1: fy + ry + FACECAM_MARGIN,
  };
  const visible = boxesOverlap(box, { x0: 0, x1: 1, y0: 0, y1: 1 });
  return visible ? box : null;
};

// A content region (master fractions) in one output's frame, padded by `CONTENT_MARGIN`, or null when no part of it lies
// inside the crop.
export const contentBox = (region: ContentKeepOut['region'], output: EditRequestOutput): Box | null => {
  const c = output.crop;
  if (c.w <= 0 || c.h <= 0) return null;
  const box = {
    x0: (region.x - c.x) / c.w - CONTENT_MARGIN,
    x1: (region.x + region.w - c.x) / c.w + CONTENT_MARGIN,
    y0: (region.y - c.y) / c.h - CONTENT_MARGIN,
    y1: (region.y + region.h - c.y) / c.h + CONTENT_MARGIN,
  };
  return boxesOverlap(box, { x0: 0, x1: 1, y0: 0, y1: 1 }) ? box : null;
};

// Whether a box lies inside a rectangle.
const inside = (b: Box, r: Box) =>
  b.x0 >= r.x0 - EPS && b.x1 <= r.x1 + EPS && b.y0 >= r.y0 - EPS && b.y1 <= r.y1 + EPS;

// Whether an overlay in a zone is allowed during [startMs, endMs): a text the phone can lay out, inside every
// output's safe rectangle, outside every caption band, clear of the facecam wherever the facecam shows in that output and
// clear of the content keep-outs that are live while the overlay shows.
export const overlayFits = (
  shape: OverlayShape,
  zone: ZoneId,
  startMs: number,
  endMs: number,
  ctx: GeometryContext
): boolean => {
  if (shape.type === 'text' && textLines(shape.text, shape.language, lookGrowth(shape.look).w) > OVERLAY_SIZE.max_lines) {
    return false;
  }
  const keys = facecamKeysIn(ctx.facecam, startMs, endMs);
  for (const output of ctx.outputs) {
    const box = overlayBox(shape, zone, output);
    if (!inside(box, OUTPUTS[output.ratio].safe)) return false;
    if (output.caption_band) {
      const band: Box = { x0: 0, x1: 1, y0: output.caption_band.y0, y1: output.caption_band.y1 };
      if (boxesOverlap(box, band)) return false;
    }
    for (const key of keys) {
      const face = facecamBox(key, ctx.video, output);
      if (face && boxesOverlap(box, face)) return false;
    }
    for (const keep of ctx.keepouts || []) {
      if (keep.start_ms >= endMs || keep.end_ms <= startMs) continue;
      const content = contentBox(keep.region, output);
      if (content && boxesOverlap(box, content)) return false;
    }
  }
  return true;
};

// The first zone of `preferred` (then the rest of ZONE_ORDER) where the overlay fits, or null when none does.
export const placeOverlay = (
  shape: OverlayShape,
  preferred: ZoneId[],
  startMs: number,
  endMs: number,
  ctx: GeometryContext
): ZoneId | null => {
  const order = [...preferred, ...ZONE_ORDER.filter((z) => !preferred.includes(z))];
  return order.find((z) => overlayFits(shape, z, startMs, endMs, ctx)) || null;
};
