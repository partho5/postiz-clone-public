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

// A test look table (card S9): the shipped looks, but `sticker` draws a left to right gradient on the text, so it needs the
// feature below. Today's six looks need no feature, so a spec brings this table to the chooser and the validator instead
// of adding a look to `TEXT_LOOKS` (which a snapshot freezes).
export const GATED_LOOK_ID = 'sticker';
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
}

// The request of a fixture: 1.5 s of silence after the last word, all three outputs, every effect available.
export const goldenRequest = (f: GoldenFixture): EditRequest => ({
  contract_version: 2,
  video: {
    duration_ms: f.words[f.words.length - 1].endMs + 1500,
    width: 1080,
    height: 2400,
    fps: 30,
    source: 'in_app_recording',
  },
  outputs: ALL_OUTPUTS,
  facecam_track: f.facecam,
  activity_map: f.activity,
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
