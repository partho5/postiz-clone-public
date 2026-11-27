// Content plan: the prompt list the generator reads. Pure, needs no database.
import {
  ANGLE_HINTS,
  PLANNER_MODEL,
  PLANNER_PROMPTS,
  PLANNER_RULES,
  PlannerPromptKey,
} from './index';

const KEYS: PlannerPromptKey[] = [
  'planner.frame.setup',
  'planner.frame.proposal',
  'planner.frame.roadmap',
  'planner.frame.outline',
  'planner.frame.week',
  'planner.frame.day',
  'planner.frame.instant',
  'planner.frame.video_set_round',
  'planner.frame.video_set',
];

describe('content plan prompts', () => {
  it('has a non-empty body and a valid effort for every prompt key', () => {
    expect(Object.keys(PLANNER_PROMPTS).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) {
      expect(PLANNER_PROMPTS[key].body.trim().length).toBeGreaterThan(0);
      expect(['minimal', 'low', 'medium', 'high']).toContain(
        PLANNER_PROMPTS[key].effort
      );
    }
  });

  it('runs the question rounds (setup and video set) on low effort and every other prompt on medium', () => {
    const rounds = ['planner.frame.setup', 'planner.frame.video_set_round'];
    for (const key of rounds) {
      expect(PLANNER_PROMPTS[key as PlannerPromptKey].effort).toBe('low');
    }
    for (const key of KEYS.filter((k) => !rounds.includes(k))) {
      expect(PLANNER_PROMPTS[key].effort).toBe('medium');
    }
  });

  it('adds the angle hints to the outline, week and day frames only', () => {
    for (const key of KEYS) {
      expect(PLANNER_PROMPTS[key].body.includes(ANGLE_HINTS)).toBe(
        ['planner.frame.outline', 'planner.frame.week', 'planner.frame.day'].includes(key)
      );
    }
  });

  it('uses the contributor model and has the trust rules', () => {
    expect(PLANNER_MODEL).toBe('muse-spark-1.3-contributor');
    expect(PLANNER_RULES).toContain('Trust rules:');
  });
});
