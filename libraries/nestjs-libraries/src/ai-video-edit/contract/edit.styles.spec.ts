// AI video editing (ai.video-editing): the look format of card S6 and the ten new looks of card S8. Every look states the
// legacy fields (installed phones) and the new blocks beside them; the new blocks of the six shipped looks draw what the
// legacy fields draw; the ten new looks are valid in the new format, readable (contrast), accepted by the strict reader of
// installed phones and sized for the fit estimate; the contract view serves both. Needs no database and no Nest.
import { isDeepStrictEqual } from 'util';
import { ColorRole, FillSpec, ShadowSpec, TextLook } from './edit.contract';
import { contractView } from './edit.contract.view';
import {
  BASELINE_EXTENT,
  BOXED_LOOK,
  boxedLookId,
  contrastRatio,
  hasBackground,
  lookContrast,
  lookExtent,
  lookSizeFactor,
  MIN_TEXT_CONTRAST,
  PALETTE,
  requiredFeatures,
  resolveRole,
  ROLE_DERIVATION,
  TEXT_FEATURES,
  TEXT_LAYER_ORDER,
  TEXT_LOOKS,
  textLookById,
} from './edit.styles';

// The six looks released before card S8 (the snapshot gate freezes them) and the ten of card S8.
const SHIPPED_IDS = ['sticker', 'label_pill', '3d', 'glow', 'gradient', 'highlighter'];
const NEW_IDS = [
  'neon_box', 'pill_ring', 'gradient_block', 'tilt_sticker', 'solid_round', 'pastel_pill', 'flat_rect', 'yellow_bold',
  'dark_accent', 'coral_pill',
];
const shipped = () => TEXT_LOOKS.filter((look) => SHIPPED_IDS.includes(look.id));
const added = () => TEXT_LOOKS.filter((look) => NEW_IDS.includes(look.id));

const ROLES: ColorRole[] = ['accent', 'accent_dark', 'accent_light', 'on_accent', 'ink', 'paper'];
const LEGACY_KEYS = ['id', 'fill', 'stroke', 'shadow', 'glow', 'extrude', 'background', 'bar', 'tilt_deg'];
const NEW_KEYS = ['text_fill', 'text_stroke', 'text_shadow', 'box', 'opacity', 'font', 'case', 'letter_spacing'];

const isRole = (value: unknown) => ROLES.includes(value as ColorRole);
const unit = (value: unknown) => typeof value === 'number' && value >= 0 && value <= 1;
const fraction = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Every colour role and number of a fill spec is valid.
const fillOk = (fill: FillSpec) =>
  fill.kind === 'solid'
    ? isRole(fill.color)
    : ['ltr', 'ttb', 'diag'].includes(fill.direction) && isRole(fill.from) && isRole(fill.to) && fill.from !== fill.to;

const shadowOk = (shadow: ShadowSpec) =>
  isRole(shadow.color) && unit(shadow.alpha) && fraction(shadow.blur) && Number.isFinite(shadow.dx) && Number.isFinite(shadow.dy);

describe('ai.video-editing: the look format (S6)', () => {
  it('has every legacy key and every new key on every look, `null` for off, and no other key', () => {
    for (const look of TEXT_LOOKS) {
      expect(Object.keys(look).sort()).toEqual([...LEGACY_KEYS, ...NEW_KEYS].sort());
      for (const key of ['stroke', 'shadow', 'glow', 'extrude', 'background', 'bar', 'tilt_deg', 'text_stroke', 'text_shadow', 'box']) {
        expect((look as unknown as Record<string, unknown>)[key]).not.toBeUndefined();
      }
    }
  });

  it('keeps every value of every new block valid: roles, ranges, family, weight, case, join, shape', () => {
    for (const look of TEXT_LOOKS) {
      expect(fillOk(look.text_fill)).toBe(true);
      if (look.text_stroke) {
        expect(isRole(look.text_stroke.color)).toBe(true);
        expect(look.text_stroke.width).toBeGreaterThan(0);
        expect(['round', 'miter', 'bevel']).toContain(look.text_stroke.join);
      }
      if (look.text_shadow) expect(shadowOk(look.text_shadow)).toBe(true);
      expect(unit(look.opacity)).toBe(true);
      expect(['sans', 'sans_condensed', 'serif', 'mono']).toContain(look.font.family);
      expect(Number.isInteger(look.font.weight / 100) && look.font.weight >= 100 && look.font.weight <= 900).toBe(true);
      expect(['as_written', 'upper']).toContain(look.case);
      expect(fraction(look.letter_spacing)).toBe(true);
      const box = look.box;
      if (box) {
        expect(['pill', 'rounded', 'sharp']).toContain(box.shape);
        expect(fillOk(box.fill)).toBe(true);
        expect(unit(box.fill.alpha)).toBe(true);
        expect(fraction(box.radius)).toBe(true);
        expect(box.shape === 'pill' ? box.radius === 0.5 : true).toBe(true);
        expect(box.shape === 'sharp' ? box.radius === 0 : true).toBe(true);
        expect(fraction(box.padding.x) && fraction(box.padding.y)).toBe(true);
        if (box.border) {
          expect(isRole(box.border.color) && box.border.width > 0).toBe(true);
          if (box.border.ring) {
            expect(isRole(box.border.ring.color) && box.border.ring.width > 0 && box.border.ring.gap >= 0).toBe(true);
          }
        }
        if (box.shadow) {
          expect(shadowOk(box.shadow)).toBe(true);
          expect(box.shadow.style === 'hard' ? box.shadow.blur === 0 : box.shadow.blur > 0).toBe(true);
        }
        if (box.glow) expect(isRole(box.glow.color) && unit(box.glow.alpha) && box.glow.blur > 0).toBe(true);
      }
    }
  });

  it('draws something readable: every look has a box fill, a text stroke or (the highlighter) a marker bar', () => {
    for (const look of TEXT_LOOKS) {
      expect(look.box !== null || look.text_stroke !== null || look.bar !== null).toBe(true);
    }
  });

  it('has a unique id on every look', () => {
    const ids = TEXT_LOOKS.map((look) => look.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ai.video-editing: the six shipped looks, legacy fields and new blocks', () => {
  // The legacy fields as shipped (the snapshot gate holds the full copy; this is what the new blocks are compared with).
  const legacy = (id: string) => textLookById(id) as TextLook;

  it('keep the legacy fields exactly (the strict reader of installed phones)', () => {
    expect(legacy('sticker')).toMatchObject({
      fill: 'accent', stroke: { color: 'ink', width: 0.14 },
      shadow: { color: 'ink', alpha: 1, dx: 0.05, dy: 0.06, blur: 0 }, tilt_deg: [-6, 6], background: null,
    });
    expect(legacy('label_pill')).toMatchObject({
      fill: 'on_accent', background: { color: 'accent', alpha: 1, radius: 0.5, pad_x: 0.35, pad_y: 0.2 },
      shadow: { color: 'ink', alpha: 0.35, dx: 0, dy: 0.04, blur: 0.08 }, stroke: null,
    });
    expect(legacy('gradient').fill).toEqual({ gradient: 'vertical', from: 'paper', to: 'accent' });
    expect(legacy('highlighter').bar).toEqual({ color: 'accent', alpha: 0.85, height: 0.55 });
    expect(legacy('3d').extrude).toEqual({ copies: 6, color: 'accent_dark', dx: 0.012, dy: 0.016 });
    expect(legacy('glow').glow).toEqual({ color: 'accent', alpha: 0.85, blur: 0.35 });
  });

  it('use only what the old strict reader accepts in the legacy fields (a vertical gradient, no new role)', () => {
    for (const look of TEXT_LOOKS) {
      const fill = look.fill;
      if (typeof fill !== 'string') expect(fill.gradient).toBe('vertical');
      const roles = JSON.stringify([look.fill, look.stroke, look.shadow, look.glow, look.extrude, look.background, look.bar]);
      expect(roles).not.toContain('accent_light');
    }
  });

  it('draw the same fill and stroke in the new blocks as in the legacy fields', () => {
    for (const look of shipped()) {
      const fill = look.fill;
      const expected: FillSpec =
        typeof fill === 'string'
          ? { kind: 'solid', color: fill }
          : { kind: 'gradient', direction: 'ttb', from: fill.from, to: fill.to };
      expect(look.text_fill).toEqual(expected);
      expect(look.text_stroke).toEqual(look.stroke ? { ...look.stroke, join: 'round' } : null);
    }
  });

  it('draw the legacy shadow once: as the text shadow, or as the box shadow where the look has a background', () => {
    for (const look of shipped()) {
      if (look.background) {
        expect(look.text_shadow).toBeNull();
        expect(look.box?.shadow).toEqual(look.shadow && { style: look.shadow.blur > 0 ? 'soft' : 'hard', ...look.shadow });
      } else {
        expect(look.text_shadow).toEqual(look.shadow);
        expect(look.box).toBeNull();
      }
    }
  });

  it('draw the legacy background as the box: same colour, alpha, radius and padding, pill shape for 0.5', () => {
    for (const look of shipped()) {
      const bg = look.background;
      if (!bg) continue;
      expect(look.box).toMatchObject({
        shape: 'pill',
        fill: { kind: 'solid', color: bg.color, alpha: bg.alpha },
        radius: bg.radius,
        padding: { x: bg.pad_x, y: bg.pad_y },
        border: null,
        glow: null,
      });
    }
  });

  it('draw the typography the installed phones draw: bold sans, case upper (Title Case) where the script has case, no spacing, opaque', () => {
    for (const look of shipped()) {
      expect(look.font).toEqual({ family: 'sans', weight: 700 });
      expect(look.case).toBe('upper');
      expect(look.letter_spacing).toBe(0);
      expect(look.opacity).toBe(1);
    }
  });

  it('need no feature, so a phone that lists none still gets them', () => {
    for (const look of shipped()) expect(requiredFeatures(look)).toEqual([]);
  });
});

describe('ai.video-editing: layer order, features and the new colour role', () => {
  it('exports the layer order, back to front', () => {
    expect(TEXT_LAYER_ORDER).toEqual([
      'box_shadow', 'box_fill', 'box_border', 'text_shadow', 'text_stroke', 'text_fill', 'glow',
    ]);
  });

  it('lists each feature once, and names the feature of every new-format property', () => {
    expect(new Set(TEXT_FEATURES).size).toBe(TEXT_FEATURES.length);
    const sticker = textLookById('sticker') as TextLook;
    const needs = (changes: Partial<TextLook>) => requiredFeatures({ ...sticker, ...changes });
    expect(needs({ text_fill: { kind: 'gradient', direction: 'ltr', from: 'paper', to: 'accent' } })).toEqual(['text_gradient_ltr']);
    expect(needs({ text_fill: { kind: 'gradient', direction: 'diag', from: 'paper', to: 'accent' } })).toEqual(['text_gradient_diag']);
    expect(needs({ text_stroke: { color: 'ink', width: 0.1, join: 'miter' } })).toEqual(['text_stroke_join']);
    expect(needs({ opacity: 0.9 })).toEqual(['opacity']);
    expect(needs({ font: { family: 'serif', weight: 400 } })).toEqual(['font_family', 'font_weight']);
    expect(needs({ case: 'as_written' })).toEqual(['case_as_written']);
    expect(needs({ letter_spacing: 0.05 })).toEqual(['letter_spacing']);
    const box = (textLookById('label_pill') as TextLook).box!;
    expect(needs({ box: { ...box, fill: { kind: 'gradient', direction: 'diag', from: 'accent', to: 'accent_dark', alpha: 1 } } })).toEqual(['box_gradient']);
    expect(needs({ box: { ...box, border: { color: 'ink', width: 0.05, ring: null }, glow: { color: 'accent', alpha: 0.8, blur: 0.3 } } })).toEqual(['box_border', 'box_glow']);
    expect(needs({ box: { ...box, border: { color: 'ink', width: 0.05, ring: { color: 'accent', width: 0.03, gap: 0.05 } } } })).toEqual(['box_border', 'box_border_ring']);
  });

  it('adds the role accent_light, derived from the accent for every palette mode', () => {
    expect(ROLES).toContain('accent_light');
    expect(ROLE_DERIVATION.accent_light.paper_share).toBeGreaterThan(0);
    expect(ROLE_DERIVATION.accent_light.paper_share).toBeLessThan(1);
    expect(ROLE_DERIVATION.accent_dark.factor).toBe(0.55);
  });
});

describe('ai.video-editing: the ten new looks (S8), schema', () => {
  it('adds exactly the ten looks after the six shipped ones, each once', () => {
    expect(TEXT_LOOKS.map((look) => look.id)).toEqual([...SHIPPED_IDS, ...NEW_IDS]);
    expect(added()).toHaveLength(10);
  });

  it('states every block of the new format, in valid values, and draws a box with a border', () => {
    for (const look of added()) {
      expect(look.box).not.toBeNull();
      expect(look.box?.border).not.toBeNull();
      expect(look.box!.fill.alpha).toBe(1);
      expect(look.case).toBe('as_written');
      expect(look.opacity).toBe(1);
      expect(look.text_fill.kind === 'solid' ? isRole(look.text_fill.color) : fillOk(look.text_fill)).toBe(true);
      // the legacy `background` is the flat twin of the box: same radius and padding
      expect(look.background).toMatchObject({
        radius: look.box!.radius,
        pad_x: look.box!.padding.x,
        pad_y: look.box!.padding.y,
      });
    }
  });

  it('shapes the box as the sheets do', () => {
    const box = (id: string) => (textLookById(id) as TextLook).box!;
    for (const id of ['pill_ring', 'pastel_pill', 'coral_pill']) expect(box(id).shape).toBe('pill');
    expect(box('flat_rect').shape).toBe('sharp');
    for (const id of ['neon_box', 'gradient_block', 'tilt_sticker', 'solid_round', 'yellow_bold', 'dark_accent']) {
      expect(box(id).shape).toBe('rounded');
    }
    expect(box('neon_box').glow).not.toBeNull();
    expect(box('neon_box').fill).toMatchObject({ kind: 'solid', color: 'ink' });
    expect(box('gradient_block').fill).toMatchObject({ kind: 'gradient', direction: 'ltr' });
    expect(box('gradient_block').shadow).toMatchObject({ style: 'hard', blur: 0 });
    expect(box('gradient_block').border?.width).toBeGreaterThanOrEqual(0.1);
    expect(box('tilt_sticker').border?.ring).not.toBeNull();
    expect((textLookById('tilt_sticker') as TextLook).tilt_deg).toEqual([-7, -5]);
    expect(box('solid_round').border?.width).toBeLessThanOrEqual(0.03);
    expect(box('flat_rect').border?.width).toBeGreaterThanOrEqual(0.08);
    expect(box('pastel_pill').fill).toMatchObject({ kind: 'solid', color: 'accent_light' });
    expect(box('dark_accent').fill).toMatchObject({ kind: 'solid', color: 'ink' });
    // sheet 3 is another font
    for (const id of ['dark_accent', 'coral_pill']) expect((textLookById(id) as TextLook).font.family).toBe('sans_condensed');
    for (const id of ['neon_box', 'pill_ring', 'solid_round', 'flat_rect']) expect((textLookById(id) as TextLook).font.family).toBe('sans');
  });

  it('computes the required features from the blocks, and every one needs a border and the written case', () => {
    for (const look of added()) {
      expect(requiredFeatures(look)).toEqual(expect.arrayContaining(['box_border', 'case_as_written']));
    }
    const needs = (id: string) => requiredFeatures(textLookById(id) as TextLook);
    expect(needs('neon_box')).toEqual(['box_border', 'box_glow', 'font_weight', 'case_as_written']);
    expect(needs('gradient_block')).toEqual(['box_gradient', 'box_border', 'font_weight', 'case_as_written']);
    expect(needs('tilt_sticker')).toEqual(['box_border', 'box_border_ring', 'font_weight', 'case_as_written']);
    expect(needs('dark_accent')).toEqual(['box_border', 'font_family', 'case_as_written']);
    expect(needs('solid_round')).toEqual(['box_border', 'case_as_written']);
    for (const look of added()) for (const feature of requiredFeatures(look)) expect(TEXT_FEATURES).toContain(feature);
  });

  it('keeps colour roles only (no fixed colour) and the shipped looks free of every feature', () => {
    expect(JSON.stringify(added())).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    for (const look of shipped()) expect(requiredFeatures(look)).toEqual([]);
  });
});

describe('ai.video-editing: the ten new looks (S8), contrast', () => {
  it('resolves the roles of an accent as the contract says', () => {
    expect(resolveRole('accent', '#FF3B30')).toBe('#FF3B30');
    expect(resolveRole('ink', '#FF3B30')).toBe(PALETTE.ink);
    expect(resolveRole('paper', '#FF3B30')).toBe(PALETTE.paper);
    expect(resolveRole('accent_dark', '#FFFFFF')).toBe('#8c8c8c');
    expect(resolveRole('accent_light', '#000000')).toBe('#a6a6a6');
    expect(resolveRole('on_accent', '#FFD60A')).toBe(PALETTE.ink);
    expect(resolveRole('on_accent', '#102A43')).toBe(PALETTE.paper);
  });

  it('measures the contrast ratio on the WCAG scale', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    expect(contrastRatio('#ffffff', '#000000')).toBe(contrastRatio('#000000', '#ffffff'));
  });

  it('keeps the text of every new look at the minimum contrast on its box fill, for every accent of the palette', () => {
    for (const look of added()) {
      for (const accent of PALETTE.multi) {
        const ratio = lookContrast(look, accent) as number;
        expect(`${look.id} ${accent} ${ratio >= MIN_TEXT_CONTRAST}`).toBe(`${look.id} ${accent} true`);
      }
    }
  });

  it('keeps the looks built from a role pair the contrast cannot fail on readable for any accent (brand colours too)', () => {
    // text `on_accent` on an `accent` fill, and `accent_dark` on `accent_light`, hold for every colour, dark or light
    const anyAccent = ['#000000', '#FFFFFF', '#102A43', '#FFD60A', '#808080', '#7A1F1F'];
    for (const id of ['pill_ring', 'tilt_sticker', 'solid_round', 'flat_rect', 'coral_pill', 'pastel_pill']) {
      for (const accent of anyAccent) {
        expect(lookContrast(textLookById(id) as TextLook, accent) as number).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    }
  });

  it('is null for a look without a box and fails for text that does not read on its fill', () => {
    expect(lookContrast(textLookById('sticker') as TextLook, '#FF3B30')).toBeNull();
    const unreadable: TextLook = { ...(textLookById('pill_ring') as TextLook), text_fill: { kind: 'solid', color: 'accent' } };
    expect(lookContrast(unreadable, '#FF3B30') as number).toBeLessThan(MIN_TEXT_CONTRAST);
  });
});

describe('ai.video-editing: the ten new looks (S8), the strict reader of installed phones', () => {
  // `TextLook.fromJson` of the phone: the legacy keys must be present (null = off), `fill` a role string or a `vertical`
  // gradient with `from` and `to`, every part an object with its numbers, `tilt_deg` null or two numbers.
  const strictReader = (json: Record<string, unknown>) => {
    const errors: string[] = [];
    const must = (condition: boolean, message: string) => condition || errors.push(message);
    must(typeof json.id === 'string', 'id');
    const fill = json.fill as Record<string, unknown> | string;
    if (fill !== null && typeof fill === 'object') {
      must(fill.gradient === 'vertical', 'gradient is not vertical');
      must(typeof fill.from === 'string' && typeof fill.to === 'string', 'gradient stops');
    } else {
      must(typeof fill === 'string', 'fill');
    }
    const shapes: Record<string, string[]> = {
      stroke: ['color', 'width'],
      shadow: ['color', 'alpha', 'dx', 'dy', 'blur'],
      glow: ['color', 'alpha', 'blur'],
      extrude: ['copies', 'color', 'dx', 'dy'],
      background: ['color', 'alpha', 'radius', 'pad_x', 'pad_y'],
      bar: ['color', 'alpha', 'height'],
    };
    for (const [key, fields] of Object.entries(shapes)) {
      must(key in json, `missing ${key}`);
      const part = json[key] as Record<string, unknown> | null;
      if (part === null || part === undefined) continue;
      for (const field of fields) {
        must(field in part, `${key}.${field}`);
        must(field === 'color' ? typeof part[field] === 'string' : typeof part[field] === 'number', `${key}.${field} type`);
      }
    }
    must('tilt_deg' in json, 'missing tilt_deg');
    const tilt = json.tilt_deg as number[] | null;
    must(tilt === null || (Array.isArray(tilt) && tilt.length === 2 && tilt.every((n) => typeof n === 'number')), 'tilt');
    return errors;
  };

  it('accepts the legacy fields of every look, shipped and new, as served', () => {
    for (const look of TEXT_LOOKS) {
      const served = JSON.parse(JSON.stringify(contractView().text_styles.find((entry) => entry.id === look.id)));
      expect(strictReader(served)).toEqual([]);
    }
  });

  it('refuses what the old reader refuses, so the check can fail', () => {
    const base = JSON.parse(JSON.stringify(textLookById('pill_ring')));
    expect(strictReader({ ...base, fill: { gradient: 'ltr', from: 'accent', to: 'paper' } })).toEqual(['gradient is not vertical']);
    const { glow, ...withoutGlow } = base;
    expect(glow).toBeNull();
    expect(strictReader(withoutGlow)).toEqual(['missing glow']);
    expect(strictReader({ ...base, tilt_deg: [1] })).toEqual(['tilt']);
  });

  it('keeps a vertical gradient or a role in `fill`, never a box gradient or a new direction, and no new role in a legacy field', () => {
    for (const look of added()) {
      if (typeof look.fill !== 'string') expect(look.fill.gradient).toBe('vertical');
      const legacy = JSON.stringify([look.fill, look.stroke, look.shadow, look.glow, look.extrude, look.background, look.bar]);
      expect(legacy).not.toContain('accent_light');
      expect(look.stroke).toBeNull();
    }
    // the gradient of the sunset box has no legacy twin: the old fields keep the flat accent and the hard shadow
    const sunset = textLookById('gradient_block') as TextLook;
    expect(sunset.background).toMatchObject({ color: 'accent' });
    expect(sunset.shadow).toMatchObject({ dx: 0.1, dy: 0.1, blur: 0 });
  });

  it('gives the old reader a text colour that reads on the flat twin of the box', () => {
    // the legacy fill is a role the old phone knows, and not the role of the flat background (text on its own colour)
    for (const look of added()) {
      expect(typeof look.fill === 'string' && look.fill !== look.background?.color).toBe(true);
    }
  });
});

describe('ai.video-editing: the ten new looks (S8), size factors', () => {
  it('measures what the box, border, ring, shadow and glow add around the text, in `s`', () => {
    const extent = (id: string) => lookExtent(textLookById(id) as TextLook);
    expect(extent('label_pill').x).toBeCloseTo(0.7, 9);
    expect(extent('label_pill').y).toBeCloseTo(0.44, 9);
    // neon_box: 2 x (0.45 + 0.06) + glow 0.35 wide, 2 x (0.22 + 0.06) + 0.35 tall
    expect(extent('neon_box').x).toBeCloseTo(1.37, 9);
    expect(extent('neon_box').y).toBeCloseTo(0.91, 9);
    // tilt_sticker counts the border and the ring outside it
    expect(extent('tilt_sticker').x).toBeCloseTo(2 * (0.5 + 0.06 + 0.07), 9);
    // gradient_block counts the hard offset block
    expect(extent('gradient_block').x).toBeCloseTo(2 * (0.5 + 0.1) + 0.1, 9);
    // a look with no box adds its stroke and shadow offset
    expect(extent('sticker').x).toBeCloseTo(0.14 + 0.05, 9);
    expect(extent('highlighter')).toEqual({ x: 0, y: 0 });
  });

  it('gives no factor to a look inside the baseline of the estimate, so the shipped looks never change their placement', () => {
    for (const look of shipped()) expect(lookSizeFactor(look)).toEqual({ w: 0, h: 0 });
    expect(BASELINE_EXTENT.x).toBeGreaterThanOrEqual(lookExtent(textLookById('label_pill') as TextLook).x);
    expect(BASELINE_EXTENT.y).toBeGreaterThanOrEqual(lookExtent(textLookById('label_pill') as TextLook).y);
  });

  it('gives every new look the room its box takes beyond the baseline, never negative', () => {
    for (const look of added()) {
      const factor = lookSizeFactor(look);
      const extent = lookExtent(look);
      expect(factor.w).toBeGreaterThanOrEqual(0);
      expect(factor.h).toBeGreaterThanOrEqual(0);
      expect(factor.w).toBeCloseTo(Math.max(0, extent.x - BASELINE_EXTENT.x), 3);
      expect(factor.h).toBeCloseTo(Math.max(0, extent.y - BASELINE_EXTENT.y), 3);
    }
    expect(lookSizeFactor(textLookById('neon_box') as TextLook)).toEqual({ w: 0.57, h: 0.41 });
    expect(lookSizeFactor(textLookById('solid_round') as TextLook)).toEqual({ w: 0.26, h: 0 });
    expect(lookSizeFactor(textLookById('gradient_block') as TextLook).w).toBeGreaterThan(0.4);
  });
});

describe('ai.video-editing: contractView serves the old and the new format', () => {
  const view = contractView();

  it('serves every look with its legacy fields and its new blocks, equal to the tables', () => {
    expect(view.text_styles).toEqual(JSON.parse(JSON.stringify(TEXT_LOOKS)));
    for (const served of view.text_styles) {
      for (const key of [...LEGACY_KEYS, ...NEW_KEYS]) expect(Object.prototype.hasOwnProperty.call(served, key)).toBe(true);
    }
  });

  it('serves the layer order, the feature ids and the role derivation, and stays at contract version 2', () => {
    expect(view.text_layer_order).toEqual(TEXT_LAYER_ORDER);
    expect(view.text_features).toEqual(TEXT_FEATURES);
    expect(isDeepStrictEqual(view.color_roles, ROLE_DERIVATION)).toBe(true);
    expect(view.contract_version).toBe(2);
  });

  it('keeps colour roles only, never a fixed colour, in the looks', () => {
    expect(JSON.stringify(view.text_styles)).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});

describe('ai.video-editing: every text look has a background (TS13)', () => {
  it('says a look has a background when it has a box or a bar, and only those without one are mapped', () => {
    expect(TEXT_LOOKS.filter((look) => !hasBackground(look)).map((look) => look.id)).toEqual(['sticker', '3d', 'glow', 'gradient']);
    expect(hasBackground(textLookById('highlighter') as TextLook)).toBe(true);
    expect(hasBackground(textLookById('label_pill') as TextLook)).toBe(true);
    for (const look of added()) expect(hasBackground(look)).toBe(true);
    expect(Object.keys(BOXED_LOOK).sort()).toEqual(['3d', 'glow', 'gradient', 'sticker']);
  });

  it('maps a look without a background exactly as the phone does, and keeps every other look', () => {
    expect(boxedLookId('sticker')).toBe('tilt_sticker');
    expect(boxedLookId('3d')).toBe('gradient_block');
    expect(boxedLookId('glow')).toBe('neon_box');
    expect(boxedLookId('gradient')).toBe('gradient_block');
    for (const look of TEXT_LOOKS.filter(hasBackground)) expect(boxedLookId(look.id)).toBe(look.id);
    expect(boxedLookId('highlighter')).toBe('highlighter');
  });

  it('maps to looks that exist and have a background, and any other look without one to solid_round', () => {
    for (const target of Object.values(BOXED_LOOK)) {
      const look = textLookById(target);
      expect(look).toBeDefined();
      expect(hasBackground(look as TextLook)).toBe(true);
    }
    const bare = { ...(textLookById('sticker') as TextLook), id: 'bare_look' };
    expect(boxedLookId('bare_look', [...TEXT_LOOKS, bare])).toBe('solid_round');
    expect(boxedLookId('unlisted_look')).toBe('unlisted_look');
  });
});
