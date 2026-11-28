// AI video editing (ai.video-editing): silence cuts, the source to output map and the remap of words, the activity
// map and the facecam track (spec sections 10 and 11). Hand-computed on the fixture transcript. Needs no database
// and no Nest.
import { ActivityEntry } from '../contract/edit.contract';
import {
  DURATION_MS,
  FACECAM,
  RAW_TRANSCRIPT,
} from './fixtures/edit.fixtures';
import { toEditWords } from './edit.words';
import {
  buildMap,
  mapInstant,
  mapInterval,
  remapEntries,
  remapFacecam,
  remapWords,
  silenceCuts,
  speedAroundSpans,
} from './edit.timeline';

const words = toEditWords(RAW_TRANSCRIPT);
const cut = (src_start_ms: number, src_end_ms: number) => ({
  src_start_ms,
  src_end_ms,
  reason: 'silence',
});
const entry = (
  id: string,
  type: ActivityEntry['type'],
  start_ms: number,
  end_ms: number
): ActivityEntry => ({
  id,
  type,
  start_ms,
  end_ms,
  region: { x: 0, y: 0, w: 1, h: 1 },
  strength: 1,
  source: 'event_log',
});

// The fixture's silences: lead-in, three gaps of 600 ms or more, and the tail
const ALL_CUTS = [
  cut(0, 480),
  cut(2420, 3480),
  cut(5220, 5580),
  cut(6120, 8880),
  cut(10020, 12000),
];

describe('ai.video-editing: silenceCuts', () => {
  it('cuts gaps of 600 ms or more, keeping 120 ms each side; a 550 ms gap stays', () => {
    expect(silenceCuts(words, [], { durationMs: DURATION_MS })).toEqual(ALL_CUTS);
  });

  it('leaves the tail alone without a duration', () => {
    expect(silenceCuts(words, [])).toEqual(ALL_CUTS.slice(0, 4));
  });

  it('never cuts inside a protected span and drops what is left too short', () => {
    expect(
      silenceCuts(words, [{ start_ms: 2500, end_ms: 6500 }], {
        durationMs: DURATION_MS,
      })
    ).toEqual([cut(0, 480), cut(6500, 8880), cut(10020, 12000)]);
  });

  it('cuts nothing at all when a span covers every silence', () => {
    expect(
      silenceCuts(words, [{ start_ms: 0, end_ms: DURATION_MS }], {
        durationMs: DURATION_MS,
      })
    ).toEqual([]);
  });

  it('measures a gap from the latest word end, so overlapping words make no false gap', () => {
    const overlapping = toEditWords([
      { text: 'a', startMs: 100, endMs: 3000, type: 'word' },
      { text: 'b', startMs: 500, endMs: 900, type: 'word' },
      { text: 'c', startMs: 3700, endMs: 4000, type: 'word' },
    ]);
    expect(silenceCuts(overlapping, [])).toEqual([cut(3120, 3580)]);
  });

  it('honours its options and answers nothing for no speech', () => {
    expect(silenceCuts(words, [], { gapMs: 1000, keepMs: 100 })).toEqual([
      cut(2400, 3500),
      cut(6100, 8900),
    ]);
    expect(silenceCuts([], [])).toEqual([]);
  });
});

describe('ai.video-editing: silenceCuts inside a sentence', () => {
  // gaps: 600 (a to b), 600 (b to c), 1100 (c to d), 600 (d to e); the sentence ends after b
  const spoken = toEditWords([
    { text: 'a', startMs: 0, endMs: 200, type: 'word' },
    { text: 'b.', startMs: 800, endMs: 1000, type: 'word' },
    { text: 'c', startMs: 1600, endMs: 1800, type: 'word' },
    { text: 'd', startMs: 2900, endMs: 3100, type: 'word' },
    { text: 'e', startMs: 3700, endMs: 3900, type: 'word' },
  ]);
  const calm = { sentenceEnds: new Set([1]), minInsideMs: 1000 };

  it('cuts every gap of 600 ms or more without sentence ends (lively, no direction)', () => {
    expect(silenceCuts(spoken, [])).toEqual([
      cut(320, 680),
      cut(1120, 1480),
      cut(1920, 2780),
      cut(3220, 3580),
    ]);
  });

  it('does not cut a 600 ms gap inside a sentence in calm', () => {
    const cuts = silenceCuts(spoken, [], calm);
    expect(cuts).not.toContainEqual(cut(320, 680));
    expect(cuts).not.toContainEqual(cut(3220, 3580));
  });

  it('cuts a 600 ms gap after a sentence end in calm', () => {
    expect(silenceCuts(spoken, [], calm)).toContainEqual(cut(1120, 1480));
  });

  it('cuts a 1100 ms gap inside a sentence in calm', () => {
    expect(silenceCuts(spoken, [], calm)).toEqual([cut(1120, 1480), cut(1920, 2780)]);
  });

  it('keeps the lead-in and the tail as they are in calm', () => {
    const edges = toEditWords([
      { text: 'a', startMs: 700, endMs: 900, type: 'word' },
      { text: 'b', startMs: 1000, endMs: 1200, type: 'word' },
    ]);
    expect(silenceCuts(edges, [], { ...calm, sentenceEnds: new Set<number>(), durationMs: 2000 })).toEqual([
      cut(0, 580),
      cut(1320, 2000),
    ]);
  });

  it('needs both options: either alone cuts as before', () => {
    expect(silenceCuts(spoken, [], { sentenceEnds: new Set([1]) })).toEqual(silenceCuts(spoken, []));
    expect(silenceCuts(spoken, [], { minInsideMs: 1000 })).toEqual(silenceCuts(spoken, []));
  });
});

describe('ai.video-editing: buildMap', () => {
  it('lays the kept pieces end to end', () => {
    const map = buildMap(DURATION_MS, ALL_CUTS);
    expect(map.output_duration_ms).toBe(5360);
    expect(
      map.pieces.map((p) => [p.src_start_ms, p.src_end_ms, p.out_start_ms, p.out_end_ms])
    ).toEqual([
      [480, 2420, 0, 1940],
      [3480, 5220, 1940, 3680],
      [5580, 6120, 3680, 4220],
      [8880, 10020, 4220, 5360],
    ]);
  });

  it('is the identity with no cuts and no speed segments', () => {
    const map = buildMap(4000, []);
    expect(map.output_duration_ms).toBe(4000);
    expect(map.pieces).toHaveLength(1);
    expect(mapInstant(map, 1234)).toBe(1234);
  });

  it('plays a speed segment faster and splits its piece', () => {
    const map = buildMap(4000, [], [{ src_start_ms: 1000, src_end_ms: 2000, rate: 2 }]);
    expect(map.output_duration_ms).toBe(3500);
    expect(map.pieces.map((p) => p.rate)).toEqual([1, 2, 1]);
    expect(mapInstant(map, 1500)).toBe(1250);
    expect(mapInstant(map, 3000)).toBe(2500);
  });

  it('lets a cut win over a speed segment', () => {
    const map = buildMap(
      DURATION_MS,
      ALL_CUTS,
      [{ src_start_ms: 2000, src_end_ms: 4000, rate: 2 }]
    );
    expect(map.pieces.map((p) => [p.src_start_ms, p.src_end_ms, p.rate])).toEqual([
      [480, 2000, 1],
      [2000, 2420, 2],
      [3480, 4000, 2],
      [4000, 5220, 1],
      [5580, 6120, 1],
      [8880, 10020, 1],
    ]);
    expect(map.output_duration_ms).toBe(4890);
  });

  it('clamps cuts to the video and joins overlapping ones', () => {
    expect(buildMap(12000, [cut(11000, 15000)]).output_duration_ms).toBe(11000);
    expect(
      buildMap(12000, [cut(1000, 2000), cut(1500, 3000)]).output_duration_ms
    ).toBe(10000);
  });
});

describe('ai.video-editing: remap', () => {
  const map = buildMap(DURATION_MS, ALL_CUTS);

  it('maps an instant, snapping forward out of a cut', () => {
    expect(mapInstant(map, 600)).toBe(120);
    expect(mapInstant(map, 0)).toBe(0);
    expect(mapInstant(map, 3000)).toBe(1940);
    expect(mapInstant(map, 12000)).toBe(5360);
  });

  it('maps a stretch, clamped to what is kept', () => {
    expect(mapInterval(map, 2300, 2700)).toEqual({ start_ms: 1820, end_ms: 1940 });
    expect(mapInterval(map, 6200, 6400)).toBeNull();
  });

  it('shifts the words onto the output timeline', () => {
    const out = remapWords(words, map);
    const byWord = Object.fromEntries(out.map((w) => [w.w, [w.start_ms, w.end_ms]]));
    expect(byWord.So).toEqual([120, 420]);
    expect(byWord.and).toEqual([2060, 2260]);
    expect(byWord.now).toEqual([3800, 4100]);
    expect(byWord.thanks).toEqual([4340, 4840]);
    expect(byWord.bye).toEqual([4840, 5240]);
    expect(out).toHaveLength(words.length);
  });

  it('shifts the words through a speed segment', () => {
    const fast = buildMap(DURATION_MS, ALL_CUTS, [
      { src_start_ms: 3480, src_end_ms: 5220, rate: 2 },
    ]);
    expect(fast.output_duration_ms).toBe(4490);
    const byWord = Object.fromEntries(
      remapWords(words, fast).map((w) => [w.w, [w.start_ms, w.end_ms]])
    );
    expect(byWord.and).toEqual([2000, 2100]);
    expect(byWord.now).toEqual([2930, 3230]);
  });

  it('drops a word that was cut away and numbers the rest again', () => {
    const withHmm = toEditWords([
      ...RAW_TRANSCRIPT,
      { text: 'hmm', startMs: 3000, endMs: 3200, type: 'word' },
    ]);
    const out = remapWords(withHmm, map);
    expect(out.map((w) => w.w)).not.toContain('hmm');
    expect(out.map((w) => w.i)).toEqual(out.map((_, i) => i));
    expect(out).toHaveLength(words.length);
  });

  it('shifts the activity map: stretches clamp, cut ones go, markers snap forward, sorted by start', () => {
    const out = remapEntries(
      [
        entry('a', 'brush', 5700, 6000),
        entry('m', 'slide_change', 3000, 3000),
        entry('b', 'brush', 2300, 2700),
        entry('gone', 'motion', 6200, 6400),
        entry('tail', 'board_hide', 11000, 11000),
      ],
      map
    );
    expect(out.map((e) => [e.id, e.start_ms, e.end_ms])).toEqual([
      ['b', 1820, 1940],
      ['m', 1940, 1940],
      ['a', 3800, 4100],
      ['tail', 5360, 5360],
    ]);
  });

  it('shifts the facecam track into the plan shape; a move inside a cut shows right after it', () => {
    expect(remapFacecam(FACECAM, map)).toEqual([
      { t_ms: 0, cx: 0.78, cy: 0.62, radius: 0.13 },
      { t_ms: 1940, cx: 0.5, cy: 0.7, radius: 0.13 },
      { t_ms: 4840, cx: 0.3, cy: 0.7, radius: 0.1 },
    ]);
  });

  it('keeps the last of facecam keys that land on one moment', () => {
    const out = remapFacecam(
      [
        { t_ms: 0, cx: 0.1, cy: 0.1, r: 0.1 },
        { t_ms: 400, cx: 0.9, cy: 0.9, r: 0.2 },
      ],
      map
    );
    expect(out).toEqual([{ t_ms: 0, cx: 0.9, cy: 0.9, radius: 0.2 }]);
  });
});

describe('ai.video-editing: speedAroundSpans', () => {
  it('keeps speed segments out of protected spans', () => {
    expect(
      speedAroundSpans(
        [{ src_start_ms: 1000, src_end_ms: 5000, rate: 2 }],
        [{ start_ms: 2000, end_ms: 3000 }]
      )
    ).toEqual([
      { src_start_ms: 1000, src_end_ms: 2000, rate: 2 },
      { src_start_ms: 3000, src_end_ms: 5000, rate: 2 },
    ]);
  });
});
