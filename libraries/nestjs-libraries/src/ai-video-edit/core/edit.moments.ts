// AI video editing (ai.video-editing), planner core: the moments of a video on the output timeline. A sentence of the
// transcript, a stretch of drawing and a topic change are each one moment; the director labels the sentences and the
// rules label the events. Pure functions: no Nest, no IO, no logging (a moment's text is never kept here, only times,
// word indexes and labels).
import {
  ActivityEntry,
  EditStyle,
  EditWord,
  MomentLabel,
} from '../contract/edit.contract';
import { ContentKeepOut } from './edit.geometry';
import { TimeMap, mapInstant, mapInterval, remapWords } from './edit.timeline';

// One moment: ids are s1.. for sentences, d1.. for drawings and c1.. for chapters.
export interface Moment {
  id: string;
  kind: 'sentence' | 'drawing' | 'chapter';
  start_ms: number;
  end_ms: number;
  // sentence: the first and last word index (`EditWord.i`)
  word_from?: number;
  word_to?: number;
  // drawing: the union box of its strokes, in master fractions
  region?: { x: number; y: number; w: number; h: number };
  label: MomentLabel;
}

// What the director decided: the style of the video and the labelled moments. `none` = no director (the plan is
// then what the planner makes without one).
export interface Direction {
  style: EditStyle;
  moments: Moment[];
  source: 'director' | 'none';
}

// The labels the director may give a sentence; the other labels belong to the rules.
export const SENTENCE_LABELS: MomentLabel[] = [
  'hook',
  'claim',
  'reason',
  'example',
  'recap',
  'cta',
  'plain',
];

export const MOMENT_LIMITS = {
  // a pause this long (or longer) between two words ends the sentence; natural speech pauses reach ~1.4 s inside one
  sentence_gap_ms: 1500,
  // strokes closer than this are one drawing
  drawing_join_ms: 1500,
  // the hook sits in one of the first sentences
  hook_within: 2,
  // two claims start at least this far apart
  claim_spacing_ms: 20000,
};

// Sentence-final punctuation of several scripts, optionally followed by closing quotes or brackets.
export const SENTENCE_END = /[.!?।؟。][)\]}"'»”’]*$/;

// The sentences: the words split after a word that ends with sentence-final punctuation or that is followed by a
// pause of `sentence_gap_ms` or more (counted from the latest word end so far, as words may overlap).
export const sentenceMoments = (words: EditWord[]): Moment[] => {
  const moments: Moment[] = [];
  let from = 0;
  let latestEnd = words.length ? words[0].end_ms : 0;
  for (let k = 0; k < words.length; k++) {
    latestEnd = Math.max(latestEnd, words[k].end_ms);
    const next = words[k + 1];
    const ends =
      !next ||
      SENTENCE_END.test(words[k].w.trim()) ||
      next.start_ms - latestEnd >= MOMENT_LIMITS.sentence_gap_ms;
    if (!ends) continue;
    moments.push({
      id: `s${moments.length + 1}`,
      kind: 'sentence',
      start_ms: words[from].start_ms,
      end_ms: latestEnd,
      word_from: words[from].i,
      word_to: words[k].i,
      label: 'plain',
    });
    from = k + 1;
    if (next) latestEnd = next.end_ms;
  }
  return moments;
};

// The drawings: `brush` entries of the activity map (output timeline) closer than `drawing_join_ms` are joined into
// one moment. The region is the union box of the strokes; every brush entry carries its own region.
export const drawingMoments = (activity: ActivityEntry[]): Moment[] => {
  const brushes = activity
    .filter((a) => a.type === 'brush')
    .sort((a, b) => a.start_ms - b.start_ms);
  const moments: Moment[] = [];
  let last: Moment | null = null;
  for (const b of brushes) {
    const box = b.region;
    if (last && b.start_ms - last.end_ms < MOMENT_LIMITS.drawing_join_ms) {
      const r = last.region!;
      const x = Math.min(r.x, box.x);
      const y = Math.min(r.y, box.y);
      last.end_ms = Math.max(last.end_ms, b.end_ms);
      last.region = {
        x,
        y,
        w: Math.max(r.x + r.w, box.x + box.w) - x,
        h: Math.max(r.y + r.h, box.y + box.h) - y,
      };
      continue;
    }
    last = {
      id: `d${moments.length + 1}`,
      kind: 'drawing',
      start_ms: b.start_ms,
      end_ms: Math.max(b.start_ms, b.end_ms),
      region: { ...box },
      label: 'drawing',
    };
    moments.push(last);
  }
  return moments;
};

// The topic changes, as instants `[t-1, t]` on the output timeline. From the request's chapters (source time, moved
// to the output with `map`) when it has any, else from the `slide_change` markers of `activity` (already on the
// output timeline). `chapters` is `EditRequest['chapters']`, typed unknown because a traced request stores a summary
// object instead of the list: only a real array is read. A chapter at the very start or at the very end of the
// output is skipped, and so is a second one on the same instant.
export const chapterMoments = (
  chapters: unknown,
  activity: ActivityEntry[],
  map: TimeMap
): Moment[] => {
  const fromChapters = Array.isArray(chapters)
    ? chapters
        .filter((c) => c && Number.isFinite(c.start_ms))
        .map((c) => mapInstant(map, c.start_ms))
    : [];
  const times = fromChapters.length
    ? fromChapters
    : activity.filter((a) => a.type === 'slide_change').map((a) => a.start_ms);
  const unique = Array.from(new Set(times))
    .filter((t) => t > 0 && t < map.output_duration_ms)
    .sort((a, b) => a - b);
  return unique.map((t, k) => ({
    id: `c${k + 1}`,
    kind: 'chapter',
    start_ms: t - 1,
    end_ms: t,
    label: 'chapter',
  }));
};

// Where a text or an icon must keep off, on the output timeline. The ink: each `brush` region from its start until the
// next `slide_change`, the next chapter or (when the stroke was drawn on the board, the board being shown at its start)
// the next `board_hide`; with none of them, until the end of the video. The slide title: the region of the chapter active
// for each stretch (from its start to the next chapter's). `activity` and `chapters` are on the SOURCE timeline (as the
// request has them), `map` moves each stretch to the output; a stretch that was cut away is left out. `chapters` is typed
// unknown like `chapterMoments`': only a real array is read, and only a region with a size counts.
export const contentKeepouts = (activity: ActivityEntry[], chapters: unknown, map: TimeMap): ContentKeepOut[] => {
  const valid = (r: ContentKeepOut['region'] | undefined): r is ContentKeepOut['region'] =>
    !!r && [r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)) && r.w > 0 && r.h > 0;
  const list = (Array.isArray(chapters) ? chapters : [])
    .filter((c) => c && Number.isFinite(c.start_ms))
    .sort((a, b) => a.start_ms - b.start_ms);
  const found: ContentKeepOut[] = [];
  const push = (start: number, end: number, region: ContentKeepOut['region']) => {
    const span = end > start ? mapInterval(map, start, end) : null;
    if (span && span.end_ms > span.start_ms) found.push({ ...span, region: { ...region } });
  };
  const first = (times: number[], after: number) => Math.min(map.src_duration_ms, ...times.filter((t) => t > after));
  const changes = [...activity.filter((a) => a.type === 'slide_change').map((a) => a.start_ms), ...list.map((c) => c.start_ms)];
  const hides = activity.filter((a) => a.type === 'board_hide').map((a) => a.start_ms);
  const boardEvents = activity
    .filter((a) => a.type === 'board_show' || a.type === 'board_hide')
    .sort((a, b) => a.start_ms - b.start_ms);
  for (const b of activity) {
    if (b.type !== 'brush' || !valid(b.region)) continue;
    const lastBoard = boardEvents.filter((e) => e.start_ms <= b.start_ms).pop();
    const stops = lastBoard && lastBoard.type === 'board_show' ? [...changes, ...hides] : changes;
    push(b.start_ms, Math.max(b.end_ms, first(stops, b.start_ms)), b.region);
  }
  list.forEach((c, k) => {
    if (!valid(c.region)) return;
    push(c.start_ms, list[k + 1] ? list[k + 1].start_ms : map.src_duration_ms, c.region);
  });
  return found;
};

// Every moment, sorted by start (a sentence before a drawing before a chapter on a tie); sentences start `plain`.
// `activity` and `words` are on the output timeline, `chapters` on the source one (`map` moves them).
export const buildMoments = (
  words: EditWord[],
  activity: ActivityEntry[],
  chapters: unknown,
  map: TimeMap
): Moment[] =>
  [
    ...sentenceMoments(words),
    ...drawingMoments(activity),
    ...chapterMoments(chapters, activity, map),
  ]
    .map((m, idx) => ({ m, idx }))
    .sort((a, b) => a.m.start_ms - b.m.start_ms || a.idx - b.idx)
    .map((x) => x.m);

// The director's labels laid on the moments (a new list, the input is not changed). Only sentences take a label from
// the answer: an unknown id is ignored, a label outside the sentence labels becomes `plain`. Then the limits: only
// the first `hook` stays and only within the first sentences, and a `claim` stays only when the last kept one
// started `claim_spacing_ms` or more before it (the later ones become `plain`).
export const applyLabels = (
  moments: Moment[],
  answer: { labels: { id: string; label: string }[] }
): Moment[] => {
  const given = new Map<string, string>();
  for (const l of answer.labels) {
    if (!given.has(l.id)) given.set(l.id, l.label);
  }
  let sentence = 0;
  let hookSeen = false;
  let lastClaimStart: number | null = null;
  return moments.map((m) => {
    if (m.kind !== 'sentence') return { ...m };
    sentence++;
    const asked = given.get(m.id);
    let label: MomentLabel = SENTENCE_LABELS.includes(asked as MomentLabel)
      ? (asked as MomentLabel)
      : 'plain';
    if (label === 'hook') {
      if (hookSeen || sentence > MOMENT_LIMITS.hook_within) label = 'plain';
      else hookSeen = true;
    } else if (label === 'claim') {
      if (
        lastClaimStart !== null &&
        m.start_ms - lastClaimStart < MOMENT_LIMITS.claim_spacing_ms
      ) {
        label = 'plain';
      } else {
        lastClaimStart = m.start_ms;
      }
    }
    return { ...m, label };
  });
};

// The director's direction (as kept, on the SOURCE timeline) laid on the output timeline the planner works on; none when
// there is no direction or it has `source: 'none'`. A sentence follows its words: `word_from`/`word_to` become the
// indexes of the first and the last of its words that were kept, its times come from those output words, and a sentence
// whose words were all cut is dropped. A drawing goes through the source to output remap (dropped when all of it was
// cut). A chapter is an instant `[t-1, t]`: `t` is mapped as an instant and the chapter is dropped when it falls at the
// very start or end of the output or on the instant of an earlier chapter. Ids and labels stay (the picks are keyed by
// the id). `words` are the source words, `outWords` the same words after `remapWords` with `map`.
export const anchorDirection = (
  kept: Direction | null | undefined,
  words: EditWord[],
  outWords: EditWord[],
  map: TimeMap
): Direction | undefined => {
  if (!kept || kept.source !== 'director' || !Array.isArray(kept.moments)) return undefined;
  // source word index (`EditWord.i`) to its place among the output words; a word that was cut has none
  const outIndex = new Map<number, number>();
  for (const w of words) {
    if (remapWords([w], map).length === 1) outIndex.set(w.i, outIndex.size);
  }
  const moments: Moment[] = [];
  const instants = new Set<number>();
  for (const m of kept.moments) {
    if (m.kind === 'sentence') {
      const inside = Array.from(outIndex.entries())
        .filter(([i]) => i >= (m.word_from as number) && i <= (m.word_to as number))
        .map(([, k]) => k);
      if (!inside.length) continue;
      const from = Math.min(...inside);
      const to = Math.max(...inside);
      moments.push({
        ...m,
        start_ms: outWords[from].start_ms,
        end_ms: Math.max(...inside.map((k) => outWords[k].end_ms)),
        word_from: from,
        word_to: to,
      });
    } else if (m.kind === 'drawing') {
      const span =
        m.end_ms > m.start_ms
          ? mapInterval(map, m.start_ms, m.end_ms)
          : { start_ms: mapInstant(map, m.start_ms), end_ms: mapInstant(map, m.start_ms) };
      if (span) moments.push({ ...m, start_ms: span.start_ms, end_ms: span.end_ms });
    } else if (m.kind === 'chapter') {
      const t = mapInstant(map, m.end_ms);
      if (t <= 0 || t >= map.output_duration_ms || instants.has(t)) continue;
      instants.add(t);
      moments.push({ ...m, start_ms: t - 1, end_ms: t });
    }
  }
  return { style: kept.style, source: 'director', moments };
};

// The sentences a calm video shows an icon on: the ones that name a thing to look at.
export const ICON_LABELS: MomentLabel[] = ['example', 'reason', 'claim'];

// Where an icon is welcome at the word `wordIndex` (an output word index) of a calm video: 0 in a sentence labelled
// example, reason or claim, 1 in a plain sentence (only when no sentence of tier 0 got an icon), 2 anywhere else (hook,
// recap, cta, a word outside every sentence). A lively video, or one with no direction, has no such limit: always 0.
export const iconTier = (direction: Direction | undefined, wordIndex: number): 0 | 1 | 2 => {
  if (!direction || direction.source !== 'director' || direction.style !== 'calm') return 0;
  const sentence = direction.moments.find(
    (m) => m.kind === 'sentence' && wordIndex >= (m.word_from as number) && wordIndex <= (m.word_to as number)
  );
  if (!sentence) return 2;
  return ICON_LABELS.includes(sentence.label) ? 0 : sentence.label === 'plain' ? 1 : 2;
};
