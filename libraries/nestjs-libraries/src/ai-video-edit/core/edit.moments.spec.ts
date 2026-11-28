// AI video editing (ai.video-editing): the moments builder, hand-computed on synthetic words and strokes. Needs no
// database and no Nest.
import { ActivityEntry, EditWord } from '../contract/edit.contract';
import {
  Direction,
  Moment,
  anchorDirection,
  applyLabels,
  buildMoments,
  chapterMoments,
  contentKeepouts,
  drawingMoments,
  iconTier,
  sentenceMoments,
} from './edit.moments';
import { buildMap, remapWords } from './edit.timeline';

// Words of 100 ms with the given gap before each (the first starts at 0); `w` is the text.
const words = (list: [string, number][]): EditWord[] => {
  let t = 0;
  return list.map(([w, gap], i) => {
    const start = t + gap;
    t = start + 100;
    return { i, w, start_ms: start, end_ms: t };
  });
};

const brush = (id: string, start: number, end: number, x = 0.1): ActivityEntry => ({
  id,
  type: 'brush',
  start_ms: start,
  end_ms: end,
  region: { x, y: 0.2, w: 0.1, h: 0.1 },
  strength: 1,
  source: 'event_log',
});

const marker = (id: string, at: number): ActivityEntry => ({
  id,
  type: 'slide_change',
  start_ms: at,
  end_ms: at,
  region: { x: 0, y: 0, w: 1, h: 1 },
  strength: 1,
  source: 'event_log',
});

const board = (type: 'board_show' | 'board_hide', at: number): ActivityEntry => ({ ...marker(type, at), type });

const sentence = (id: string, start: number): Moment => ({
  id,
  kind: 'sentence',
  start_ms: start,
  end_ms: start + 1000,
  label: 'plain',
});

describe('ai.video-editing: sentenceMoments', () => {
  it('splits after sentence-final punctuation and numbers the sentences', () => {
    const m = sentenceMoments(
      words([['alpha', 0], ['beta.', 0], ['gamma', 0], ['delta!', 0], ['omega?', 0]])
    );
    expect(m.map((x) => [x.id, x.word_from, x.word_to, x.label])).toEqual([
      ['s1', 0, 1, 'plain'],
      ['s2', 2, 3, 'plain'],
      ['s3', 4, 4, 'plain'],
    ]);
    expect(m[0]).toMatchObject({ kind: 'sentence', start_ms: 0, end_ms: 200 });
  });

  it('splits on a pause of 1500 ms but not on 1400 ms', () => {
    const split = sentenceMoments(words([['alpha', 0], ['beta', 1500], ['gamma', 0]]));
    expect(split.map((x) => [x.word_from, x.word_to])).toEqual([
      [0, 0],
      [1, 2],
    ]);
    const joined = sentenceMoments(words([['alpha', 0], ['beta', 1400], ['gamma', 0]]));
    expect(joined.map((x) => [x.word_from, x.word_to])).toEqual([[0, 2]]);
  });

  it('splits after the danda and the other sentence-final marks of several scripts', () => {
    const m = sentenceMoments(
      words([['alpha।', 0], ['beta؟', 0], ['gamma。', 0], ['delta', 0]])
    );
    expect(m.map((x) => [x.word_from, x.word_to])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('keeps a closing quote or bracket with the sentence it ends', () => {
    const m = sentenceMoments(words([['alpha."', 0], ['beta', 0]]));
    expect(m.map((x) => [x.word_from, x.word_to])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('has no sentences without words', () => {
    expect(sentenceMoments([])).toEqual([]);
  });
});

describe('ai.video-editing: drawingMoments', () => {
  it('joins strokes closer than 1500 ms into one drawing with the union box', () => {
    const m = drawingMoments([brush('a', 1000, 2000), brush('b', 3499, 4000, 0.5)]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ id: 'd1', kind: 'drawing', start_ms: 1000, end_ms: 4000, label: 'drawing' });
    const r = m[0].region!;
    expect([r.x, r.y, r.w, r.h].map((v) => Math.round(v * 1000) / 1000)).toEqual([0.1, 0.2, 0.5, 0.1]);
  });

  it('does not join strokes 1501 ms apart', () => {
    const m = drawingMoments([brush('a', 1000, 2000), brush('b', 3501, 4000)]);
    expect(m.map((x) => [x.id, x.start_ms, x.end_ms])).toEqual([
      ['d1', 1000, 2000],
      ['d2', 3501, 4000],
    ]);
  });

  it('reads brush entries only, in time order', () => {
    const m = drawingMoments([marker('m', 500), brush('b', 5000, 5100), brush('a', 1000, 1100)]);
    expect(m.map((x) => x.start_ms)).toEqual([1000, 5000]);
  });
});

describe('ai.video-editing: chapterMoments', () => {
  const map = buildMap(20000, []);

  it('takes the request chapters when there are some and moves them to the output timeline', () => {
    const cut = buildMap(20000, [{ src_start_ms: 1000, src_end_ms: 3000, reason: 'silence' }]);
    const m = chapterMoments(
      [{ start_ms: 5000, kind: 'text' }, { start_ms: 9000, kind: 'image' }],
      [marker('m', 7777)],
      cut
    );
    expect(m.map((x) => [x.id, x.kind, x.start_ms, x.end_ms, x.label])).toEqual([
      ['c1', 'chapter', 2999, 3000, 'chapter'],
      ['c2', 'chapter', 6999, 7000, 'chapter'],
    ]);
  });

  it('falls back to the slide_change markers without chapters', () => {
    const m = chapterMoments(undefined, [marker('a', 4000), brush('b', 100, 200), marker('c', 9000)], map);
    expect(m.map((x) => [x.id, x.start_ms, x.end_ms])).toEqual([
      ['c1', 3999, 4000],
      ['c2', 8999, 9000],
    ]);
  });

  it('ignores a traced summary object and uses the markers', () => {
    const m = chapterMoments({ count: 3, with_title: 2, with_note: 1 }, [marker('a', 4000)], map);
    expect(m.map((x) => x.end_ms)).toEqual([4000]);
  });

  it('skips the chapter at 0 ms', () => {
    const m = chapterMoments([{ start_ms: 0, kind: 'text' }, { start_ms: 6000, kind: 'text' }], [], map);
    expect(m.map((x) => [x.id, x.end_ms])).toEqual([['c1', 6000]]);
    expect(chapterMoments(undefined, [marker('a', 0)], map)).toEqual([]);
  });

  it('keeps one chapter for two on the same instant', () => {
    const m = chapterMoments([{ start_ms: 6000, kind: 'text' }, { start_ms: 6000, kind: 'image' }], [], map);
    expect(m).toHaveLength(1);
  });
});

describe('ai.video-editing: buildMoments', () => {
  it('lists sentences, drawings and chapters sorted by start, sentences plain', () => {
    const w = words([['alpha', 2000], ['beta.', 0], ['gamma', 4000], ['delta.', 0]]);
    const m = buildMoments(w, [brush('a', 4000, 5000)], [{ start_ms: 3000, kind: 'text' }], buildMap(20000, []));
    expect(m.map((x) => [x.id, x.start_ms])).toEqual([
      ['s1', 2000],
      ['c1', 2999],
      ['d1', 4000],
      ['s2', 6200],
    ]);
    expect(m.filter((x) => x.kind === 'sentence').every((x) => x.label === 'plain')).toBe(true);
  });
});

describe('ai.video-editing: applyLabels', () => {
  const list = [sentence('s1', 0), sentence('s2', 5000), sentence('s3', 10000), sentence('s4', 15000)];
  const answer = (labels: [string, string][]) => ({
    labels: labels.map(([id, label]) => ({ id, label })),
  });
  const labelsOf = (m: Moment[]) => m.map((x) => x.label);

  it('lays the labels on the sentences', () => {
    const m = applyLabels(list, answer([['s1', 'hook'], ['s2', 'reason'], ['s3', 'example'], ['s4', 'cta']]));
    expect(labelsOf(m)).toEqual(['hook', 'reason', 'example', 'cta']);
    expect(list[0].label).toBe('plain');
  });

  it('ignores an unknown id and leaves unanswered sentences plain', () => {
    const m = applyLabels(list, answer([['s9', 'claim'], ['s2', 'recap']]));
    expect(labelsOf(m)).toEqual(['plain', 'recap', 'plain', 'plain']);
  });

  it('turns a label outside the sentence labels into plain', () => {
    const m = applyLabels(list, answer([['s1', 'banana'], ['s2', 'drawing'], ['s3', 'chapter']]));
    expect(labelsOf(m)).toEqual(['plain', 'plain', 'plain', 'plain']);
  });

  it('keeps only the first hook', () => {
    const m = applyLabels(list, answer([['s1', 'hook'], ['s2', 'hook']]));
    expect(labelsOf(m).slice(0, 2)).toEqual(['hook', 'plain']);
  });

  it('drops a hook on the third sentence', () => {
    const m = applyLabels(list, answer([['s3', 'hook']]));
    expect(labelsOf(m)).toEqual(['plain', 'plain', 'plain', 'plain']);
  });

  it('keeps one claim per 20 s: two claims 10 s apart leave the first', () => {
    const m = applyLabels(list, answer([['s1', 'claim'], ['s3', 'claim']]));
    expect(labelsOf(m)).toEqual(['claim', 'plain', 'plain', 'plain']);
  });

  it('keeps a second claim 20 s after the first', () => {
    const far = [sentence('s1', 0), sentence('s2', 20000)];
    expect(labelsOf(applyLabels(far, answer([['s1', 'claim'], ['s2', 'claim']])))).toEqual(['claim', 'claim']);
  });

  it('leaves drawings and chapters alone', () => {
    const events: Moment[] = [
      { id: 'd1', kind: 'drawing', start_ms: 0, end_ms: 100, label: 'drawing' },
      { id: 'c1', kind: 'chapter', start_ms: 199, end_ms: 200, label: 'chapter' },
    ];
    expect(labelsOf(applyLabels(events, answer([['d1', 'claim'], ['c1', 'hook']])))).toEqual(['drawing', 'chapter']);
  });
});

describe('ai.video-editing: anchorDirection (moments from source time to output time)', () => {
  // 10 words, word k at k s (100 ms long), the source is 10 s long; the source 3000..6000 is cut, so the words 3, 4 and 5
  // are gone and the output (7 s) is: source 0..3000 at 0..3000 and source 6000..10000 at 3000..7000
  const src = Array.from({ length: 10 }, (_, k) => ({ i: k, w: `w${k}`, start_ms: k * 1000, end_ms: k * 1000 + 100 }));
  const map = buildMap(10000, [{ src_start_ms: 3000, src_end_ms: 6000, reason: 'silence' }]);
  const out = remapWords(src, map);
  const kept = (moments: Moment[], style: 'calm' | 'lively' = 'calm'): Direction => ({ style, source: 'director', moments });
  const sentence = (id: string, from: number, to: number, label: Moment['label'] = 'plain'): Moment => ({
    id,
    kind: 'sentence',
    start_ms: from * 1000,
    end_ms: to * 1000 + 100,
    word_from: from,
    word_to: to,
    label,
  });

  it('gives no direction for none, a missing direction or a direction without moments array', () => {
    expect(anchorDirection(undefined, src, out, map)).toBeUndefined();
    expect(anchorDirection(null, src, out, map)).toBeUndefined();
    expect(anchorDirection({ style: 'lively', source: 'none', moments: [] }, src, out, map)).toBeUndefined();
    expect(anchorDirection({ style: 'lively', source: 'director' } as unknown as Direction, src, out, map)).toBeUndefined();
  });

  it('moves a sentence onto the output words by word index, with the output times', () => {
    const d = anchorDirection(kept([sentence('s1', 0, 2, 'hook'), sentence('s3', 6, 7, 'claim')], 'lively'), src, out, map)!;
    expect(d.style).toBe('lively');
    expect(d.source).toBe('director');
    expect(d.moments).toEqual([
      { id: 's1', kind: 'sentence', start_ms: 0, end_ms: 2100, word_from: 0, word_to: 2, label: 'hook' },
      { id: 's3', kind: 'sentence', start_ms: 3000, end_ms: 4100, word_from: 3, word_to: 4, label: 'claim' },
    ]);
  });

  it('drops a sentence whose words were all cut and trims one whose words were partly cut', () => {
    const d = anchorDirection(kept([sentence('s2', 3, 5), sentence('s4', 2, 6)]), src, out, map)!;
    expect(d.moments.map((m) => m.id)).toEqual(['s4']);
    expect(d.moments[0]).toMatchObject({ start_ms: 2000, end_ms: 3100, word_from: 2, word_to: 3 });
  });

  it('moves a drawing through the remap, keeping its region, and drops one that was cut entirely', () => {
    const region = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
    const drawing = (id: string, start: number, end: number): Moment => ({ id, kind: 'drawing', start_ms: start, end_ms: end, region, label: 'drawing' });
    const d = anchorDirection(kept([drawing('d1', 4000, 8000), drawing('d2', 3500, 5500)]), src, out, map)!;
    expect(d.moments).toEqual([{ id: 'd1', kind: 'drawing', start_ms: 3000, end_ms: 5000, region, label: 'drawing' }]);
  });

  it('maps a chapter as an instant [t-1, t]; one at the output edge or on an earlier one is dropped', () => {
    const chapter = (id: string, t: number): Moment => ({ id, kind: 'chapter', start_ms: t - 1, end_ms: t, label: 'chapter' });
    const d = anchorDirection(
      kept([chapter('c1', 2000), chapter('c2', 5000), chapter('c3', 6000), chapter('c4', 8500), chapter('c5', 10000)]),
      src,
      out,
      map
    )!;
    // c2 lies in the cut and lands where the next kept piece starts (3000); c3 maps there too; c5 is the end of the output
    expect(d.moments.map((m) => [m.id, m.start_ms, m.end_ms])).toEqual([
      ['c1', 1999, 2000],
      ['c2', 2999, 3000],
      ['c4', 5499, 5500],
    ]);
  });

  it('keeps the order of the moments and does not change the direction it was given', () => {
    const given = kept([sentence('s1', 0, 2), { id: 'c1', kind: 'chapter', start_ms: 1999, end_ms: 2000, label: 'chapter' }]);
    const before = JSON.stringify(given);
    const d = anchorDirection(given, src, out, map)!;
    expect(d.moments.map((m) => m.id)).toEqual(['s1', 'c1']);
    expect(JSON.stringify(given)).toBe(before);
  });
});

describe('ai.video-editing: iconTier, where an icon is welcome in a calm video (task TS9c)', () => {
  const sentence = (id: string, from: number, to: number, label: Moment['label']): Moment => ({
    id,
    kind: 'sentence',
    start_ms: from * 1000,
    end_ms: to * 1000 + 100,
    word_from: from,
    word_to: to,
    label,
  });
  const direction = (style: 'calm' | 'lively'): Direction => ({
    style,
    source: 'director',
    moments: [
      sentence('s1', 0, 1, 'hook'),
      sentence('s2', 2, 3, 'example'),
      sentence('s3', 4, 5, 'reason'),
      sentence('s4', 6, 7, 'claim'),
      sentence('s5', 8, 9, 'plain'),
      sentence('s6', 10, 11, 'recap'),
      sentence('s7', 12, 13, 'cta'),
    ],
  });

  it('is 0 on an example, reason or claim, 1 on a plain sentence, 2 on the others and outside every sentence', () => {
    const calm = direction('calm');
    expect([2, 4, 6].map((w) => iconTier(calm, w))).toEqual([0, 0, 0]);
    expect(iconTier(calm, 8)).toBe(1);
    expect([0, 10, 12, 40].map((w) => iconTier(calm, w))).toEqual([2, 2, 2, 2]);
  });

  it('puts no limit on a lively video, a video without a director or without a direction', () => {
    expect([0, 8, 10, 40].map((w) => iconTier(direction('lively'), w))).toEqual([0, 0, 0, 0]);
    expect(iconTier({ ...direction('calm'), source: 'none' }, 0)).toBe(0);
    expect(iconTier(undefined, 0)).toBe(0);
  });
});

describe('ai.video-editing: contentKeepouts, what text and icons keep off (task TS9d)', () => {
  const map = buildMap(20000, []);
  const ink = { x: 0.1, y: 0.2, w: 0.1, h: 0.1 };
  const times = (k: { start_ms: number; end_ms: number }[]) => k.map((x) => [x.start_ms, x.end_ms]);

  it('keeps the ink until the next slide change, and until the end of the video when nothing follows', () => {
    const k = contentKeepouts([brush('a', 1000, 2000), marker('m', 6000)], undefined, map);
    expect(times(k)).toEqual([[1000, 6000]]);
    expect(k[0].region).toEqual(ink);
    expect(times(contentKeepouts([brush('a', 1000, 2000)], undefined, map))).toEqual([[1000, 20000]]);
    // a slide change before the stroke ends does not cut the stroke short
    expect(times(contentKeepouts([brush('a', 1000, 5000), marker('m', 3000)], undefined, map))).toEqual([[1000, 5000]]);
  });

  it('ends the ink of the board at board_hide, and ignores a board_hide for ink drawn on the slide', () => {
    const onBoard = [board('board_show', 500), brush('a', 1000, 2000), board('board_hide', 4000), marker('m', 8000)];
    expect(times(contentKeepouts(onBoard, undefined, map))).toEqual([[1000, 4000]]);
    const onSlide = [brush('a', 1000, 2000), board('board_hide', 4000), marker('m', 8000)];
    expect(times(contentKeepouts(onSlide, undefined, map))).toEqual([[1000, 8000]]);
  });

  it('keeps the active chapter region until the next chapter, and ends ink at the chapter end', () => {
    const region = { x: 0.1, y: 0.05, w: 0.8, h: 0.1 };
    const chapters = [
      { start_ms: 0, kind: 'text', region },
      { start_ms: 5000, kind: 'image' },
      { start_ms: 12000, kind: 'text', region },
    ];
    const k = contentKeepouts([brush('a', 1000, 2000)], chapters, map);
    expect(times(k)).toEqual([[1000, 5000], [0, 5000], [12000, 20000]]);
    expect(k[1].region).toEqual(region);
  });

  it('keeps nothing off without ink and without a chapter region, and reads only a real chapters list', () => {
    expect(contentKeepouts([marker('m', 3000)], undefined, map)).toEqual([]);
    expect(contentKeepouts([], [{ start_ms: 0, kind: 'text' }], map)).toEqual([]);
    expect(contentKeepouts([], { count: 1, with_title: 0, with_note: 0 }, map)).toEqual([]);
  });

  it('moves the stretches to the output timeline and leaves out one that was cut away', () => {
    const cut = buildMap(20000, [{ src_start_ms: 2000, src_end_ms: 4000, reason: 'silence' }]);
    expect(times(contentKeepouts([brush('a', 1000, 1500), marker('m', 6000)], undefined, cut))).toEqual([[1000, 4000]]);
    expect(contentKeepouts([brush('b', 2500, 3000), marker('n', 3500)], undefined, cut)).toEqual([]);
  });
});
