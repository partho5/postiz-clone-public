// ai.video-editing (T4.2): the writer's side of the planner core: which slots are asked about, and the reading of the
// answer (cleaning, the word limit, banned words, icon queries). No network, no Nest.
import { Slot } from './edit.slots';
import { readTexts, writerSlots } from './edit.texts';
import { EDIT_WRITER_PROMPT, writerMessages } from '../edit.writer.prompt';

const slot = (id: string, word_index: number, score: number, reasons: Slot['reasons'] = ['number']): Slot => ({
  id,
  word_index,
  start_ms: word_index * 400,
  end_ms: word_index * 400 + 300,
  window: 0,
  reasons,
  score,
  keyword: `kw${word_index}`,
});

const SLOTS = [slot('h1', 0, 0, ['hook']), slot('s1', 5, 1), slot('s2', 10, 3), slot('s3', 15, 2)];

describe('ai.video-editing: the writer texts', () => {
  describe('writerSlots', () => {
    it('asks the hook first, then the best scored, and leaves out what perception wants plain', () => {
      const asked = writerSlots(SLOTS, 'heavy', 45_000, { family: { s3: 'none' } });
      expect(asked.map((s) => s.id)).toEqual(['h1', 's2', 's1']);
    });

    it('lets stressed words weigh double', () => {
      const asked = writerSlots(SLOTS, 'heavy', 45_000, { emphasis: { 5: 1 } });
      expect(asked.map((s) => s.id)).toEqual(['h1', 's1', 's2', 's3']);
    });
  });

  describe('writerSlots, the count scales with the duration', () => {
    const many = [slot('h1', 0, 0, ['hook']), ...Array.from({ length: 80 }, (_, k) => slot(`s${k + 1}`, 5 + k, 1 + (k % 3)))];

    it('asks twice the feature budget of the video: 20 slots and the hook up to a minute, more in a longer video', () => {
      expect(writerSlots(many, 'heavy', 45_000)).toHaveLength(1 + 20);
      expect(writerSlots(many, 'heavy', 60_000)).toHaveLength(1 + 20);
      expect(writerSlots(many, 'heavy', 180_000)).toHaveLength(1 + 60);
    });
  });

  describe('readTexts', () => {
    const asked = SLOTS;

    it('reads the hook, the phrases and the icon queries of the asked slots', () => {
      const texts = readTexts(
        {
          slots: [
            { id: 'h1', text: '"Stop wasting hours."', icon_query: 'Alarm Clock' },
            { id: 's2', text: 'Save two hours a day every week', icon_query: null },
            { id: 'zz', text: 'Not asked', icon_query: 'rocket' },
          ],
        },
        asked
      );
      expect(texts).toEqual({
        hook: 'Stop wasting hours',
        complementary: { s2: 'Save two hours a' },
        icon_queries: { h1: 'alarm clock' },
      });
    });

    it('drops a text with a banned word of the brand, whatever its case, and keeps the others', () => {
      const texts = readTexts(
        {
          slots: [
            { id: 'h1', text: 'Cheap tricks', icon_query: null },
            { id: 's1', text: 'Smart tricks', icon_query: null },
          ],
        },
        asked,
        ['cheap']
      );
      expect(texts).toEqual({ complementary: { s1: 'Smart tricks' } });
    });

    it('keeps an icon query of up to 6 English words and drops one that is longer or not English', () => {
      const texts = readTexts(
        {
          slots: [
            { id: 's1', text: 'Fast', icon_query: 'Doctor looking at the watch!' },
            { id: 's2', text: 'Faster', icon_query: 'one two three four five six seven' },
            { id: 'h1', text: 'Fastest', icon_query: 'টাকা' },
          ],
        },
        asked
      );
      expect(texts).toEqual({
        hook: 'Fastest',
        complementary: { s1: 'Fast', s2: 'Faster' },
        icon_queries: { s1: 'doctor looking at the watch' },
      });
    });

    it('is undefined for a missing, empty or unusable answer', () => {
      expect(readTexts(null, asked)).toBeUndefined();
      expect(readTexts({ slots: [] }, asked)).toBeUndefined();
      expect(readTexts({ slots: [{ id: 's1', text: '  ', icon_query: null }] }, asked)).toBeUndefined();
    });
  });

  describe('writerMessages', () => {
    const words = Array.from({ length: 12 }, (_, i) => ({
      i,
      w: `w${i}`,
      start_ms: i * 400,
      end_ms: i * 400 + 300,
    }));

    it('gives the rules as the system message and only the video data as the user message', () => {
      const [system, user, ...more] = writerMessages({
        words,
        slots: [slot('h1', 0, 0, ['hook']), slot('s1', 5, 1)],
        level: 'heavy',
        durationMs: 45_000,
        language: 'eng',
      });
      expect(more).toEqual([]);
      expect(system).toEqual({ role: 'system', content: EDIT_WRITER_PROMPT });
      expect(user.role).toBe('user');
      expect(user.content).not.toContain(EDIT_WRITER_PROMPT);
      expect(user.content).not.toContain('You are the text editor');
      expect(user.content).toContain('Language of the transcript: eng.');
    });

    it('asks for icon queries right after the language: twice the icon budget of the video, at most the slots', () => {
      const ten = Array.from({ length: 10 }, (_, k) => slot(k === 0 ? 'h1' : `s${k}`, k, 1));
      const [, minute] = writerMessages({ words, slots: ten, level: 'heavy', durationMs: 60_000, language: 'eng' });
      expect(minute.content).toContain('Language of the transcript: eng.\nIcon queries wanted: at least 8 of the slots.');
      const twenty = Array.from({ length: 20 }, (_, k) => slot(k === 0 ? 'h1' : `s${k}`, k, 1));
      const [, long] = writerMessages({ words, slots: twenty, level: 'heavy', durationMs: 4 * 60_000, language: 'eng' });
      // Heavy has 16 icons in 4 minutes, so 32 queries are wanted, but only 20 slots are asked
      expect(long.content).toContain('Icon queries wanted: at least 20 of the slots.');
      const [, few] = writerMessages({ words, slots: ten.slice(0, 3), level: 'heavy', durationMs: 60_000 });
      expect(few.content).toContain('at least 3 of the slots.');
    });

    it('asks a calm video for the calm icon budget and names the slots an icon may go on (TS9c)', () => {
      const ten = Array.from({ length: 10 }, (_, k) => slot(k === 0 ? 'h1' : `s${k}`, k, 1));
      // sentence k holds word k; the hook and the recap sentences take no icon
      const labelOf = (k: number) => (k === 0 ? 'hook' : k === 3 ? 'recap' : 'claim');
      const direction = (style: 'calm' | 'lively'): any => ({
        style,
        source: 'director',
        moments: ten.map((_, k) => ({
          id: `s${k + 1}`,
          kind: 'sentence',
          start_ms: k * 400,
          end_ms: k * 400 + 300,
          word_from: k,
          word_to: k,
          label: labelOf(k),
        })),
      });
      const base = { words, slots: ten, level: 'heavy' as const, durationMs: 60_000, language: 'eng' };
      // calm Heavy: 2 icons, so 4 queries, on the 8 slots that may take one
      const [, calm] = writerMessages({ ...base, direction: direction('calm') });
      expect(calm.content).toContain('Icon queries wanted: at least 4 of the slots.');
      expect(calm.content).toContain('Slots that may get an icon query: s1, s2, s4, s5, s6, s7, s8, s9.');
      // lively and no direction: as before, and no list
      for (const d of [direction('lively'), undefined]) {
        const [, user] = writerMessages({ ...base, direction: d });
        expect(user.content).toContain('Icon queries wanted: at least 8 of the slots.');
        expect(user.content).not.toContain('Slots that may get an icon query');
      }
    });

    it('carries the voice, the banned words, the transcript and a line per slot', () => {
      const [, user] = writerMessages({
        words,
        slots: [slot('h1', 0, 0, ['hook']), slot('s1', 5, 1)],
        level: 'heavy',
        durationMs: 45_000,
        language: 'eng',
        voice: 'Calm',
        bannedWords: ['cheap'],
      });
      expect(user.content).toContain('Calm');
      expect(user.content).toContain('- cheap');
      expect(user.content).toContain('Transcript:\nw0 w1 w2');
      expect(user.content).toContain('h1: [w0] w1');
      expect(user.content).toContain('s1: w0 w1 w2 w3 w4 [w5]');
    });

    it('cuts a long transcript at a word', () => {
      const long = Array.from({ length: 3000 }, (_, i) => ({ i, w: `word${i}`, start_ms: i, end_ms: i + 1 }));
      const [, user] = writerMessages({ words: long, slots: [slot('h1', 0, 0, ['hook'])], level: 'heavy', durationMs: 45_000 });
      const transcript = user.content.split('Transcript:\n')[1].split('\n\nSlots:')[0];
      expect(transcript.length).toBeLessThanOrEqual(6000);
      expect(transcript).toMatch(/word\d+$/);
      expect(transcript).not.toContain('word2999');
    });

    it('leaves out the voice and the banned words when there are none', () => {
      const [, user] = writerMessages({ words, slots: [slot('h1', 0, 0, ['hook'])], level: 'heavy', durationMs: 45_000, voice: '  ', bannedWords: [] });
      expect(user.content).not.toContain("The brand's voice");
      expect(user.content).not.toContain('Banned words');
    });
  });
});
