// AI video editing (ai.video-editing): the look conformance vectors of card S7. The phone's tests come from the same table
// as the server's looks: for every look, the facts that must hold when the phone draws it (layers and their order, gradient
// direction with two sample points, shadow offset, stroke width, a box that contains the text plus its padding, ...) and, per
// probe string of the string matrix, the text it must draw. The server never measures text, so every fact is relative to
// the measured text box (the phone measures) and to `s`, the text size: `*_s` values are fractions of `s`, sample points are
// fractions of the box they sit in. Pure: no Nest, no Prisma, no measuring.
import { ColorRole, FillSpec, GradientDirection, ShadowSpec, TextCase, TextLayer, TextLook } from './edit.contract';
import { TEXT_LAYER_ORDER, TEXT_LOOKS } from './edit.styles';
import { MatrixString, STRING_MATRIX } from './edit.strings';
import { drawnText } from './edit.case';

// The scripts whose letters join or reorder: the phone draws them with letter spacing 0 (a spaced Arabic word breaks its
// joins, a spaced conjunct falls apart). A data table of Unicode script names, not a language check.
export const NO_SPACING_SCRIPTS = [
  'Arabic', 'Syriac', 'Mongolian', 'Nko', 'Bengali', 'Devanagari', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu',
  'Kannada', 'Malayalam', 'Sinhala', 'Khmer', 'Myanmar', 'Thai', 'Lao',
];
const NO_SPACING = new RegExp(NO_SPACING_SCRIPTS.map((script) => `\\p{Script=${script}}`).join('|'), 'u');

// A point inside the box a fill spans, as fractions from its left and top edge.
export interface GradientSample {
  at: { x: number; y: number };
  // The colour at this point is the one nearer to this stop.
  is: 'from' | 'to';
}

// A fill as a vector: a solid colour, or a gradient with two sample points that differ along the gradient's direction
// (the phone checks the colour at `samples[0]` is nearer `from` and at `samples[1]` nearer `to`).
export type FillVector =
  | { kind: 'solid'; color: ColorRole }
  | { kind: 'gradient'; direction: GradientDirection; from: ColorRole; to: ColorRole; samples: [GradientSample, GradientSample] };

// One fact. `fields` names the `TextLook` fields it exercises (gate 2: a field with no fact fails the spec); `legacy`
// facts restate what an old field draws.
export type LookFact = { fields: Array<keyof TextLook> } & (
  // The layers this look draws, back to front (`TEXT_LAYER_ORDER` order); a layer not listed must not be drawn.
  | { kind: 'layers'; draws: TextLayer[] }
  // Text fill spans the measured text box.
  | { kind: 'text_fill'; fill: FillVector }
  // Stroke thickness in pixels is `width_s * s`.
  | { kind: 'text_stroke'; color: ColorRole; width_s: number; join: string }
  // The shadow is the text shifted by (`dx_s * s`, `dy_s * s`); `hard` (blur 0) is an unblurred copy.
  | { kind: 'text_shadow'; color: ColorRole; alpha: number; dx_s: number; dy_s: number; blur_s: number; hard: boolean }
  // The box contains the measured text box grown by the padding on every side: left and right `padding_s.x * s`,
  // top and bottom `padding_s.y * s`. The corner radius in pixels is `radius_of_height * box height`.
  | {
      kind: 'box';
      shape: string;
      radius_of_height: number;
      padding_s: { x: number; y: number };
      contains_text_with_inset_s: { left: number; right: number; top: number; bottom: number };
    }
  // The box fill spans the box rect.
  | { kind: 'box_fill'; fill: FillVector; alpha: number }
  // The border sits on the box edge, `width_s * s` thick; a ring is a second outline `gap_s * s` outside it.
  | {
      kind: 'box_border';
      color: ColorRole;
      width_s: number;
      ring: { color: ColorRole; width_s: number; gap_s: number } | null;
    }
  | { kind: 'box_shadow'; style: string; color: ColorRole; alpha: number; dx_s: number; dy_s: number; blur_s: number }
  | { kind: 'box_glow'; color: ColorRole; alpha: number; blur_s: number }
  // Legacy glow around the text, drawn last (the `glow` layer).
  | { kind: 'glow'; color: ColorRole; alpha: number; blur_s: number }
  // Legacy 3D: `copies` copies of the text, each shifted by (`dx_s * s`, `dy_s * s`) more than the one before it.
  | { kind: 'extrude'; copies: number; color: ColorRole; dx_s: number; dy_s: number }
  // Legacy marker bar behind the text, `height_of_line` of the line height, swept left to right during the entry.
  | { kind: 'bar'; color: ColorRole; alpha: number; height_of_line: number }
  // The whole overlay rotates by a value inside this range (the item's `params.tilt_deg` picks one).
  | { kind: 'tilt'; range_deg: [number, number] }
  | { kind: 'opacity'; value: number }
  | { kind: 'font'; family: string; weight: number }
  | { kind: 'case'; mode: TextCase }
  | { kind: 'letter_spacing'; spacing_s: number }
);

// What the phone must draw for one probe string with this look.
export interface ProbeVector {
  probe: string;
  text: string;
  language: string;
  // Reading direction of the text; wrapped lines stay centred in either.
  direction: 'ltr' | 'rtl';
  // The text after the look's `case`: Title Case in the plan language for `upper` (the enum value keeps its name; owner
  // decision 2026-11-20), the text as written for `as_written` and for scripts without case.
  text_drawn: string;
  // The letter spacing in effect: the look's, or 0 for a text with a script that joins or reorders its letters.
  letter_spacing_s: number;
}

export interface LookVectors {
  look: string;
  facts: LookFact[];
  probes: ProbeVector[];
}

// Two sample points that differ along the direction, away from the edges so an edge pixel never decides.
const SAMPLES: Record<GradientDirection, [GradientSample['at'], GradientSample['at']]> = {
  ltr: [{ x: 0.05, y: 0.5 }, { x: 0.95, y: 0.5 }],
  ttb: [{ x: 0.5, y: 0.05 }, { x: 0.5, y: 0.95 }],
  diag: [{ x: 0.05, y: 0.05 }, { x: 0.95, y: 0.95 }],
};

const fillVector = (fill: FillSpec): FillVector =>
  fill.kind === 'solid'
    ? { kind: 'solid', color: fill.color }
    : {
        kind: 'gradient',
        direction: fill.direction,
        from: fill.from,
        to: fill.to,
        samples: [
          { at: SAMPLES[fill.direction][0], is: 'from' },
          { at: SAMPLES[fill.direction][1], is: 'to' },
        ],
      };

const shadowFacts = (shadow: ShadowSpec) => ({
  color: shadow.color,
  alpha: shadow.alpha,
  dx_s: shadow.dx,
  dy_s: shadow.dy,
  blur_s: shadow.blur,
});

// The layers `look` draws, in `TEXT_LAYER_ORDER`: a layer is drawn when its block is on (the glow layer by either glow).
const drawnLayers = (look: TextLook): TextLayer[] => {
  const on: Record<TextLayer, boolean> = {
    box_shadow: !!look.box?.shadow,
    box_fill: !!look.box,
    box_border: !!look.box?.border,
    text_shadow: !!look.text_shadow,
    text_stroke: !!look.text_stroke,
    text_fill: true,
    glow: !!look.glow || !!look.box?.glow,
  };
  return TEXT_LAYER_ORDER.filter((layer) => on[layer]);
};

// The fields whose blocks are drawn as a layer of this look (a block that is off adds none).
const layerFields = (look: TextLook): Array<keyof TextLook> => {
  const fields: Array<keyof TextLook> = ['text_fill'];
  if (look.text_stroke) fields.push('text_stroke');
  if (look.text_shadow) fields.push('text_shadow');
  if (look.box) fields.push('box');
  if (look.glow) fields.push('glow');
  return fields;
};

// The facts of one look, from its blocks only: a block that is off gives no fact (its layer is absent from `layers`).
const lookFacts = (look: TextLook): LookFact[] => {
  const facts: LookFact[] = [
    { kind: 'layers', fields: layerFields(look), draws: drawnLayers(look) },
    { kind: 'text_fill', fields: ['text_fill', 'fill'], fill: fillVector(look.text_fill) },
  ];
  if (look.text_stroke) {
    const { color, width, join } = look.text_stroke;
    facts.push({ kind: 'text_stroke', fields: ['text_stroke', 'stroke'], color, width_s: width, join });
  }
  if (look.text_shadow) {
    facts.push({
      kind: 'text_shadow', fields: ['text_shadow', 'shadow'], ...shadowFacts(look.text_shadow), hard: look.text_shadow.blur === 0,
    });
  }
  const { box } = look;
  if (box) {
    const { x, y } = box.padding;
    facts.push({
      kind: 'box',
      fields: ['box', 'background'],
      shape: box.shape,
      radius_of_height: box.radius,
      padding_s: { x, y },
      contains_text_with_inset_s: { left: x, right: x, top: y, bottom: y },
    });
    facts.push({ kind: 'box_fill', fields: ['box'], fill: fillVector(box.fill), alpha: box.fill.alpha });
    if (box.border) {
      const { color, width, ring } = box.border;
      facts.push({
        kind: 'box_border',
        fields: ['box'],
        color,
        width_s: width,
        ring: ring && { color: ring.color, width_s: ring.width, gap_s: ring.gap },
      });
    }
    if (box.shadow) {
      facts.push({ kind: 'box_shadow', fields: ['box', 'shadow'], style: box.shadow.style, ...shadowFacts(box.shadow) });
    }
    if (box.glow) {
      facts.push({ kind: 'box_glow', fields: ['box'], color: box.glow.color, alpha: box.glow.alpha, blur_s: box.glow.blur });
    }
  }
  if (look.glow) {
    facts.push({ kind: 'glow', fields: ['glow'], color: look.glow.color, alpha: look.glow.alpha, blur_s: look.glow.blur });
  }
  if (look.extrude) {
    const { copies, color, dx, dy } = look.extrude;
    facts.push({ kind: 'extrude', fields: ['extrude'], copies, color, dx_s: dx, dy_s: dy });
  }
  if (look.bar) {
    const { color, alpha, height } = look.bar;
    facts.push({ kind: 'bar', fields: ['bar'], color, alpha, height_of_line: height });
  }
  if (look.tilt_deg) facts.push({ kind: 'tilt', fields: ['tilt_deg'], range_deg: look.tilt_deg });
  facts.push({ kind: 'opacity', fields: ['opacity'], value: look.opacity });
  facts.push({ kind: 'font', fields: ['font'], family: look.font.family, weight: look.font.weight });
  facts.push({ kind: 'case', fields: ['case'], mode: look.case });
  facts.push({ kind: 'letter_spacing', fields: ['letter_spacing'], spacing_s: look.letter_spacing });
  return facts;
};

const probeVector = (look: TextLook, probe: MatrixString): ProbeVector => ({
  probe: probe.id,
  text: probe.text,
  language: probe.language,
  direction: probe.rtl ? 'rtl' : 'ltr',
  text_drawn: drawnText(probe.text, look.case, probe.language),
  letter_spacing_s: NO_SPACING.test(probe.text) ? 0 : look.letter_spacing,
});

// The vectors of one look: its facts (relative to the measured text box and `s`) and one entry per probe string.
export const lookVectors = (look: TextLook, probes: MatrixString[] = STRING_MATRIX): LookVectors => ({
  look: look.id,
  facts: lookFacts(look),
  probes: probes.map((probe) => probeVector(look, probe)),
});

// The vectors of every look in the table, in table order (what the contract serves as `look_vectors`).
export const allLookVectors = (looks: TextLook[] = TEXT_LOOKS): LookVectors[] => looks.map((look) => lookVectors(look));
