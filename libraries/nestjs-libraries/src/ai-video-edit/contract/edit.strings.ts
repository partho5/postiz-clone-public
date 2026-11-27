// AI video editing (ai.video-editing), text styles gate 6: the string matrix every text spec runs. One list of texts in
// the scripts and shapes a text overlay may have (a single grapheme, the longest allowed text, left-to-right and
// right-to-left scripts, scripts without spaces, joined and combined letters, emoji), so that no spec of the text path
// is written for Latin only. Plain data, no Nest or Prisma import.

// One string of the matrix: what the writer or the transcript may give, the language it is in and what to expect of it.
export interface MatrixString {
  id: string;
  text: string;
  // The language tag of the video the text is in.
  language: string;
  // Whether the script reads right to left.
  rtl?: boolean;
  // A text the planner keeps as it is written (within the word and grapheme caps and the 2 line estimate).
  uncapped?: boolean;
  // A text over the caps: the planner must cut it and keep a whole-word or whole-grapheme part of it.
  over_cap?: boolean;
}

export const STRING_MATRIX: MatrixString[] = [
  { id: 'one_grapheme', text: 'A', language: 'en', uncapped: true },
  { id: 'one_word', text: 'Amazing', language: 'en', uncapped: true },
  // 4 words and 28 graphemes of the widest Latin capital: the longest text of the normal width class.
  { id: 'longest_allowed', text: 'WWWWWWW WWWWWWW WWWWWWW WWWW', language: 'en', uncapped: true },
  { id: 'all_caps_latin', text: 'SAVE TIME NOW', language: 'en', uncapped: true },
  // `শ্রেষ্ঠ`: consonants joined by virama into conjuncts, one grapheme cluster each on a current Unicode.
  { id: 'bengali_conjunct', text: 'শ্রেষ্ঠ', language: 'bn', uncapped: true },
  { id: 'devanagari', text: 'नमस्ते दुनिया', language: 'hi', uncapped: true },
  { id: 'arabic', text: 'مرحبا بالعالم', language: 'ar', rtl: true, uncapped: true },
  { id: 'hebrew', text: 'שלום עולם', language: 'he', rtl: true, uncapped: true },
  { id: 'chinese', text: '节省时间', language: 'zh', uncapped: true },
  { id: 'japanese', text: 'ありがとう', language: 'ja', uncapped: true },
  { id: 'thai', text: 'สวัสดีครับ', language: 'th', uncapped: true },
  { id: 'cyrillic', text: 'Привет мир', language: 'ru', uncapped: true },
  // A dotted and a dotless i: the Turkish upper case of `iğdır ışık` is `İĞDIR IŞIK`.
  { id: 'turkish_i', text: 'iğdır ışık', language: 'tr', uncapped: true },
  { id: 'mixed_ltr_rtl', text: 'Save שלום 50% مرحبا', language: 'en', uncapped: true },
  { id: 'descenders', text: 'gypsy jumping quickly', language: 'en', uncapped: true },
  { id: 'emoji_inside', text: 'Great 🔥 job', language: 'en', uncapped: true },
  // Over the caps: 58 Latin graphemes, a 42 grapheme Chinese sentence and a long Thai sentence, none with spaces to
  // count words on (the last two), each of which must be cut by the Unicode word and grapheme rules.
  {
    id: 'over_cap_latin',
    text: 'Extraordinarily unbelievable organizational transformation',
    language: 'en',
    over_cap: true,
  },
  {
    id: 'over_cap_chinese',
    text: '今天我们一起来学习如何在每天的生活中节省更多的时间并且提高工作效率让生活变得更加美好',
    language: 'zh',
    over_cap: true,
  },
  {
    id: 'over_cap_thai',
    text: 'ฉันรักประเทศไทยมากที่สุดในโลกนี้และจะอยู่ที่นี่ตลอดไปไม่ว่าจะเกิดอะไรขึ้นก็ตาม',
    language: 'th',
    over_cap: true,
  },
];
