// AI video editing (ai.video-editing): the look conformance vectors of card S7. The vectors come from the look table, so a
// property cannot be forgotten: a spec fails when a `TextLook` field has no vector (gate 2). Needs no database and no Nest.
import { TextLook } from './edit.contract';
import { contractView } from './edit.contract.view';
import { STRING_MATRIX } from './edit.strings';
import { TEXT_LAYER_ORDER, TEXT_LOOKS, textLookById } from './edit.styles';
import { allLookVectors, LookFact, lookVectors } from './edit.vectors';
import { titleCase } from './edit.case';

const look = (id: string) => textLookById(id) as TextLook;
const factsOf = (value: TextLook, kind: LookFact['kind']) => lookVectors(value).facts.filter((fact) => fact.kind === kind);
const factOf = <K extends LookFact['kind']>(value: TextLook, kind: K) =>
  factsOf(value, kind)[0] as Extract<LookFact, { kind: K }>;

// Every field of the look table (all keys but the id), and the ones no vector of any look exercises.
const lookFields = (looks: TextLook[]) => [...new Set(looks.flatMap((entry) => Object.keys(entry)))].filter((key) => key !== 'id');
const uncoveredFields = (looks: TextLook[]) => {
  const covered = new Set(looks.flatMap((entry) => lookVectors(entry).facts.flatMap((fact) => fact.fields as string[])));
  return lookFields(looks).filter((field) => !covered.has(field));
};

// A look that switches on every block the six shipped looks leave off: gradients, border with a ring, hard box shadow,
// box glow, mitred stroke, as written case, spacing, a serif at weight 400, partial opacity.
const rich: TextLook = {
  ...look('label_pill'),
  id: 'rich',
  text_fill: { kind: 'gradient', direction: 'diag', from: 'paper', to: 'accent_light' },
  text_stroke: { color: 'ink', width: 0.08, join: 'miter' },
  text_shadow: { color: 'ink', alpha: 0.5, dx: 0.03, dy: 0.04, blur: 0.02 },
  box: {
    shape: 'rounded',
    fill: { kind: 'gradient', direction: 'ltr', from: 'accent', to: 'accent_dark', alpha: 0.9 },
    border: { color: 'paper', width: 0.05, ring: { color: 'accent', width: 0.03, gap: 0.06 } },
    radius: 0.25,
    padding: { x: 0.4, y: 0.25 },
    shadow: { style: 'hard', color: 'ink', alpha: 1, dx: 0.06, dy: 0.06, blur: 0 },
    glow: { color: 'accent', alpha: 0.7, blur: 0.3 },
  },
  opacity: 0.9,
  font: { family: 'serif', weight: 400 },
  case: 'as_written',
  letter_spacing: 0.05,
};

describe('ai.video-editing: look vectors, gate 2 (every field has a vector)', () => {
  it('exercises every field of the look table with at least one vector', () => {
    expect(lookFields(TEXT_LOOKS)).toEqual(expect.arrayContaining([
      'text_fill', 'text_stroke', 'text_shadow', 'box', 'opacity', 'font', 'case', 'letter_spacing',
    ]));
    expect(uncoveredFields(TEXT_LOOKS)).toEqual([]);
  });

  it('fails for a field that no vector exercises (a new field added to the look table)', () => {
    const withNewField = { ...look('sticker'), sparkle: { amount: 1 } } as unknown as TextLook;
    expect(uncoveredFields([withNewField])).toContain('sparkle');
    expect(uncoveredFields([withNewField, look('3d'), look('glow'), look('highlighter'), look('label_pill')])).toEqual(['sparkle']);
  });

  it('names only real fields of the look table in every fact', () => {
    const fields = lookFields(TEXT_LOOKS);
    for (const entry of [...TEXT_LOOKS, rich]) {
      for (const fact of lookVectors(entry).facts) {
        expect(fact.fields.length).toBeGreaterThan(0);
        fact.fields.forEach((field) => expect(fields).toContain(field));
      }
    }
  });

  it('gives the rich look a vector for every block it switches on', () => {
    // Only the legacy blocks the rich look leaves off have no vector in it.
    expect(uncoveredFields([rich])).toEqual(['glow', 'extrude', 'bar', 'tilt_deg']);
    const kinds = lookVectors(rich).facts.map((fact) => fact.kind);
    expect(kinds).toEqual([
      'layers', 'text_fill', 'text_stroke', 'text_shadow', 'box', 'box_fill', 'box_border', 'box_shadow', 'box_glow',
      'opacity', 'font', 'case', 'letter_spacing',
    ]);
  });
});

describe('ai.video-editing: look vectors, layers and order', () => {
  it('lists the drawn layers back to front in the layer order, one per block that is on', () => {
    for (const entry of TEXT_LOOKS) {
      const { draws } = factOf(entry, 'layers');
      expect(draws).toEqual(TEXT_LAYER_ORDER.filter((layer) => draws.includes(layer)));
      expect(draws).toContain('text_fill');
      expect(draws.includes('text_stroke')).toBe(entry.text_stroke !== null);
      expect(draws.includes('text_shadow')).toBe(entry.text_shadow !== null);
      expect(draws.includes('box_fill')).toBe(entry.box !== null);
      expect(draws.includes('glow')).toBe(entry.glow !== null);
    }
    expect(factOf(look('sticker'), 'layers').draws).toEqual(['text_shadow', 'text_stroke', 'text_fill']);
    expect(factOf(look('label_pill'), 'layers').draws).toEqual(['box_shadow', 'box_fill', 'text_fill']);
    expect(factOf(look('glow'), 'layers').draws).toEqual(['text_stroke', 'text_fill', 'glow']);
    expect(factOf(rich, 'layers').draws).toEqual([...TEXT_LAYER_ORDER]);
  });
});

describe('ai.video-editing: look vectors, gradients, shadows, strokes and the box', () => {
  it('gives a gradient two sample points that differ along its direction, from stop first', () => {
    const fills = [
      factOf(look('gradient'), 'text_fill').fill,
      factOf(rich, 'text_fill').fill,
      factOf(rich, 'box_fill').fill,
    ];
    expect(fills.map((fill) => fill.kind === 'gradient' && fill.direction)).toEqual(['ttb', 'diag', 'ltr']);
    for (const fill of fills) {
      if (fill.kind !== 'gradient') throw new Error('expected a gradient');
      const [from, to] = fill.samples;
      expect([from.is, to.is]).toEqual(['from', 'to']);
      const dx = to.at.x - from.at.x;
      const dy = to.at.y - from.at.y;
      expect(Math.hypot(dx, dy)).toBeGreaterThan(0.5);
      if (fill.direction === 'ltr') expect([dx > 0, dy]).toEqual([true, 0]);
      if (fill.direction === 'ttb') expect([dx, dy > 0]).toEqual([0, true]);
      if (fill.direction === 'diag') expect([dx > 0, dy > 0]).toEqual([true, true]);
      for (const sample of [from, to]) {
        expect(sample.at.x).toBeGreaterThan(0);
        expect(sample.at.x).toBeLessThan(1);
        expect(sample.at.y).toBeGreaterThan(0);
        expect(sample.at.y).toBeLessThan(1);
      }
    }
  });

  it('gives a solid fill no sample points', () => {
    expect(factOf(look('sticker'), 'text_fill').fill).toEqual({ kind: 'solid', color: 'accent' });
  });

  it('states the text shadow offset as a fraction of s, hard when the blur is 0', () => {
    expect(factOf(look('sticker'), 'text_shadow')).toMatchObject({ color: 'ink', alpha: 1, dx_s: 0.05, dy_s: 0.06, blur_s: 0, hard: true });
    expect(factOf(rich, 'text_shadow')).toMatchObject({ dx_s: 0.03, dy_s: 0.04, blur_s: 0.02, hard: false });
    expect(factsOf(look('3d'), 'text_shadow')).toEqual([]);
  });

  it('states the stroke width as a fraction of s, with its join', () => {
    expect(factOf(look('sticker'), 'text_stroke')).toMatchObject({ color: 'ink', width_s: 0.14, join: 'round' });
    expect(factOf(look('3d'), 'text_stroke')).toMatchObject({ width_s: 0.06 });
    expect(factOf(rich, 'text_stroke')).toMatchObject({ width_s: 0.08, join: 'miter' });
    expect(factsOf(look('highlighter'), 'text_stroke')).toEqual([]);
  });

  it('makes the box contain the measured text plus its padding, relative to the text box', () => {
    for (const entry of [look('label_pill'), rich]) {
      const box = factOf(entry, 'box');
      expect(box.contains_text_with_inset_s).toEqual({
        left: box.padding_s.x, right: box.padding_s.x, top: box.padding_s.y, bottom: box.padding_s.y,
      });
      expect(box.padding_s.x).toBeGreaterThan(0);
      expect(box.padding_s.y).toBeGreaterThan(0);
    }
    expect(factOf(look('label_pill'), 'box')).toMatchObject({ shape: 'pill', radius_of_height: 0.5, padding_s: { x: 0.35, y: 0.2 } });
    expect(factOf(rich, 'box')).toMatchObject({ shape: 'rounded', radius_of_height: 0.25 });
    expect(factsOf(look('sticker'), 'box')).toEqual([]);
  });

  it('states the box fill, border with its ring, shadow and glow', () => {
    expect(factOf(look('label_pill'), 'box_fill')).toMatchObject({ alpha: 1, fill: { kind: 'solid', color: 'accent' } });
    expect(factOf(look('label_pill'), 'box_shadow')).toMatchObject({ style: 'soft', alpha: 0.35, dx_s: 0, dy_s: 0.04, blur_s: 0.08 });
    expect(factsOf(look('label_pill'), 'box_border')).toEqual([]);
    expect(factOf(rich, 'box_fill').alpha).toBe(0.9);
    expect(factOf(rich, 'box_border')).toMatchObject({ width_s: 0.05, ring: { color: 'accent', width_s: 0.03, gap_s: 0.06 } });
    expect(factOf(rich, 'box_shadow')).toMatchObject({ style: 'hard', dx_s: 0.06, dy_s: 0.06, blur_s: 0 });
    expect(factOf(rich, 'box_glow')).toMatchObject({ alpha: 0.7, blur_s: 0.3 });
  });

  it('keeps the legacy glow, extrude, bar and tilt as facts', () => {
    expect(factOf(look('glow'), 'glow')).toEqual({ kind: 'glow', fields: ['glow'], color: 'accent', alpha: 0.85, blur_s: 0.35 });
    expect(factOf(look('3d'), 'extrude')).toMatchObject({ copies: 6, color: 'accent_dark', dx_s: 0.012, dy_s: 0.016 });
    expect(factOf(look('highlighter'), 'bar')).toMatchObject({ alpha: 0.85, height_of_line: 0.55 });
    expect(factOf(look('sticker'), 'tilt').range_deg).toEqual([-6, 6]);
  });

  it('states opacity, font, case and letter spacing on every look', () => {
    for (const entry of TEXT_LOOKS) {
      expect(factOf(entry, 'opacity').value).toBe(entry.opacity);
      expect(factOf(entry, 'font')).toMatchObject(entry.font);
      expect(factOf(entry, 'case').mode).toBe(entry.case);
      expect(factOf(entry, 'letter_spacing').spacing_s).toBe(entry.letter_spacing);
    }
    expect(factOf(rich, 'font')).toMatchObject({ family: 'serif', weight: 400 });
  });

  it('holds no pixel value: every number is a fraction, a count, an angle or a weight', () => {
    for (const entry of [...TEXT_LOOKS, rich]) {
      const text = JSON.stringify(lookVectors(entry, []).facts);
      expect(text).not.toMatch(/"(px|width_px|height_px)"/);
    }
  });
});

describe('ai.video-editing: look vectors, one entry per probe string', () => {
  const find = (value: TextLook, id: string) => lookVectors(value).probes.find((probe) => probe.probe === id)!;

  it('has every string of the matrix, in order, for every look', () => {
    for (const entry of [...TEXT_LOOKS, rich]) {
      expect(lookVectors(entry).probes.map((probe) => probe.probe)).toEqual(STRING_MATRIX.map((item) => item.id));
    }
  });

  it('carries the direction of the script', () => {
    expect(find(look('sticker'), 'arabic').direction).toBe('rtl');
    expect(find(look('sticker'), 'hebrew').direction).toBe('rtl');
    expect(find(look('sticker'), 'chinese').direction).toBe('ltr');
  });

  it('draws upper as Title Case with the plan language, and leaves scripts without case unchanged', () => {
    expect(find(look('sticker'), 'turkish_i').text_drawn).toBe('İğdır Işık');
    expect(find(look('sticker'), 'all_caps_latin').text_drawn).toBe('Save Time Now');
    expect(find(look('sticker'), 'one_word').text_drawn).toBe('Amazing');
    expect(find(look('sticker'), 'longest_allowed').text_drawn).toBe('Wwwwwww Wwwwwww Wwwwwww Wwww');
    expect(find(look('sticker'), 'descenders').text_drawn).toBe('Gypsy Jumping Quickly');
    expect(find(look('sticker'), 'cyrillic').text_drawn).toBe('Привет Мир');
    expect(find(look('sticker'), 'mixed_ltr_rtl').text_drawn).toBe('Save שלום 50% مرحبا');
    expect(find(look('sticker'), 'emoji_inside').text_drawn).toBe('Great 🔥 Job');
    for (const id of ['bengali_conjunct', 'devanagari', 'chinese', 'japanese', 'thai', 'arabic', 'hebrew']) {
      expect(find(look('sticker'), id).text_drawn).toBe(find(look('sticker'), id).text);
    }
  });

  it('draws Title Case once: drawing a drawn text again changes nothing', () => {
    for (const probe of lookVectors(look('sticker')).probes) {
      expect(titleCase(probe.text_drawn, probe.language)).toBe(probe.text_drawn);
    }
  });

  it('draws the text as written when the look says so', () => {
    for (const item of STRING_MATRIX) expect(find(rich, item.id).text_drawn).toBe(item.text);
  });

  it('forces spacing to 0 for joining and reordering scripts, and keeps it for the others', () => {
    for (const id of ['arabic', 'bengali_conjunct', 'devanagari', 'thai', 'mixed_ltr_rtl']) {
      expect(find(rich, id).letter_spacing_s).toBe(0);
    }
    for (const id of ['one_word', 'cyrillic', 'chinese', 'hebrew', 'turkish_i', 'emoji_inside']) {
      expect(find(rich, id).letter_spacing_s).toBe(0.05);
    }
    expect(find(look('sticker'), 'one_word').letter_spacing_s).toBe(0);
  });
});

describe('ai.video-editing: look vectors, served in the contract', () => {
  it('serves one entry per look in table order, equal to the generated vectors, as plain JSON', () => {
    const served = contractView().look_vectors;
    expect(served.map((entry) => entry.look)).toEqual(TEXT_LOOKS.map((entry) => entry.id));
    expect(served).toEqual(JSON.parse(JSON.stringify(allLookVectors(TEXT_LOOKS))));
  });

  it('is deterministic', () => {
    expect(JSON.stringify(allLookVectors(TEXT_LOOKS))).toBe(JSON.stringify(allLookVectors(TEXT_LOOKS)));
  });
});

describe('ai.video-editing: look vectors, the ten new looks (S8)', () => {
  const NEW = ['neon_box', 'pill_ring', 'gradient_block', 'tilt_sticker', 'solid_round', 'pastel_pill', 'flat_rect', 'yellow_bold', 'dark_accent', 'coral_pill'];

  it('has vectors for every new look, served in the contract after the six shipped ones', () => {
    const served = contractView().look_vectors.map((entry) => entry.look);
    expect(served.slice(-NEW.length)).toEqual(NEW);
    for (const id of NEW) {
      const vectors = lookVectors(look(id));
      expect(vectors.facts.length).toBeGreaterThan(0);
      expect(vectors.probes).toHaveLength(STRING_MATRIX.length);
    }
  });

  it('exercises every block a new look switches on (gate 2): only the blocks it leaves off have no vector', () => {
    for (const id of NEW) {
      const entry = look(id);
      for (const field of uncoveredFields([entry])) {
        expect(`${id}.${field}: ${JSON.stringify((entry as unknown as Record<string, unknown>)[field])}`).toBe(`${id}.${field}: null`);
      }
    }
  });

  it('draws the box, its fill and its border in every new look, never a text stroke', () => {
    for (const id of NEW) {
      const kinds = lookVectors(look(id)).facts.map((fact) => fact.kind);
      expect(kinds).toEqual(expect.arrayContaining(['layers', 'text_fill', 'box', 'box_fill', 'box_border', 'opacity', 'font', 'case', 'letter_spacing']));
      expect(kinds).not.toContain('text_stroke');
      expect(factOf(look(id), 'layers').draws).toEqual(expect.arrayContaining(['box_fill', 'box_border', 'text_fill']));
    }
  });

  it('states the layers, back to front, of the looks with a shadow, a glow or a plain box', () => {
    expect(factOf(look('neon_box'), 'layers').draws).toEqual(['box_fill', 'box_border', 'text_fill', 'glow']);
    expect(factOf(look('gradient_block'), 'layers').draws).toEqual(['box_shadow', 'box_fill', 'box_border', 'text_fill']);
    expect(factOf(look('coral_pill'), 'layers').draws).toEqual(['box_fill', 'box_border', 'text_fill']);
  });

  it('states the neon glow, the sunset gradient and hard block, the sticker ring and tilt, and the sheet 3 font', () => {
    expect(factOf(look('neon_box'), 'box_glow')).toMatchObject({ color: 'accent', alpha: 0.8, blur_s: 0.35 });
    expect(factOf(look('neon_box'), 'glow')).toMatchObject({ color: 'accent' });
    const sunset = factOf(look('gradient_block'), 'box_fill').fill;
    expect(sunset).toMatchObject({ kind: 'gradient', direction: 'ltr', from: 'accent', to: 'accent_light' });
    if (sunset.kind === 'gradient') expect(sunset.samples[0].at.x).toBeLessThan(sunset.samples[1].at.x);
    expect(factOf(look('gradient_block'), 'box_shadow')).toMatchObject({ style: 'hard', dx_s: 0.1, dy_s: 0.1, blur_s: 0 });
    expect(factOf(look('tilt_sticker'), 'box_border').ring).toEqual({ color: 'accent', width_s: 0.07, gap_s: 0 });
    expect(factOf(look('tilt_sticker'), 'tilt').range_deg).toEqual([-7, -5]);
    expect(factOf(look('dark_accent'), 'font')).toMatchObject({ family: 'sans_condensed', weight: 700 });
    expect(factOf(look('flat_rect'), 'box')).toMatchObject({ shape: 'sharp', radius_of_height: 0 });
    expect(factOf(look('pill_ring'), 'box')).toMatchObject({ shape: 'pill', radius_of_height: 0.5 });
    expect(factOf(look('pastel_pill'), 'box_fill').fill).toEqual({ kind: 'solid', color: 'accent_light' });
  });

  it('asks the phone to draw every probe string as written, with the look spacing', () => {
    for (const id of NEW) {
      for (const probe of lookVectors(look(id)).probes) {
        const source = STRING_MATRIX.find((item) => item.id === probe.probe)!;
        expect(probe.text_drawn).toBe(source.text);
        expect(probe.letter_spacing_s).toBe(0);
      }
    }
  });
});
