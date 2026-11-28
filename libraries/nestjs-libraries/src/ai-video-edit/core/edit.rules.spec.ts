// AI video editing (ai.video-editing): the per-minute budgets of the rule helpers (task TS12). Pure functions, needs no
// database and no Nest.
import { effectById } from '../contract/edit.registry';
import { budgetFor, capFor, cooldownConflict, durationBounds } from './edit.rules';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe('ai.video-editing: budgetFor, the feature and icon budget per minute', () => {
  it('gives a video of up to one minute exactly the floor of its level', () => {
    expect(budgetFor('heavy', 0)).toEqual({ features: 10, icons: 4 });
    expect(budgetFor('heavy', 45 * SECOND)).toEqual({ features: 10, icons: 4 });
    expect(budgetFor('heavy', MINUTE)).toEqual({ features: 10, icons: 4 });
    expect(budgetFor('standard', 45 * SECOND)).toEqual({ features: 6, icons: 2 });
    expect(budgetFor('basic', 45 * SECOND)).toEqual({ features: 3, icons: 0 });
  });

  it('grows with the minutes of a longer video', () => {
    expect(budgetFor('heavy', 3 * MINUTE)).toEqual({ features: 30, icons: 12 });
    expect(budgetFor('standard', 3 * MINUTE)).toEqual({ features: 18, icons: 6 });
    expect(budgetFor('basic', 3 * MINUTE).features).toBe(9);
  });

  it('gives Basic no icon at any length', () => {
    for (const ms of [0, 30 * SECOND, MINUTE, 3 * MINUTE, 10 * MINUTE]) {
      expect(budgetFor('basic', ms).icons).toBe(0);
    }
  });

  it('treats a negative duration as an empty video', () => {
    expect(budgetFor('heavy', -5 * SECOND)).toEqual({ features: 10, icons: 4 });
  });

  it('gives a calm video the calm icon rate: Standard 1 and Heavy 2 per minute, never below that, features unchanged (TS9c)', () => {
    expect(budgetFor('standard', MINUTE, 'calm')).toEqual({ features: 6, icons: 1 });
    expect(budgetFor('standard', 20 * SECOND, 'calm').icons).toBe(1);
    expect(budgetFor('heavy', MINUTE, 'calm')).toEqual({ features: 10, icons: 2 });
    expect(budgetFor('heavy', 20 * SECOND, 'calm').icons).toBe(2);
    expect(budgetFor('heavy', 3 * MINUTE, 'calm')).toEqual({ features: 30, icons: 6 });
    expect(budgetFor('standard', 3 * MINUTE, 'calm').icons).toBe(3);
    expect(budgetFor('basic', 3 * MINUTE, 'calm').icons).toBe(0);
  });

  it('leaves a lively video, or one with no style, on the level rate (TS9c)', () => {
    expect(budgetFor('heavy', 3 * MINUTE, 'lively')).toEqual(budgetFor('heavy', 3 * MINUTE));
    expect(budgetFor('heavy', 3 * MINUTE, undefined).icons).toBe(12);
  });
});

describe('ai.video-editing: capFor, the count of one effect per minute', () => {
  const entry = effectById('x_sticker');

  it('has a text effect that is allowed 4 times a minute', () => {
    expect(entry.max_per_video).toBe(4);
  });

  it('is the entry value up to one minute, then grows per minute, rounded up', () => {
    expect(capFor(entry, 30 * SECOND)).toBe(4);
    expect(capFor(entry, MINUTE)).toBe(4);
    expect(capFor(entry, 61 * SECOND)).toBe(5);
    expect(capFor(entry, 3 * MINUTE)).toBe(12);
  });
});

describe('ai.video-editing: cooldownConflict with the duration', () => {
  const entry = effectById('x_sticker');
  const starts = [1000, 8000, 15000, 22000];

  it('refuses a fifth use in a one-minute video and allows it in a two-minute one', () => {
    expect(cooldownConflict(entry, starts, 40 * SECOND, MINUTE)).toBe('max_per_video');
    expect(cooldownConflict(entry, starts, 40 * SECOND, 2 * MINUTE)).toBeNull();
  });

  it('still refuses a use inside the cooldown of the same effect', () => {
    expect(cooldownConflict(entry, [1000], 1000 + entry.cooldown_ms - 1, 2 * MINUTE)).toBe('cooldown');
    expect(cooldownConflict(entry, [1000], 1000 + entry.cooldown_ms, 2 * MINUTE)).toBeNull();
  });
});

describe('ai.video-editing: durationBounds of an icon (task TS11)', () => {
  it('holds an icon or a clip from 500 to 2500 ms', () => {
    const clip = { type: 'icon_video' as const, asset_id: 'a', native_duration_ms: 3240 };
    expect(durationBounds(effectById('i_scale_pop'), clip)).toEqual([500, 2500]);
    expect(durationBounds(effectById('i_wipe_reveal'), { type: 'icon_image' as const, asset_id: 'b' })).toEqual([500, 2500]);
  });
});
