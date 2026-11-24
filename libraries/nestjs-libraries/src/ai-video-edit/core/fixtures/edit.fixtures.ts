// AI video editing (ai.video-editing), planner core fixtures: a short transcript and activity maps shared by the
// core specs. Imports nothing but contract types.
import { ActivityEntry, FacecamKey } from '../../contract/edit.contract';
import { RawWord } from '../edit.words';

// A 12 s recording.
export const DURATION_MS = 12000;

// One raw item of the transcript; `type` defaults to a spoken word.
const raw = (
  text: string,
  startMs: number,
  endMs: number,
  type = 'word'
): RawWord => ({ text, startMs, endMs, type });

// The transcript as the transcriber returns it: spoken words with spacing and audio events between them.
// Gaps between words: 1300 (w4 to w5), 550 (w6 to w7), 600 (w7 to w8), 3000 (w8 to w9); 600 ms of lead-in before
// the first word and 2100 ms of tail after the last.
export const RAW_TRANSCRIPT: RawWord[] = [
  raw('So', 600, 900),
  raw(' ', 900, 900, 'spacing'),
  raw('today', 900, 1300),
  raw('we', 1350, 1500),
  raw('start', 1500, 1900),
  raw('here', 1900, 2300),
  raw('[laughter]', 2300, 3000, 'audio_event'),
  raw('and', 3600, 3800),
  raw('then', 3800, 4200),
  raw('stop', 4750, 5100),
  raw('now', 5700, 6000),
  raw('thanks', 9000, 9500),
  raw('bye', 9500, 9900),
];

// Brush at the start, in the middle and at the end of a 20 s recording, plus markers that are never protected.
export const BRUSH_START_MIDDLE_END: ActivityEntry[] = [
  entry('a1', 'brush', 0, 2000),
  entry('a2', 'brush', 10000, 12000),
  entry('a3', 'brush', 18500, 20000),
  entry('m1', 'slide_change', 8000, 8000),
  entry('m2', 'board_show', 14000, 14000),
];

// Two strokes that overlap, and a motion entry that touches the second.
export const OVERLAPPING: ActivityEntry[] = [
  entry('a1', 'brush', 5000, 6000),
  entry('a2', 'brush', 5800, 7000),
  entry('a3', 'motion', 7000, 7200),
];

// Strokes with tiny gaps: a1 and a2 are 300 ms apart (one busy span); a3 and a4 are 700 ms apart from it and each
// other, so their padded spans leave windows of only 100 ms between them.
export const TINY_GAPS: ActivityEntry[] = [
  entry('a1', 'brush', 3000, 3500),
  entry('a2', 'brush', 3800, 4200),
  entry('a3', 'brush', 4900, 5300),
  entry('a4', 'brush', 6000, 6400),
];

// The facecam: starts at the right, moves down at 3 s (inside a cut of the silence fixture) and again at 9.5 s.
export const FACECAM: FacecamKey[] = [
  { t_ms: 0, cx: 0.78, cy: 0.62, r: 0.13 },
  { t_ms: 3000, cx: 0.5, cy: 0.7, r: 0.13 },
  { t_ms: 9500, cx: 0.3, cy: 0.7, r: 0.1 },
];

// An activity entry as the app sends it.
function entry(
  id: string,
  type: ActivityEntry['type'],
  startMs: number,
  endMs: number
): ActivityEntry {
  return {
    id,
    type,
    start_ms: startMs,
    end_ms: endMs,
    region: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
    strength: 1,
    source: 'event_log',
  };
}
