// AI video editing (ai.video-editing), planner core: the transcript as the planner sees it. Pure functions: no Nest,
// Prisma or network import may enter this folder (the same rule as ../contract/).
import { EditWord } from '../contract/edit.contract';

// One timed item of a transcript, structurally the same as `TranscriptWord` of muse/transcription.provider.ts (that
// file pulls in Nest, so the core declares the shape it needs instead of importing it).
export interface RawWord {
  text: string;
  startMs: number;
  endMs: number;
  type: string;
}

// Keeps the spoken words only (no spacing, no audio events), in time order, numbered from 0, in whole milliseconds.
export const toEditWords = (
  words: RawWord[] | null | undefined
): EditWord[] =>
  (words || [])
    .filter((w) => w.type === 'word' && w.text.trim().length > 0)
    .map((w) => {
      const start = Math.round(w.startMs);
      return {
        w: w.text.trim(),
        start_ms: start,
        end_ms: Math.max(start, Math.round(w.endMs)),
      };
    })
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
    .map((w, i) => ({ i, ...w }));
