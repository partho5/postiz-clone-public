// AI video editing (ai.video-editing): protected spans and free windows (spec section 10). Needs no database and no Nest.
import {
  BRUSH_START_MIDDLE_END,
  OVERLAPPING,
  TINY_GAPS,
} from './fixtures/edit.fixtures';
import {
  freeWindows,
  mergeSpans,
  protectedSpans,
  subtractSpans,
} from './edit.windows';

const span = (start_ms: number, end_ms: number) => ({ start_ms, end_ms });

describe('ai.video-editing: protectedSpans', () => {
  it('pads brush at the start, in the middle and at the end, held inside the video', () => {
    expect(protectedSpans(BRUSH_START_MIDDLE_END, 20000)).toEqual([
      span(0, 2300),
      span(9700, 12300),
      span(18200, 20000),
    ]);
  });

  it('never protects markers', () => {
    const markers = BRUSH_START_MIDDLE_END.filter((a) => a.id.startsWith('m'));
    expect(markers).toHaveLength(2);
    expect(protectedSpans(markers, 20000)).toEqual([]);
  });

  it('joins overlapping strokes and a motion entry that touches them', () => {
    expect(protectedSpans(OVERLAPPING, 20000)).toEqual([span(4700, 7500)]);
  });

  it('joins strokes 300 ms apart and keeps strokes 700 ms apart separate', () => {
    expect(protectedSpans(TINY_GAPS, 20000)).toEqual([
      span(2700, 4500),
      span(4600, 5600),
      span(5700, 6700),
    ]);
  });

  it('ignores entries outside the video and answers nothing for an empty map', () => {
    const outside = [{ ...OVERLAPPING[0], start_ms: 30000, end_ms: 31000 }];
    expect(protectedSpans(outside, 20000)).toEqual([]);
    expect(protectedSpans([], 20000)).toEqual([]);
  });
});

describe('ai.video-editing: freeWindows', () => {
  it('is the timeline minus the protected spans', () => {
    const spans = protectedSpans(BRUSH_START_MIDDLE_END, 20000);
    expect(freeWindows(20000, spans)).toEqual([
      span(2300, 9700),
      span(12300, 18200),
    ]);
  });

  it('drops windows shorter than 500 ms and keeps one of exactly 500 ms', () => {
    expect(
      freeWindows(20000, [span(2700, 3800), span(4100, 5000)])
    ).toEqual([span(0, 2700), span(5000, 20000)]);
    expect(
      freeWindows(20000, [span(1000, 2000), span(2500, 3000)])
    ).toEqual([span(0, 1000), span(2000, 2500), span(3000, 20000)]);
  });

  it('drops the 100 ms windows between close padded spans', () => {
    const spans = protectedSpans(TINY_GAPS, 20000);
    expect(freeWindows(20000, spans)).toEqual([
      span(0, 2700),
      span(6700, 20000),
    ]);
  });

  it('answers the whole video with no spans and nothing when covered or too short', () => {
    expect(freeWindows(20000, [])).toEqual([span(0, 20000)]);
    expect(freeWindows(1000, [span(0, 1000)])).toEqual([]);
    expect(freeWindows(400, [])).toEqual([]);
  });
});

describe('ai.video-editing: mergeSpans and subtractSpans', () => {
  it('merges overlapping, touching and (with a gap) close spans', () => {
    expect(mergeSpans([span(500, 900), span(0, 400), span(400, 450)])).toEqual([
      span(0, 450),
      span(500, 900),
    ]);
    expect(mergeSpans([span(0, 400), span(700, 900)], 400)).toEqual([span(0, 900)]);
    expect(mergeSpans([span(0, 400), span(800, 900)], 400)).toEqual([
      span(0, 400),
      span(800, 900),
    ]);
  });

  it('cuts spans out of a range', () => {
    expect(subtractSpans(0, 1000, [span(200, 300), span(900, 1500)])).toEqual([
      span(0, 200),
      span(300, 900),
    ]);
    expect(subtractSpans(100, 200, [span(0, 500)])).toEqual([]);
    expect(subtractSpans(100, 200, [])).toEqual([span(100, 200)]);
  });
});
