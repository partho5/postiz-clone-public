// AI video editing (ai.video-editing), golden plan fixtures: three English and two Bengali transcripts with their
// activity maps and facecam tracks, and the request that goes with each. Imports nothing but contract types.
import {
  ActivityEntry,
  EditRequest,
  EditRequestOutput,
  FacecamKey,
  Palette,
  TextLook,
} from '../../contract/edit.contract';
import { TEXT_MOTION_IDS } from '../../contract/edit.motions';
import { EFFECTS } from '../../contract/edit.registry';
import { PALETTE, TEXT_LOOKS } from '../../contract/edit.styles';
import { RawWord } from '../edit.words';

// One word of a script, or a word with the silence before it in milliseconds (default 60).
export type ScriptWord = string | [string, number];

// A transcript as the transcriber returns it: a word lasts 120 ms plus 45 ms a character, `gap` ms apart.
export const speak = (script: ScriptWord[], startMs = 150): RawWord[] => {
  const out: RawWord[] = [];
  let t = startMs;
  script.forEach((entry, k) => {
    const [text, gap]: [string, number] = typeof entry === 'string' ? [entry, 60] : entry;
    if (k > 0) t += gap;
    const end = t + 120 + 45 * Array.from(text).length;
    out.push({ text, startMs: t, endMs: end, type: 'word' });
    t = end;
  });
  return out;
};

// A brush, motion or marker entry.
export const act = (
  id: string,
  type: ActivityEntry['type'],
  start_ms: number,
  end_ms: number
): ActivityEntry => ({
  id,
  type,
  start_ms,
  end_ms,
  region: { x: 0.1, y: 0.2, w: 0.6, h: 0.3 },
  strength: 1,
  source: 'event_log',
});

// The three outputs of a 1080 x 2400 master, 9:16 first (top-anchored crops of 0.8, 0.5625 and 0.45 of the height).
export const ALL_OUTPUTS: EditRequestOutput[] = [
  { ratio: '9:16', crop: { x: 0, y: 0, w: 1, h: 0.8 }, caption_band: { y0: 0.88, y1: 0.99 } },
  { ratio: '4:5', crop: { x: 0, y: 0, w: 1, h: 0.5625 }, caption_band: { y0: 0.86, y1: 0.96 } },
  { ratio: '1:1', crop: { x: 0, y: 0, w: 1, h: 0.45 }, caption_band: { y0: 0.82, y1: 0.94 } },
];

// A phone that can render every effect, text look and text motion of the contract.
export const FULL_CAPABILITIES = {
  effects: EFFECTS.map((e) => e.id),
  text_styles: TEXT_LOOKS.map((l) => l.id),
  text_motions: TEXT_MOTION_IDS,
};

// An installed phone: the same effects and looks, and no `text_motions` (it draws only the legacy motions).
export const LEGACY_CAPABILITIES = {
  effects: FULL_CAPABILITIES.effects,
  text_styles: FULL_CAPABILITIES.text_styles,
};

// A test look table (card S9): the shipped looks, but `label_pill` draws a left to right gradient on the text, so it needs the
// feature below. Today's six looks need no feature, so a spec brings this table to the chooser and the validator instead
// of adding a look to `TEXT_LOOKS` (which a snapshot freezes). It is `label_pill` because every text look has a
// background (TS13): the chooser plans no look without one, and `label_pill` is the shipped look that has one and
// needs no feature of its own.
export const GATED_LOOK_ID = 'label_pill';
export const GATED_LOOK_FEATURE = 'text_gradient_ltr';
export const GATED_LOOKS: TextLook[] = TEXT_LOOKS.map((l) =>
  l.id === GATED_LOOK_ID ? { ...l, text_fill: { kind: 'gradient', direction: 'ltr', from: 'accent', to: 'paper' } } : l
);

// The multi colour palette the server resolves.
export const MULTI_PALETTE: Palette = { mode: 'multi', colors: PALETTE.multi };

export interface GoldenFixture {
  name: string;
  language: string;
  words: RawWord[];
  activity: ActivityEntry[];
  facecam: FacecamKey[];
  // The video's length when it is not the last word plus 1.5 s, and the topic changes the request carries.
  duration_ms?: number;
  chapters?: EditRequest['chapters'];
}

// The request of a fixture: 1.5 s of silence after the last word (unless it says its length), all three outputs, every effect
// available.
export const goldenRequest = (f: GoldenFixture): EditRequest => ({
  contract_version: 2,
  video: {
    duration_ms: f.duration_ms ?? f.words[f.words.length - 1].endMs + 1500,
    width: 1080,
    height: 2400,
    fps: 30,
    source: 'in_app_recording',
  },
  outputs: ALL_OUTPUTS,
  facecam_track: f.facecam,
  activity_map: f.activity,
  ...(f.chapters ? { chapters: f.chapters } : {}),
  text_colors: 'multi',
  language: f.language,
  capabilities: FULL_CAPABILITIES,
  options: { sound_effects: true },
});

// English 1: a tutorial with a brush stroke in the middle and one near the end, the facecam moving down once.
const EN_TUTORIAL = speak([
  'Hey', 'everyone,', 'today', 'I', 'will', 'show', 'you', '3', 'simple', 'ways', 'to', 'save', 'time', 'with',
  'your', 'computer.',
  ['First,', 700], 'learn', 'keyboard', 'shortcuts.', 'They', 'can', 'save', 'you', 'almost', 'an', 'hour',
  'every', 'single', 'week.',
  ['Second,', 900], 'automate', 'boring', 'tasks', 'with', 'small', 'scripts.',
  ['Third,', 800], 'organize', 'your', 'files', 'in', 'one', 'clear', 'folder', 'structure.',
  ['That', 700], 'is', 'it,', 'thanks', 'for', 'watching.',
]);

// English 2: a talking head with no activity and no facecam in the picture at all.
const EN_TALK = speak([
  'Most', 'people', 'think', 'success', 'comes', 'from', 'talent.',
  ['But', 800], 'after', 'ten', 'years', 'of', 'building', 'companies,', 'I', 'learned', 'something', 'different.',
  ['Success', 900], 'comes', 'from', 'showing', 'up', 'every', 'single', 'day.',
  ['Even', 700], 'when', 'you', 'do', 'not', 'feel', 'like', 'it.',
  ['Consistency', 800], 'beats', 'intensity,', 'always.',
  ['So', 700], 'start', 'small,', 'stay', 'consistent,', 'and', 'trust', 'the', 'process.',
]);

// English 3: a short lesson with the board shown, two brush strokes, a motion entry and slide changes.
const EN_BOARD = speak([
  'Let', 'me', 'explain', 'how', 'compound', 'interest', 'works.',
  ['If', 700], 'you', 'invest', '1000', 'dollars', 'at', '7', 'percent,', 'after', 'thirty', 'years', 'you', 'will',
  'have', 'almost', '7600', 'dollars.',
  ['The', 800], 'secret', 'is', 'time,', 'not', 'the', 'amount.',
  ['Start', 700], 'early', 'and', 'let', 'it', 'grow.',
]);

// Bengali 1: health tips with a brush stroke in the middle.
const BN_HEALTH = speak([
  'সবাইকে', 'নমস্কার,', 'আজ', 'আমি', 'আপনাদের', 'তিনটি', 'সহজ', 'স্বাস্থ্য', 'পরামর্শ', 'দেব।',
  ['প্রথমত,', 800], 'প্রতিদিন', 'সকালে', 'পর্যাপ্ত', 'পানি', 'পান', 'করুন।',
  ['দ্বিতীয়ত,', 900], 'রাতে', 'অন্তত', 'সাত', 'ঘণ্টা', 'ঘুমানো', 'খুব', 'গুরুত্বপূর্ণ।',
  ['তৃতীয়ত,', 800], 'নিয়মিত', 'হাঁটার', 'অভ্যাস', 'করুন।',
  ['ধন্যবাদ।', 700],
]);

// Bengali 2: a business lesson with Bengali digits, the board shown and hidden, and a stroke.
const BN_BUSINESS = speak([
  'ব্যবসা', 'শুরু', 'করার', 'আগে', 'বাজার', 'সম্পর্কে', 'ভালো', 'করে', 'জানুন।',
  ['প্রথমে', 800], 'দেখুন', 'গ্রাহকরা', 'কী', 'চান।',
  ['তারপর', 700], 'আপনার', 'পণ্যের', 'দাম', 'ঠিক', 'করুন।',
  ['১০০', 800], 'টাকার', 'পণ্য', '১২০', 'টাকায়', 'বিক্রি', 'করলে', 'লাভ', 'হবে।',
  ['সবচেয়ে', 900], 'গুরুত্বপূর্ণ', 'হলো', 'ধৈর্য', 'ধরা।',
]);

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    name: 'english tutorial',
    language: 'eng',
    words: EN_TUTORIAL,
    activity: [
      act('a1', 'brush', 9000, 12500),
      act('a2', 'brush', 21000, 22500),
      act('m1', 'slide_change', 15500, 15500),
    ],
    facecam: [
      { t_ms: 0, cx: 0.78, cy: 0.62, r: 0.13 },
      { t_ms: 12500, cx: 0.78, cy: 0.7, r: 0.13 },
    ],
  },
  {
    name: 'english talking head',
    language: 'eng',
    words: EN_TALK,
    activity: [],
    facecam: [],
  },
  {
    name: 'english board lesson',
    language: 'eng',
    words: EN_BOARD,
    activity: [
      act('m1', 'slide_change', 4000, 4000),
      act('m2', 'board_show', 5400, 5400),
      act('a1', 'brush', 5600, 8000),
      act('m3', 'board_hide', 8100, 8100),
      act('a2', 'motion', 14000, 14600),
    ],
    facecam: [
      { t_ms: 0, cx: 0.78, cy: 0.62, r: 0.13 },
      { t_ms: 5400, cx: 0.22, cy: 0.72, r: 0.1 },
    ],
  },
  {
    name: 'bengali health tips',
    language: 'ben',
    words: BN_HEALTH,
    activity: [act('a1', 'brush', 8000, 11000), act('m1', 'slide_change', 14000, 14000)],
    facecam: [{ t_ms: 0, cx: 0.78, cy: 0.62, r: 0.13 }],
  },
  {
    name: 'bengali business lesson',
    language: 'ben',
    words: BN_BUSINESS,
    activity: [
      act('m1', 'board_show', 7000, 7000),
      act('a1', 'brush', 7200, 9500),
      act('m2', 'board_hide', 9600, 9600),
    ],
    facecam: [
      { t_ms: 0, cx: 0.5, cy: 0.72, r: 0.11 },
      { t_ms: 7000, cx: 0.8, cy: 0.74, r: 0.11 },
    ],
  },
];

// The trust sample (task TS8): a screen recording about a "nicely edited video", 122 synthetic words at the timings of the
// owner's real transcript (no real word is kept: `w1..w122`, the marks stay on the 9 sentence ends), and the activity map of
// its event log (3 slide changes, 4 brush strokes, the board shown and hidden), 67.966 s long, with a large facecam.
const TRUST_TIMES: [number, number][] = [
  [880, 940], [1040, 1500], [1600, 1900], [2060, 2340], [2440, 2780], [2880, 3260], [3600, 4040], [4760, 5020],
  [5240, 5360], [5400, 5520], [5820, 6020], [6120, 6260], [6420, 6740], [6920, 7320], [7420, 8080], [8200, 8460],
  [8700, 8980], [9320, 9620], [10040, 10400], [10460, 10820], [10900, 11080], [11460, 12020], [12120, 12440],
  [12620, 13080], [13140, 13360], [13780, 14000], [14500, 14520], [14540, 14680], [14740, 15020], [15380, 15520],
  [15760, 16200], [16680, 16960], [17240, 17700], [17960, 18280], [18340, 18660], [18720, 19000], [19100, 19220],
  [19260, 19380], [19480, 19760], [19860, 19960], [20420, 20600], [20680, 21120], [21200, 21600], [21720, 22020],
  [22640, 23060], [23140, 23600], [23700, 24080], [24800, 25180], [25240, 25440], [26100, 26400], [26800, 27080],
  [28220, 28320], [29740, 30040], [30380, 30800], [31020, 31100], [31160, 31380], [31460, 31700], [31940, 32200],
  [32259, 32420], [32460, 32619], [32800, 33200], [33260, 33420], [33640, 34140], [34260, 34480], [34560, 34960],
  [35060, 35260], [35680, 36000], [36060, 36440], [36540, 36880], [37060, 37320], [38160, 38600], [38680, 39020],
  [39620, 40040], [40160, 40460], [40560, 41280], [41640, 41800], [41980, 42460], [42540, 42780], [42860, 43440],
  [43520, 43580], [43600, 43700], [43740, 44180], [44220, 44400], [45040, 45080], [45120, 45260], [45320, 45600],
  [46040, 46060], [46080, 46200], [46920, 47340], [47380, 47540], [47600, 47800], [48260, 48440], [48880, 48900],
  [48940, 49040], [49100, 49400], [49500, 49600], [49640, 50040], [50120, 50540], [50620, 50760], [51440, 51960],
  [52100, 52500], [52680, 53020], [53080, 53460], [53900, 54260], [54320, 54680], [55700, 55980], [56940, 57180],
  [57300, 57400], [57540, 57840], [58280, 58900], [59380, 59840], [59980, 60200], [60600, 60840], [60900, 61280],
  [61560, 61920], [61980, 62380], [62440, 62840], [63340, 63580], [64160, 64500], [64620, 64900], [65000, 65459],
  [65920, 66520],
];

// The words that end a sentence (1 based): 9 sentences, s1 to s9.
export const TRUST_SENTENCE_ENDS = [7, 50, 65, 72, 82, 101, 105, 117, 122];

const trustWords: RawWord[] = TRUST_TIMES.map(([startMs, endMs], k) => ({
  text: `w${k + 1}${TRUST_SENTENCE_ENDS.includes(k + 1) ? '.' : ''}`,
  startMs,
  endMs,
  type: 'word',
}));

const trustEntry = (
  id: string,
  type: ActivityEntry['type'],
  start_ms: number,
  end_ms: number,
  region: ActivityEntry['region']
): ActivityEntry => ({ id, type, start_ms, end_ms, region, strength: 1, source: 'event_log' });

const WHOLE = { x: 0, y: 0, w: 1, h: 1 };

export const TRUST_SAMPLE: GoldenFixture = {
  name: 'trust sample',
  language: 'eng',
  words: trustWords,
  activity: [
    trustEntry('a1', 'slide_change', 4785, 4785, WHOLE),
    trustEntry('a2', 'brush', 9887, 10507, { x: 0.1476, y: 0.1134, w: 0.5563, h: 0.0903 }),
    trustEntry('a3', 'brush', 13908, 14350, { x: 0.2382, y: 0.1563, w: 0.5777, h: 0.1305 }),
    trustEntry('a4', 'slide_change', 28012, 28012, WHOLE),
    trustEntry('a5', 'brush', 45811, 46528, { x: 0.3707, y: 0.0832, w: 0.4577, h: 0.1311 }),
    trustEntry('a6', 'board_show', 48394, 48394, WHOLE),
    trustEntry('a7', 'brush', 49511, 49877, { x: 0.2385, y: 0.1153, w: 0.6372, h: 0.1669 }),
    trustEntry('a8', 'board_hide', 53387, 53387, WHOLE),
    trustEntry('a9', 'slide_change', 54977, 54977, WHOLE),
  ],
  facecam: [{ t_ms: 0, cx: 0.5005, cy: 0.4194, r: 0.3125 }],
  duration_ms: 67966,
  chapters: [
    { start_ms: 0, kind: 'text', title: 'T1' },
    { start_ms: 4785, kind: 'text', title: 'T2' },
    { start_ms: 28012, kind: 'text', title: 'T3' },
    { start_ms: 54977, kind: 'text', title: 'T4' },
  ],
};

// What the director answered for the sample: a calm video, the hook first, two claims and the recap last; every other
// sentence stays plain.
export const TRUST_DIRECTOR_ANSWER = {
  style: 'calm' as const,
  labels: [
    { id: 's1', label: 'hook' },
    { id: 's2', label: 'claim' },
    { id: 's5', label: 'claim' },
    { id: 's9', label: 'recap' },
  ],
};

// What Clef-omni picked: the face steps aside and the screen spotlights the first drawing, a dip to black at the second topic
// change, the face grows on the first claim. Every other moment has no pick.
export const TRUST_PICKS: Record<string, string> = {
  'd1:face': 'f_step_aside',
  'd1:screen': 'v_spotlight',
  c2: 'tr_dip_color',
  s2: 'f_hero',
};
