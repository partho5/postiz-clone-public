// The single list of content plan prompts the generator reads: the model, and per kind of call the frame body and the
// reasoning effort. Prompt text lives only in this folder; a change ships with a deploy.
import { SETUP_FRAME } from './setup.prompts';
import { PROPOSAL_FRAME } from './proposal.prompts';
import { INSTANT_FRAME } from './instant.prompts';
import {
  ANGLE_HINTS,
  DAY_FRAME,
  OUTLINE_FRAME,
  ROADMAP_FRAME,
  WEEK_FRAME,
} from './weekly.prompts';

export * from './shared.prompts';
export * from './setup.prompts';
export * from './proposal.prompts';
export * from './weekly.prompts';
export * from './instant.prompts';

export const PLANNER_MODEL = 'muse-spark-1.3-contributor';

// Code names of the kinds of call; they are also the `prompt_cache_key` suffix and the key of the usage log line.
export type PlannerPromptKey =
  | 'planner.frame.setup'
  | 'planner.frame.proposal'
  | 'planner.frame.roadmap'
  | 'planner.frame.outline'
  | 'planner.frame.week'
  | 'planner.frame.day'
  | 'planner.frame.instant';

// A frame that tells the model how to approach a video carries the angle hints after its text.
const withAngles = (frame: string) => `${frame}\n\n${ANGLE_HINTS}`;

export const PLANNER_PROMPTS: Record<
  PlannerPromptKey,
  { body: string; effort: 'minimal' | 'low' | 'medium' | 'high' }
> = {
  'planner.frame.setup': { body: SETUP_FRAME, effort: 'low' },
  'planner.frame.proposal': { body: PROPOSAL_FRAME, effort: 'medium' },
  'planner.frame.roadmap': { body: ROADMAP_FRAME, effort: 'medium' },
  'planner.frame.outline': { body: withAngles(OUTLINE_FRAME), effort: 'medium' },
  'planner.frame.week': { body: withAngles(WEEK_FRAME), effort: 'medium' },
  'planner.frame.day': { body: withAngles(DAY_FRAME), effort: 'medium' },
  'planner.frame.instant': { body: INSTANT_FRAME, effort: 'medium' },
};
