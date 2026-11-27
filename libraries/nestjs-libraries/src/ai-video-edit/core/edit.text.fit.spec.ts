// AI video editing (ai.video-editing), text styles card S1: the text budget and the fit estimate for any script. The
// grapheme and word helpers, the case, the width classes, the cap on a text, and the string matrix against every look,
// the 3 ratios and every zone. Needs no database and no Nest.
import { EDIT_LEVELS, EditLevel, OUTPUTS, Plan, PlanItem, ZONES, ZoneId } from '../contract/edit.contract';
import { BASELINE_EXTENT, TEXT_LOOKS, lookExtent, lookSizeFactor, textLookById } from '../contract/edit.styles';
import { CheckCode, clientCheck, isUnusable } from './edit.clientcheck';
import {
  GeometryContext,
  OVERLAY_SIZE,
  WIDTH_FACTOR,
  ZONE_ORDER,
  drawnText,
  graphemeWeight,
  graphemes,
  lookGrowth,
  overlayBox,
  overlayFits,
  placeOverlay,
  textLines,
  textUnits,
  titleCase,
  widthClass,
  wordCount,
  words,
} from './edit.geometry';
import { planEdit } from './edit.pipeline';
import { MAX_TEXT_GRAPHEMES, MAX_TEXT_WORDS, capText } from './edit.rules';
import { STRING_MATRIX } from './edit.strings.fixture';
import {
  ALL_OUTPUTS,
  GOLDEN_FIXTURES,
  GoldenFixture,
  MULTI_PALETTE,
  goldenRequest,
} from './fixtures/edit.golden.fixtures';
import { toEditWords } from './edit.words';

const DURATION = 10000;

// The looks released before card S8: their box is inside the estimate's baseline, so they have no size factor.
const SHIPPED = ['sticker', 'label_pill', '3d', 'glow', 'gradient', 'highlighter'];

// A styled text item of a look in the upper centre zone.
const textItem = (text: string, style: string): PlanItem => ({
  id: 't1',
  effect: 'x_sticker',
  layer: 'text',
  target: 'overlay',
  start_ms: 1000,
  end_ms: 2000,
  position: { zone: 'upper_center' },
  component: { type: 'styled_text', kind: 'keyword_echo', text, style_preset: style, color_slot: 0 },
  params: { entry: 'pop', entry_ms: 200, exit_ms: 150, style_preset: style },
});

// A plan of one text item, with a facecam far from every zone.
const planOf = (item: PlanItem): Plan => ({
  contract_version: 2,
  plan_version: 1,
  session_id: 's',
  level: 'heavy',
  video: { output_duration_ms: DURATION },
  structure: { cuts: [], speed_segments: [] },
  facecam_track: [{ t_ms: 0, cx: 0.85, cy: 0.95, radius: 0.08 }],
  palette: { mode: 'multi', colors: ['#FF3B30'] },
  items: [item],
  captions: { effect: 'c_word_highlight', emphasis_words: [0] },
  warnings: [],
});

// The text findings (the two errors of this card) the client check gives for a text in a look.
const textErrors = (text: string, style: string, language?: string): CheckCode[] =>
  clientCheck({
    plan: planOf(textItem(text, style)),
    assets: [],
    video: { width: 1080, height: 2400 },
    outputs: ALL_OUTPUTS,
    source_duration_ms: DURATION,
    word_count: 10,
    language,
  })
    .map((r) => r.code)
    .filter((code) => code === 'text_over_cap' || code === 'text_cannot_fit');

const CTX: GeometryContext = { video: { width: 1080, height: 2400 }, outputs: ALL_OUTPUTS, facecam: [] };

describe('ai.video-editing: text budget and fit', () => {
  describe('graphemes and words', () => {
    it('counts a letter with its mark, an emoji family and a Latin letter once each', () => {
      expect(graphemes('é')).toHaveLength(1);
      expect(graphemes('👨‍👩‍👧')).toHaveLength(1);
      expect(graphemes('abc')).toEqual(['a', 'b', 'c']);
    });

    it('never splits a Bengali letter with its vowel sign', () => {
      const text = 'শ্রেষ্ঠ';
      expect(graphemes(text).join('')).toBe(text);
      expect(graphemes(text).length).toBeLessThan(Array.from(text).length);
    });

    it('counts the words of a spaced text and of texts without spaces', () => {
      expect(words('Save two hours', 'en')).toEqual(['Save', 'two', 'hours']);
      expect(wordCount("Don't stop", 'en')).toBe(2);
      expect(wordCount('今日は天気がいいですね', 'ja')).toBeGreaterThan(1);
      expect(wordCount('ฉันรักประเทศไทยมากที่สุดในโลกนี้', 'th')).toBeGreaterThan(1);
      expect(wordCount('今天我们一起来学习如何在每天的生活中节省更多的时间', 'zh')).toBeGreaterThan(1);
    });

    it('counts a text of symbols by its pieces and an empty text as no words', () => {
      expect(words('🔥🔥')).toEqual(['🔥🔥']);
      expect(wordCount('   ')).toBe(0);
    });

    it('uses the root rules for a language tag the runtime does not know', () => {
      expect(wordCount('one two', 'not a tag!')).toBe(2);
    });
  });

  describe('title case (what case upper draws)', () => {
    it('capitalises the first letter of each word and lowers the rest', () => {
      expect(titleCase('SAVE TIME NOW', 'en')).toBe('Save Time Now');
      expect(titleCase('amazing', 'en')).toBe('Amazing');
      expect(titleCase('Привет мир', 'ru')).toBe('Привет Мир');
      expect(titleCase('Great 🔥 job', 'en')).toBe('Great 🔥 Job');
      expect(titleCase('3rd place 50% off', 'en')).toBe('3rd Place 50% Off');
    });

    it('handles apostrophes and hyphens', () => {
      expect(titleCase("don't stop", 'en')).toBe("Don't Stop");
      expect(titleCase('DON\u2019T STOP', 'en')).toBe('Don\u2019t Stop');
      expect(titleCase('well-known fact', 'en')).toBe('Well-Known Fact');
      expect(titleCase("o'clock now", 'en')).toBe("O'clock Now");
      expect(titleCase("'hello' world", 'en')).toBe("'Hello' World");
    });

    it('lowers an acronym and mid-word capitals, as the phone does', () => {
      expect(titleCase('NASA launch', 'en')).toBe('Nasa Launch');
      expect(titleCase('iPhone', 'en')).toBe('Iphone');
    });

    it('follows the language: a Turkish i, and a sharp s that is never SS', () => {
      expect(titleCase('iğdır ışık', 'tr')).toBe('İğdır Işık');
      expect(titleCase('IŞIK', 'tr')).toBe('Işık');
      expect(titleCase('straße', 'de')).toBe('Straße');
      expect(titleCase('ß', 'de')).toBe('ß');
    });

    it('leaves a script without case as it is and survives a language tag it does not know', () => {
      expect(titleCase('শ্রেষ্ঠ', 'bn')).toBe('শ্রেষ্ঠ');
      expect(titleCase('节省时间', 'zh')).toBe('节省时间');
      expect(titleCase('save time', 'bn_BD!')).toBe('Save Time');
      expect(titleCase('')).toBe('');
    });

    it('draws only a look whose case is upper; as_written stays as written', () => {
      expect(drawnText('SAVE TIME', 'upper', 'en')).toBe('Save Time');
      expect(drawnText('SAVE TIME', 'as_written', 'en')).toBe('SAVE TIME');
    });
  });

  describe('width classes', () => {
    it('puts a Latin letter in the normal class, Hebrew in the narrow one and the other scripts and emoji in the wide', () => {
      expect(widthClass('a')).toBe('normal');
      expect(widthClass(' ')).toBe('normal');
      expect(widthClass('7')).toBe('normal');
      expect(widthClass('ש')).toBe('narrow');
      expect(widthClass('今')).toBe('wide');
      expect(widthClass('ক')).toBe('wide');
      expect(widthClass('🔥')).toBe('wide');
      expect(widthClass('。')).toBe('wide');
    });

    it('treats a script the table does not list as wide', () => {
      expect(widthClass('ᚠ')).toBe('wide');
    });

    it('counts a Latin text one unit a character, as the estimate always did', () => {
      expect(textUnits('SAVE TIME')).toBe(9);
      expect(textUnits('  SAVE  ')).toBe(4);
    });

    it('makes a text of a wide script wider than the same number of Latin letters', () => {
      expect(textUnits('节省时间')).toBeGreaterThan(textUnits('SAVE'));
    });

    it('counts the base letters of a conjunct, as the phone draws one glyph for each, whatever the segmenter joins', () => {
      // `স্বাস্থ্য` is 5 consonants joined by virama (one or two grapheme clusters, by the Unicode version).
      expect(graphemeWeight('স্ব')).toBe(2);
      expect(textUnits('স্বাস্থ্য')).toBeCloseTo(5 * WIDTH_FACTOR.wide, 9);
      // `নমস্তে`: 4 consonants, the vowel sign and the virama add nothing.
      expect(textUnits('নমস্তে')).toBeCloseTo(4 * WIDTH_FACTOR.wide, 9);
      expect(textUnits('नमस्ते')).toBeCloseTo(4 * WIDTH_FACTOR.wide, 9);
    });

    it('lays a conjunct text out on 2 lines when its letters need them, though it has few grapheme clusters', () => {
      const text = 'স্বাস্থ্য স্বাস্থ্য';
      expect(textUnits(text)).toBeCloseTo(10 * WIDTH_FACTOR.wide + 1, 9);
      expect(textLines(text, 'bn')).toBe(2);
      expect(textLines('स्वास्थ्य स्वास्थ्य', 'hi')).toBe(2);
    });

    it('counts a letter with its marks, a Thai word, and an emoji sequence as before', () => {
      expect(graphemeWeight('a')).toBe(1);
      expect(graphemeWeight('e\u0301')).toBe(1);
      expect(graphemeWeight('\u0301')).toBe(1);
      expect(graphemeWeight('👨‍👩‍👧')).toBe(1);
      expect(graphemeWeight('👍🏽')).toBe(1);
      expect(textUnits('👨‍👩‍👧')).toBe(WIDTH_FACTOR.wide);
      expect(textUnits('🔥🔥')).toBe(2 * WIDTH_FACTOR.wide);
      expect(textUnits('สวัสดีครับ')).toBeCloseTo(7 * WIDTH_FACTOR.narrow, 9);
      expect(textUnits('Привет мир')).toBe(10);
      expect(textUnits('节省时间')).toBeCloseTo(4 * WIDTH_FACTOR.wide, 9);
    });
  });

  describe('lines', () => {
    it('keeps the longest allowed Latin text on 2 lines and a short one on 1', () => {
      expect(textLines('WWWWWWW WWWWWWW WWWWWWW WWWW')).toBe(2);
      expect(textLines('A')).toBe(1);
      expect(textLines('SAVE TIME')).toBe(1);
    });

    it('lets the phone shrink one long word, and gives up on a text it cannot lay out', () => {
      expect(textLines('A'.repeat(20))).toBe(1);
      expect(textLines('A'.repeat(30))).toBe(Infinity);
      expect(textLines('A'.repeat(15) + ' ' + 'A'.repeat(15))).toBe(Infinity);
    });

    it('does not place a text the phone cannot lay out in any zone', () => {
      const shape = { type: 'text' as const, text: 'A'.repeat(30) };
      expect(ZONE_ORDER.some((zone) => overlayFits(shape, zone, 0, 1000, CTX))).toBe(false);
      expect(placeOverlay(shape, ZONE_ORDER, 0, 1000, CTX)).toBeNull();
    });
  });

  describe('capText', () => {
    it('keeps a text of up to 4 words as it is, in single spaces', () => {
      expect(capText('Save two hours a')).toBe('Save two hours a');
      expect(capText('  Save   two ')).toBe('Save two');
      expect(capText('')).toBe('');
    });

    it('cuts a longer text to 4 whole words', () => {
      expect(capText('one two three four five six')).toBe('one two three four');
    });

    it('cuts to whole words that fit the grapheme cap', () => {
      const cut = capText('Extraordinarily unbelievable organizational transformation', 'en');
      expect(cut).toBe('Extraordinarily unbelievable');
      expect(graphemes(cut).length).toBeLessThanOrEqual(MAX_TEXT_GRAPHEMES);
    });

    it('cuts a sentence without spaces by its words and graphemes, not as one word', () => {
      for (const id of ['over_cap_chinese', 'over_cap_thai']) {
        const entry = STRING_MATRIX.find((s) => s.id === id)!;
        expect(wordCount(entry.text, entry.language)).toBeGreaterThan(MAX_TEXT_WORDS);
        const cut = capText(entry.text, entry.language);
        expect(cut.length).toBeGreaterThan(0);
        expect(entry.text.startsWith(cut)).toBe(true);
        expect(graphemes(cut).length).toBeLessThanOrEqual(MAX_TEXT_GRAPHEMES);
        expect(wordCount(cut, entry.language)).toBeLessThanOrEqual(MAX_TEXT_WORDS);
      }
    });

    it('cuts a first word that is too long at a grapheme and never inside one', () => {
      const cut = capText('A'.repeat(40));
      expect(cut).toBe('A'.repeat(MAX_TEXT_GRAPHEMES));
      const marks = capText('é'.repeat(40));
      expect(marks.length).toBeGreaterThan(0);
      expect(graphemes(marks).every((g) => g === 'é')).toBe(true);
    });
  });

  describe('the string matrix', () => {
    for (const entry of STRING_MATRIX) {
      describe(entry.id, () => {
        const capped = capText(entry.text, entry.language);

        it('is capped to a text the estimate can lay out', () => {
          expect(capped.length).toBeGreaterThan(0);
          expect(graphemes(capped).length).toBeLessThanOrEqual(MAX_TEXT_GRAPHEMES);
          expect(wordCount(capped, entry.language)).toBeLessThanOrEqual(MAX_TEXT_WORDS);
          expect(textLines(capped, entry.language)).toBeLessThanOrEqual(OVERLAY_SIZE.max_lines);
        });

        it(entry.over_cap ? 'is cut, to the start of the text' : 'is kept as it is written', () => {
          if (entry.over_cap) {
            expect(capped.length).toBeLessThan(entry.text.length);
            expect(entry.text.startsWith(capped)).toBe(true);
          } else {
            expect(entry.uncapped).toBe(true);
            expect(capped).toBe(entry.text);
          }
        });

        it('fits inside the safe rectangle of every ratio in at least one zone, and in a zone only when it does', () => {
          const shape = { type: 'text' as const, text: capped, language: entry.language };
          for (const output of ALL_OUTPUTS) {
            const safe = OUTPUTS[output.ratio].safe;
            const fitting = (Object.keys(ZONES) as ZoneId[]).filter((zone) =>
              overlayFits(shape, zone, 0, 1000, { ...CTX, outputs: [output] })
            );
            expect(fitting.length).toBeGreaterThan(0);
            for (const zone of fitting) {
              const box = overlayBox(shape, zone, output);
              expect(box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-9);
              expect(box.x1).toBeLessThanOrEqual(safe.x1 + 1e-9);
              expect(box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-9);
              expect(box.y1).toBeLessThanOrEqual(safe.y1 + 1e-9);
            }
          }
          expect(placeOverlay(shape, ZONE_ORDER, 0, 1000, CTX)).not.toBeNull();
        });

        it('has no text error from the client check in a shipped look once capped, and in a new look only when its box no longer fits', () => {
          for (const look of TEXT_LOOKS) {
            const tooLarge = textLines(capped, entry.language, lookGrowth(look).w) > OVERLAY_SIZE.max_lines;
            expect(textErrors(capped, look.id, entry.language)).toEqual(tooLarge ? ['text_cannot_fit'] : []);
            if (SHIPPED.includes(look.id)) expect(tooLarge).toBe(false);
          }
        });

        it('fits inside the safe rectangle of every ratio and zone in every look, or is dropped (no zone), never half placed', () => {
          for (const look of TEXT_LOOKS) {
            const shape = { type: 'text' as const, text: capped, language: entry.language, look };
            for (const output of ALL_OUTPUTS) {
              const safe = OUTPUTS[output.ratio].safe;
              for (const zone of Object.keys(ZONES) as ZoneId[]) {
                const fits = overlayFits(shape, zone, 0, 1000, { ...CTX, outputs: [output] });
                if (textLines(capped, entry.language, lookGrowth(look).w) > OVERLAY_SIZE.max_lines) {
                  expect(fits).toBe(false);
                  continue;
                }
                if (!fits) continue;
                const box = overlayBox(shape, zone, output);
                expect(box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-9);
                expect(box.x1).toBeLessThanOrEqual(safe.x1 + 1e-9);
                expect(box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-9);
                expect(box.y1).toBeLessThanOrEqual(safe.y1 + 1e-9);
              }
            }
          }
        });

        it('is never wider or taller in a look than the same text with no look, and equal for the shipped looks', () => {
          for (const look of TEXT_LOOKS) {
            const plain = { type: 'text' as const, text: capped, language: entry.language };
            for (const output of ALL_OUTPUTS) {
              const a = overlayBox(plain, 'upper_center', output);
              const b = overlayBox({ ...plain, look }, 'upper_center', output);
              expect(b.x1 - b.x0).toBeGreaterThanOrEqual(a.x1 - a.x0 - 1e-9);
              expect(b.y1 - b.y0).toBeGreaterThanOrEqual(a.y1 - a.y0 - 1e-9);
              if (SHIPPED.includes(look.id)) expect(b).toEqual(a);
            }
          }
        });
      });
    }

    it('reports a text over the grapheme cap as an error in every look, and as unusable when blocking is on', () => {
      const entry = STRING_MATRIX.find((s) => s.id === 'over_cap_latin')!;
      for (const look of TEXT_LOOKS) {
        expect(textErrors(entry.text, look.id, entry.language)).toContain('text_over_cap');
      }
      const results = clientCheck({
        plan: planOf(textItem(entry.text, 'sticker')),
        assets: [],
        language: entry.language,
      });
      expect(isUnusable(results)).toBe(true);
      expect(results.find((r) => r.code === 'text_over_cap')).toMatchObject({
        item_id: 't1',
        severity: 'error',
        detail: `chars=${graphemes(entry.text).length} max_chars=${MAX_TEXT_GRAPHEMES}`,
      });
    });

    it('reports a text the phone cannot lay out as an error without its text in the detail', () => {
      const text = 'A'.repeat(30);
      const results = clientCheck({ plan: planOf(textItem(text, 'sticker')), assets: [] });
      const found = results.find((r) => r.code === 'text_cannot_fit');
      expect(found).toMatchObject({ item_id: 't1', severity: 'error' });
      expect(found!.detail).not.toContain('AAA');
    });
  });

  describe('the planner', () => {
    const ENGLISH = GOLDEN_FIXTURES.filter((f) => f.name.startsWith('english'));

    // The texts of the styled text items a fixture's plan carries, planned in a language.
    const textsOf = (f: GoldenFixture, language: string, level: EditLevel) =>
      planEdit({
        sessionId: 'strings',
        level,
        request: { ...goldenRequest(f), language },
        words: toEditWords(f.words),
        palette: MULTI_PALETTE,
      }).plan.items.flatMap((i) => (i.component && i.component.type === 'styled_text' ? [i.component.text] : []));

    it('writes the keyword echo of a Turkish video with the Turkish capital i', () => {
      const turkish = ENGLISH.flatMap((f) => EDIT_LEVELS.flatMap((level) => textsOf(f, 'tr', level)));
      expect(turkish.length).toBeGreaterThan(0);
      expect(turkish.some((t) => t.includes('İ'))).toBe(true);
      const other = ENGLISH.flatMap((f) => EDIT_LEVELS.flatMap((level) => textsOf(f, 'eng', level)));
      expect(other.some((t) => t.includes('İ'))).toBe(false);
    });

    it('keeps every planned text inside the caps in every fixture', () => {
      for (const f of GOLDEN_FIXTURES) {
        for (const text of textsOf(f, f.language, 'heavy')) {
          expect(graphemes(text).length).toBeLessThanOrEqual(MAX_TEXT_GRAPHEMES);
          expect(wordCount(text, f.language)).toBeLessThanOrEqual(MAX_TEXT_WORDS);
        }
      }
    });
  });
});

describe('ai.video-editing: the fit estimate with a look size factor (card S8)', () => {
  const shape = (text: string, look?: string) => ({ type: 'text' as const, text, look: look ? textLookById(look) : undefined });
  const widthOf = (text: string, look: string | undefined, output = ALL_OUTPUTS[0]) => {
    const box = overlayBox(shape(text, look), 'upper_center', output);
    return [box.x1 - box.x0, box.y1 - box.y0];
  };

  it('turns the size factor of a look into a share of the frame: s is 0.0889 of the width', () => {
    expect(lookGrowth(undefined)).toEqual({ w: 0, h: 0 });
    expect(lookGrowth(textLookById('label_pill'))).toEqual({ w: 0, h: 0 });
    const neon = lookSizeFactor(textLookById('neon_box')!);
    expect(lookGrowth(textLookById('neon_box')).w).toBeCloseTo(neon.w * OVERLAY_SIZE.s_w, 9);
    expect(lookGrowth(textLookById('neon_box'), 0.5).h).toBeCloseTo(neon.h * OVERLAY_SIZE.s_w * 0.5, 9);
  });

  it('makes the box of a one line text wider and taller by the look growth, in every ratio', () => {
    for (const output of ALL_OUTPUTS) {
      const aspect = OUTPUTS[output.ratio].width / OUTPUTS[output.ratio].height;
      const [w0, h0] = widthOf('SAVE TIME', undefined, output);
      const [w1, h1] = widthOf('SAVE TIME', 'neon_box', output);
      const grow = lookGrowth(textLookById('neon_box'), aspect);
      expect(w1 - w0).toBeCloseTo(grow.w, 9);
      expect(h1 - h0).toBeCloseTo(grow.h, 9);
    }
  });

  it('wraps a text earlier in a larger look, and keeps the two line width at the limit', () => {
    // 14 normal characters are 0.812 wide: one line with no look and in a small look, two once the box of a neon look is added
    const text = 'ABCDEFG HIJKLM';
    expect(textLines(text)).toBe(1);
    expect(textLines(text, undefined, lookGrowth(textLookById('solid_round')).w)).toBe(1);
    expect(textLines(text, undefined, lookGrowth(textLookById('neon_box')).w)).toBe(2);
    const [w] = widthOf('AAAAAAAAA AAAAAAAAAAAAAA', 'neon_box');
    expect(w).toBeCloseTo(OVERLAY_SIZE.max_w + OVERLAY_SIZE.pad, 9);
  });

  it('refuses a text a larger look cannot lay out although the same text fits with no look', () => {
    const long = 'ABCDEFGHIJKLM NOPQRSTUVWXYZA';
    expect(textLines(long)).toBe(2);
    expect(textLines(long, undefined, lookGrowth(textLookById('solid_round')).w)).toBe(2);
    expect(textLines(long, undefined, lookGrowth(textLookById('neon_box')).w)).toBe(Infinity);
    const tall = { ...CTX, outputs: [ALL_OUTPUTS[0]] };
    expect(overlayFits(shape(long, 'neon_box'), 'upper_center', 0, 1000, tall)).toBe(false);
    expect(overlayFits(shape(long, 'solid_round'), 'upper_center', 0, 1000, tall)).toBe(true);
    expect(overlayFits(shape(long), 'upper_center', 0, 1000, tall)).toBe(true);
  });

  it('counts every extent of a look: the baseline holds the label pill, the new looks add beyond it', () => {
    expect(lookExtent(textLookById('label_pill')!).x).toBeLessThanOrEqual(BASELINE_EXTENT.x);
    for (const id of ['neon_box', 'gradient_block', 'tilt_sticker', 'pill_ring', 'coral_pill']) {
      expect(lookSizeFactor(textLookById(id)!).w).toBeGreaterThan(0);
    }
  });
});
