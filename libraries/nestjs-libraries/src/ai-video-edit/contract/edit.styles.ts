// AI video editing (ai.video-editing): the sixteen text looks (the six shipped ones and the ten of card S8) and the text palette (spec section 13). A look names
// colour roles (accent, accent_dark, accent_light, on_accent, ink, paper), never fixed colours, so one look works with any palette.
// Sizes are fractions of the text size `s`.
import { ColorRole, FillSpec, PaletteSpec, RoleDerivation, TextFeature, TextLayer, TextLook } from './edit.contract';

// The multi colour accents rotated by `color_slot`, and the ink and paper the roles `ink` and `paper` resolve to.
export const PALETTE: PaletteSpec = {
  multi: ['#FF3B30', '#FFD60A', '#34C759', '#32D7FF', '#FF2D92'],
  ink: '#111111',
  paper: '#FFFFFF',
};

// How `accent_dark` and `accent_light` come from the item's accent (`accent_dark` is the phone's 0.55 factor today).
export const ROLE_DERIVATION: RoleDerivation = {
  accent_dark: { factor: 0.55 },
  accent_light: { paper_share: 0.65 },
};

// The layers of one overlay, back to front (spec: layer order); two phones must stack them the same.
export const TEXT_LAYER_ORDER: TextLayer[] = [
  'box_shadow',
  'box_fill',
  'box_border',
  'text_shadow',
  'text_stroke',
  'text_fill',
  'glow',
];

// Every feature a look may need beyond the legacy format, in one fixed order.
export const TEXT_FEATURES: TextFeature[] = [
  'text_gradient_ltr',
  'text_gradient_diag',
  'text_stroke_join',
  'box_gradient',
  'box_border',
  'box_border_ring',
  'box_glow',
  'opacity',
  'font_family',
  'font_weight',
  'case_as_written',
  'letter_spacing',
];

// The features `look` needs the phone to draw, in `TEXT_FEATURES` order: what the new blocks use that the legacy
// format cannot say (the six shipped looks need none, so a phone that lists no feature still draws them).
export const requiredFeatures = (look: TextLook): TextFeature[] => {
  const needs = new Set<TextFeature>();
  const { text_fill, text_stroke, box } = look;
  if (text_fill.kind === 'gradient' && text_fill.direction === 'ltr') needs.add('text_gradient_ltr');
  if (text_fill.kind === 'gradient' && text_fill.direction === 'diag') needs.add('text_gradient_diag');
  if (text_stroke && text_stroke.join !== 'round') needs.add('text_stroke_join');
  if (box?.fill.kind === 'gradient') needs.add('box_gradient');
  if (box?.border) needs.add('box_border');
  if (box?.border?.ring) needs.add('box_border_ring');
  if (box?.glow) needs.add('box_glow');
  if (look.opacity !== 1) needs.add('opacity');
  if (look.font.family !== 'sans') needs.add('font_family');
  if (look.font.weight !== 700) needs.add('font_weight');
  if (look.case === 'as_written') needs.add('case_as_written');
  if (look.letter_spacing !== 0) needs.add('letter_spacing');
  return TEXT_FEATURES.filter((feature) => needs.has(feature));
};

// ---- Colour: the roles resolved to hex, and the contrast of a look's text on its box ----

// The smallest contrast ratio (WCAG relative luminance, 1 to 21) a look's text colour must have against the fill of its
// box: 3 is the level for large text, and every overlay text is large and bold.
export const MIN_TEXT_CONTRAST = 3;

const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

// The relative luminance of a `#RRGGBB` colour.
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// The contrast ratio of two `#RRGGBB` colours: 1 (the same) to 21 (black on white).
export const contrastRatio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// The `#RRGGBB` colour of a role for an item whose accent is `accent`, by `ROLE_DERIVATION` (the phone does the same).
export const resolveRole = (role: ColorRole, accent: string, palette: PaletteSpec = PALETTE): string => {
  switch (role) {
    case 'accent':
      return accent;
    case 'accent_dark':
      return toHex(channels(accent).map((c) => c * ROLE_DERIVATION.accent_dark.factor));
    case 'accent_light': {
      const share = ROLE_DERIVATION.accent_light.paper_share;
      const paper = channels(palette.paper);
      return toHex(channels(accent).map((c, i) => c * (1 - share) + paper[i] * share));
    }
    case 'on_accent':
      return contrastRatio(palette.ink, accent) >= contrastRatio(palette.paper, accent) ? palette.ink : palette.paper;
    case 'ink':
      return palette.ink;
    case 'paper':
      return palette.paper;
  }
};

// The colour roles of a fill: one for a solid, both stops for a gradient.
const fillRoles = (fill: FillSpec): ColorRole[] => (fill.kind === 'solid' ? [fill.color] : [fill.from, fill.to]);

// The lowest contrast between the text colour of a look and the fill of its box, for an item whose accent is `accent`; null
// when the look has no box (its text sits on the video, held apart by its stroke). Every stop of a gradient counts.
export const lookContrast = (look: TextLook, accent: string): number | null => {
  if (!look.box) return null;
  const ratios = fillRoles(look.text_fill).flatMap((text) =>
    fillRoles(look.box!.fill).map((box) => contrastRatio(resolveRole(text, accent), resolveRole(box, accent)))
  );
  return Math.min(...ratios);
};

// ---- Size: what a look adds around its text, for the fit estimate (`overlayBox`, decision 11) ----

// What the estimate of `OVERLAY_SIZE` already holds around the text, in `s`, both sides together: the largest extent of a
// look shipped before card S8 (the label pill's box and shadow), rounded up. A look that adds no more than this needs no
// size factor, so the placement of the shipped looks never changes.
export const BASELINE_EXTENT = { x: 0.8, y: 0.5 };

// The room a look takes around its measured text, in `s`, summed over both sides of each axis: the box padding, its border
// and second ring, a hard offset block or neon glow of the box, the width of the letter stroke and the offset of the text
// shadow. A soft shadow's blur is not counted (it fades out), a glow's is (it is the point of the look).
export const lookExtent = (look: TextLook): { x: number; y: number } => {
  let x = 0;
  let y = 0;
  const { box, text_stroke, text_shadow } = look;
  if (box) {
    const ring = box.border?.ring;
    const edge = (box.border?.width ?? 0) + (ring ? ring.gap + ring.width : 0);
    x += 2 * (box.padding.x + edge);
    y += 2 * (box.padding.y + edge);
    if (box.shadow) {
      x += Math.abs(box.shadow.dx);
      y += Math.abs(box.shadow.dy);
    }
    if (box.glow) {
      x += box.glow.blur;
      y += box.glow.blur;
    }
  }
  if (text_stroke) {
    x += text_stroke.width;
    y += text_stroke.width;
  }
  if (text_shadow) {
    x += Math.abs(text_shadow.dx);
    y += Math.abs(text_shadow.dy);
  }
  return { x, y };
};

// The size factor of a look: how much wider and taller than the baseline the box and border make its overlay, in `s`
// (0 for a look inside the baseline, such as every look shipped before card S8). The estimate adds it to the text's size.
export const lookSizeFactor = (look: TextLook): { w: number; h: number } => {
  const extent = lookExtent(look);
  const over = (value: number, base: number) => Math.round(Math.max(0, value - base) * 1000) / 1000;
  return { w: over(extent.x, BASELINE_EXTENT.x), h: over(extent.y, BASELINE_EXTENT.y) };
};

// A look with every part off; each look below switches on only what it draws. The new format defaults to what installed
// phones draw for every look: bold sans, `case: upper` (drawn as Title Case since 2026-11-20, all caps on older phones) where the script has case, no spacing, full opacity.
const look = (partial: Partial<TextLook> & Pick<TextLook, 'id' | 'fill' | 'text_fill'>): TextLook => ({
  stroke: null,
  shadow: null,
  glow: null,
  extrude: null,
  background: null,
  bar: null,
  tilt_deg: null,
  text_stroke: null,
  text_shadow: null,
  box: null,
  opacity: 1,
  font: { family: 'sans', weight: 700 },
  case: 'upper',
  letter_spacing: 0,
  ...partial,
});

// The style presets, in the order of spec section 13 (the six shipped ones), then the ten of card S8. Each look states its legacy fields (installed phones) and
// the new blocks beside them: a legacy `shadow` is the new `text_shadow`, or the box's `shadow` where the look has a
// `background` (that is where installed phones draw it); glow, extrude and bar have no new block yet.
export const TEXT_LOOKS: TextLook[] = [
  look({
    id: 'sticker',
    fill: 'accent',
    stroke: { color: 'ink', width: 0.14 },
    shadow: { color: 'ink', alpha: 1, dx: 0.05, dy: 0.06, blur: 0 },
    tilt_deg: [-6, 6],
    text_fill: { kind: 'solid', color: 'accent' },
    text_stroke: { color: 'ink', width: 0.14, join: 'round' },
    text_shadow: { color: 'ink', alpha: 1, dx: 0.05, dy: 0.06, blur: 0 },
  }),
  look({
    id: 'label_pill',
    fill: 'on_accent',
    background: { color: 'accent', alpha: 1, radius: 0.5, pad_x: 0.35, pad_y: 0.2 },
    shadow: { color: 'ink', alpha: 0.35, dx: 0, dy: 0.04, blur: 0.08 },
    text_fill: { kind: 'solid', color: 'on_accent' },
    box: {
      shape: 'pill',
      fill: { kind: 'solid', color: 'accent', alpha: 1 },
      border: null,
      radius: 0.5,
      padding: { x: 0.35, y: 0.2 },
      shadow: { style: 'soft', color: 'ink', alpha: 0.35, dx: 0, dy: 0.04, blur: 0.08 },
      glow: null,
    },
  }),
  look({
    id: '3d',
    fill: 'accent',
    stroke: { color: 'ink', width: 0.06 },
    extrude: { copies: 6, color: 'accent_dark', dx: 0.012, dy: 0.016 },
    text_fill: { kind: 'solid', color: 'accent' },
    text_stroke: { color: 'ink', width: 0.06, join: 'round' },
  }),
  look({
    id: 'glow',
    fill: 'paper',
    stroke: { color: 'accent', width: 0.04 },
    glow: { color: 'accent', alpha: 0.85, blur: 0.35 },
    text_fill: { kind: 'solid', color: 'paper' },
    text_stroke: { color: 'accent', width: 0.04, join: 'round' },
  }),
  look({
    id: 'gradient',
    fill: { gradient: 'vertical', from: 'paper', to: 'accent' },
    stroke: { color: 'ink', width: 0.1 },
    text_fill: { kind: 'gradient', direction: 'ttb', from: 'paper', to: 'accent' },
    text_stroke: { color: 'ink', width: 0.1, join: 'round' },
  }),
  look({
    id: 'highlighter',
    fill: 'ink',
    bar: { color: 'accent', alpha: 0.85, height: 0.55 },
    text_fill: { kind: 'solid', color: 'ink' },
  }),
  // ---- Card S8: the ten looks of the three reference sheets. Each draws its
  // box in the new format; its legacy fields are the nearest thing the strict reader of installed phones accepts (a solid
  // text colour and a flat `background`; a vertical gradient only on the text, so a box gradient or a border has no legacy
  // twin). They write the text as it is written (`as_written`), as the sheets do, and every one needs `box_border` and
  // `case_as_written`, so a phone lists them in `text_features` only once it draws those. The colours are roles, so one
  // look works with every accent: text on an `accent` fill is `on_accent`, text on a light tint `accent_dark`. ----
  // Sheet 1, Neon Night: a black box, an accent border that glows, light accent text that glows.
  look({
    id: 'neon_box',
    fill: 'paper',
    glow: { color: 'accent', alpha: 0.7, blur: 0.25 },
    background: { color: 'ink', alpha: 1, radius: 0.22, pad_x: 0.45, pad_y: 0.22 },
    text_fill: { kind: 'solid', color: 'accent_light' },
    box: {
      shape: 'rounded',
      fill: { kind: 'solid', color: 'ink', alpha: 1 },
      border: { color: 'accent', width: 0.06, ring: null },
      radius: 0.22,
      padding: { x: 0.45, y: 0.22 },
      shadow: null,
      glow: { color: 'accent', alpha: 0.8, blur: 0.35 },
    },
    font: { family: 'sans', weight: 500 },
    case: 'as_written',
  }),
  // Sheet 1, Eco Green: an accent pill inside a thick dark ring, light text.
  look({
    id: 'pill_ring',
    fill: 'on_accent',
    background: { color: 'accent', alpha: 1, radius: 0.5, pad_x: 0.55, pad_y: 0.22 },
    text_fill: { kind: 'solid', color: 'on_accent' },
    box: {
      shape: 'pill',
      fill: { kind: 'solid', color: 'accent', alpha: 1 },
      border: { color: 'accent_dark', width: 0.1, ring: null },
      radius: 0.5,
      padding: { x: 0.55, y: 0.22 },
      shadow: null,
      glow: null,
    },
    case: 'as_written',
  }),
  // Sheet 1, Sunset Orange: a box that fades from the accent to its light tint left to right, a thick black border and a
  // hard offset black block, dark text. The legacy twin keeps the flat accent and the hard shadow.
  look({
    id: 'gradient_block',
    fill: 'ink',
    shadow: { color: 'ink', alpha: 1, dx: 0.1, dy: 0.1, blur: 0 },
    background: { color: 'accent', alpha: 1, radius: 0.3, pad_x: 0.5, pad_y: 0.22 },
    text_fill: { kind: 'solid', color: 'ink' },
    box: {
      shape: 'rounded',
      fill: { kind: 'gradient', direction: 'ltr', from: 'accent', to: 'accent_light', alpha: 1 },
      border: { color: 'ink', width: 0.1, ring: null },
      radius: 0.3,
      padding: { x: 0.5, y: 0.22 },
      shadow: { style: 'hard', color: 'ink', alpha: 1, dx: 0.1, dy: 0.1, blur: 0 },
      glow: null,
    },
    font: { family: 'sans', weight: 800 },
    case: 'as_written',
  }),
  // Sheet 1, Purple Pop: an accent sticker tilted about -6 degrees, a light inner and an accent outer border, light text.
  look({
    id: 'tilt_sticker',
    fill: 'on_accent',
    background: { color: 'accent', alpha: 1, radius: 0.25, pad_x: 0.5, pad_y: 0.25 },
    tilt_deg: [-7, -5],
    text_fill: { kind: 'solid', color: 'on_accent' },
    box: {
      shape: 'rounded',
      fill: { kind: 'solid', color: 'accent', alpha: 1 },
      border: { color: 'paper', width: 0.06, ring: { color: 'accent', width: 0.07, gap: 0 } },
      radius: 0.25,
      padding: { x: 0.5, y: 0.25 },
      shadow: null,
      glow: null,
    },
    font: { family: 'sans', weight: 800 },
    case: 'as_written',
  }),
  // Sheet 2, Sky Blue: an accent rounded rectangle, a thin dark border, light text.
  look({
    id: 'solid_round',
    fill: 'on_accent',
    background: { color: 'accent', alpha: 1, radius: 0.3, pad_x: 0.5, pad_y: 0.22 },
    text_fill: { kind: 'solid', color: 'on_accent' },
    box: {
      shape: 'rounded',
      fill: { kind: 'solid', color: 'accent', alpha: 1 },
      border: { color: 'accent_dark', width: 0.03, ring: null },
      radius: 0.3,
      padding: { x: 0.5, y: 0.22 },
      shadow: null,
      glow: null,
    },
    case: 'as_written',
  }),
  // Sheet 2, Soft Pink: a pastel (light tint) pill, a thin dark border, dark text. The legacy twin has no light tint, so
  // its pill is paper (an installed phone resolves an unknown role to paper as well).
  look({
    id: 'pastel_pill',
    fill: 'accent_dark',
    background: { color: 'paper', alpha: 1, radius: 0.5, pad_x: 0.55, pad_y: 0.22 },
    text_fill: { kind: 'solid', color: 'accent_dark' },
    box: {
      shape: 'pill',
      fill: { kind: 'solid', color: 'accent_light', alpha: 1 },
      border: { color: 'accent_dark', width: 0.03, ring: null },
      radius: 0.5,
      padding: { x: 0.55, y: 0.22 },
      shadow: null,
      glow: null,
    },
    case: 'as_written',
  }),
  // Sheet 2, Teal Flat: an accent sharp rectangle, a thick black border, light text.
  look({
    id: 'flat_rect',
    fill: 'on_accent',
    background: { color: 'accent', alpha: 1, radius: 0, pad_x: 0.5, pad_y: 0.22 },
    text_fill: { kind: 'solid', color: 'on_accent' },
    box: {
      shape: 'sharp',
      fill: { kind: 'solid', color: 'accent', alpha: 1 },
      border: { color: 'ink', width: 0.08, ring: null },
      radius: 0,
      padding: { x: 0.5, y: 0.22 },
      shadow: null,
      glow: null,
    },
    case: 'as_written',
  }),
  // Sheet 2, Yellow Bold: an accent rounded rectangle, a black border, black heavy text.
  look({
    id: 'yellow_bold',
    fill: 'ink',
    background: { color: 'accent', alpha: 1, radius: 0.25, pad_x: 0.5, pad_y: 0.22 },
    text_fill: { kind: 'solid', color: 'ink' },
    box: {
      shape: 'rounded',
      fill: { kind: 'solid', color: 'accent', alpha: 1 },
      border: { color: 'ink', width: 0.06, ring: null },
      radius: 0.25,
      padding: { x: 0.5, y: 0.22 },
      shadow: null,
      glow: null,
    },
    font: { family: 'sans', weight: 800 },
    case: 'as_written',
  }),
  // Sheet 3, Charcoal Dark: a near black rounded rectangle, an accent border, accent text. Sheet 3 is set in another font,
  // so its two looks use the condensed family.
  look({
    id: 'dark_accent',
    fill: 'accent',
    background: { color: 'ink', alpha: 1, radius: 0.3, pad_x: 0.5, pad_y: 0.22 },
    text_fill: { kind: 'solid', color: 'accent' },
    box: {
      shape: 'rounded',
      fill: { kind: 'solid', color: 'ink', alpha: 1 },
      border: { color: 'accent', width: 0.08, ring: null },
      radius: 0.3,
      padding: { x: 0.5, y: 0.22 },
      shadow: null,
      glow: null,
    },
    font: { family: 'sans_condensed', weight: 700 },
    case: 'as_written',
  }),
  // Sheet 3, Coral Pop: an accent pill, a dark border, light text, in the same other font.
  look({
    id: 'coral_pill',
    fill: 'on_accent',
    background: { color: 'accent', alpha: 1, radius: 0.5, pad_x: 0.6, pad_y: 0.22 },
    text_fill: { kind: 'solid', color: 'on_accent' },
    box: {
      shape: 'pill',
      fill: { kind: 'solid', color: 'accent', alpha: 1 },
      border: { color: 'accent_dark', width: 0.05, ring: null },
      radius: 0.5,
      padding: { x: 0.6, y: 0.22 },
      shadow: null,
      glow: null,
    },
    font: { family: 'sans_condensed', weight: 700 },
    case: 'as_written',
  }),
];

// One look by id, or undefined. `looks` is the table to search (the shipped one unless a caller, such as a spec, brings its own).
export const textLookById = (id: string, looks: TextLook[] = TEXT_LOOKS) =>
  looks.find((entry) => entry.id === id);

// Whether a look draws a background behind its words: a `box` (card S8 looks) or a `bar` (the highlighter's marker).
export const hasBackground = (look: TextLook): boolean => !!look.box || !!look.bar;

// The look drawn in place of a look without a background (every text overlay has one): the table is exact and shared
// with the phone. A look not in it, without a background, is drawn as `solid_round`.
export const BOXED_LOOK: Record<string, string> = {
  sticker: 'tilt_sticker',
  '3d': 'gradient_block',
  glow: 'neon_box',
  gradient: 'gradient_block',
};
const DEFAULT_BOXED_LOOK = 'solid_round';

// The id of the look a text is drawn with: the look itself when it has a background (or is not in `looks`), else its
// entry of `BOXED_LOOK`, else `solid_round`.
export const boxedLookId = (id: string, looks: TextLook[] = TEXT_LOOKS): string => {
  const entry = textLookById(id, looks);
  return !entry || hasBackground(entry) ? id : (BOXED_LOOK[id] ?? DEFAULT_BOXED_LOOK);
};

// Whether a phone with these capabilities draws `look`: it listed the look and every feature the look needs (an absent
// or null `text_features` list means no feature). No capabilities at all means no gate (an unlisted plan context).
export const lookUsable = (
  look: TextLook | undefined,
  caps?: { text_styles: string[]; text_features?: string[] | null }
): boolean =>
  !!look &&
  (!caps ||
    (caps.text_styles.includes(look.id) &&
      requiredFeatures(look).every((feature) => (caps.text_features ?? []).includes(feature))));
