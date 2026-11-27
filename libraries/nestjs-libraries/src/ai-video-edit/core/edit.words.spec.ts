// AI video editing (ai.video-editing): the transcript as the planner sees it. Needs no database and no Nest.
import * as fs from 'fs';
import * as path from 'path';
import { RAW_TRANSCRIPT } from './fixtures/edit.fixtures';
import { toEditWords } from './edit.words';

describe('ai.video-editing: toEditWords', () => {
  it('keeps spoken words only, numbered from 0', () => {
    const words = toEditWords(RAW_TRANSCRIPT);
    expect(words.map((w) => w.w)).toEqual([
      'So', 'today', 'we', 'start', 'here', 'and', 'then', 'stop', 'now', 'thanks', 'bye',
    ]);
    expect(words.map((w) => w.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(words[0]).toEqual({ i: 0, w: 'So', start_ms: 600, end_ms: 900 });
  });

  it('rounds to whole milliseconds and never ends a word before it starts', () => {
    const words = toEditWords([
      { text: 'odd', startMs: 1000.6, endMs: 1400.4, type: 'word' },
      { text: 'flip', startMs: 2000, endMs: 1900, type: 'word' },
    ]);
    expect(words[0]).toMatchObject({ start_ms: 1001, end_ms: 1400 });
    expect(words[1]).toMatchObject({ start_ms: 2000, end_ms: 2000 });
  });

  it('sorts by start time before numbering and drops empty text', () => {
    const words = toEditWords([
      { text: 'second', startMs: 500, endMs: 800, type: 'word' },
      { text: '  ', startMs: 100, endMs: 200, type: 'word' },
      { text: 'first', startMs: 100, endMs: 400, type: 'word' },
    ]);
    expect(words.map((w) => `${w.i}:${w.w}`)).toEqual(['0:first', '1:second']);
  });

  it('answers an empty list for no transcript', () => {
    expect(toEditWords([])).toEqual([]);
    expect(toEditWords(undefined)).toEqual([]);
    expect(toEditWords(null)).toEqual([]);
  });
});

describe('ai.video-editing: the core folder is pure', () => {
  it('imports nothing but its own files, the contract and the node util module', () => {
    const dirs = [__dirname, path.join(__dirname, 'fixtures')];
    const files = dirs.flatMap((d) =>
      fs.readdirSync(d).filter((f) => f.endsWith('.ts')).map((f) => path.join(d, f))
    );
    expect(files.length).toBeGreaterThan(5);
    files.forEach((file) => {
      const text = fs.readFileSync(file, 'utf8');
      // Specs import jest helpers and node modules; the sources must not (`util` is pure: edit.replay.ts compares with it)
      if (file.endsWith('.spec.ts')) return;
      const imports = text.match(/from\s+'[^']+'/g) || [];
      imports.forEach((line) => expect(line).toMatch(/^from\s+'(\.\.?\/|util')/));
    });
  });
});
