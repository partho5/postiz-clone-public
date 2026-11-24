// ai.video-editing (T4.2): the writer's side of the planner core: which slots are asked about, and the reading of the
// answer (cleaning, the word limit, banned words, icon queries). No network, no Nest.
import { Slot } from './edit.slots';
import { readTexts, writerSlots } from './edit.texts';
import { writerMessages } from '../edit.writer.prompt';

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
      const asked = writerSlots(SLOTS, 'heavy', { family: { s3: 'none' } });
      expect(asked.map((s) => s.id)).toEqual(['h1', 's2', 's1']);
    });

    it('lets stressed words weigh double', () => {
      const asked = writerSlots(SLOTS, 'heavy', { emphasis: { 5: 1 } });
      expect(asked.map((s) => s.id)).toEqual(['h1', 's1', 's2', 's3']);
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
    it('carries the voice, the banned words, the transcript and a line per slot', () => {
      const words = Array.from({ length: 12 }, (_, i) => ({
        i,
        w: `w${i}`,
        start_ms: i * 400,
        end_ms: i * 400 + 300,
      }));
      const [message] = writerMessages({
        words,
        slots: [slot('h1', 0, 0, ['hook']), slot('s1', 5, 1)],
        language: 'eng',
        voice: 'Calm',
        bannedWords: ['cheap'],
      });
      expect(message.role).toBe('user');
      expect(message.content).toContain('Calm');
      expect(message.content).toContain('- cheap');
      expect(message.content).toContain('h1 (hook): [w0] w1');
      expect(message.content).toContain('s1: w0 w1 w2 w3 w4 [w5]');
    });
  });
});
