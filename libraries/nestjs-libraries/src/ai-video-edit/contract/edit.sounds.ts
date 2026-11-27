// AI video editing (ai.video-editing): the fixed list of short sound effects. The files are served by the server
// from AI_EDIT_SOUNDS_BASE_URL (`<base>/<id>.wav`) and named in the plan's asset list; only CC0 sources.
import { SoundId } from './edit.contract';

// Every sound id the plan may use, in the order the contract lists them.
export const SOUND_IDS: SoundId[] = [
  'pop_1',
  'pop_2',
  'whoosh_short',
  'swoosh',
  'ding',
  'impact_soft',
  'click',
];

// Whether an id names one of the sounds above.
export const isSoundId = (id: string): id is SoundId =>
  (SOUND_IDS as string[]).includes(id);
