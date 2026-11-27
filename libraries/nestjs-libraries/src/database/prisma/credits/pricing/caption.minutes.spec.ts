// AI captions: the minutes a caption job is charged for are the whole minutes of speech audio,
// rounded down and capped at 60. Needs no database.
import {
  captionMinutes,
  MAX_CAPTION_SECONDS,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/caption.minutes';

describe('credits.ai-charging: captionMinutes', () => {
  it.each([
    [0, 0],
    [0.4, 0],
    [59.9, 0],
    [60, 1],
    [119.9, 1],
    [120, 2],
    [150, 2],
    [3599.9, 59],
    [3600, 60],
    [2 * 60 * 60, 60],
  ])('turns %p seconds into %p minutes', (seconds, minutes) => {
    expect(captionMinutes(seconds)).toBe(minutes);
  });

  it('never rounds up: a second short of the next minute is still the lower one', () => {
    for (let minute = 1; minute <= 60; minute++) {
      expect(captionMinutes(minute * 60 - 1)).toBe(minute - 1);
      expect(captionMinutes(minute * 60)).toBe(minute);
    }
  });

  it('stops at the cap of 60 minutes however long the audio is', () => {
    expect(MAX_CAPTION_SECONDS).toBe(3600);
    expect(captionMinutes(MAX_CAPTION_SECONDS + 59)).toBe(60);
    expect(captionMinutes(24 * 60 * 60)).toBe(60);
    expect(captionMinutes(Infinity)).toBe(60);
  });

  it('charges nothing for a length that is not a positive number', () => {
    expect(captionMinutes(-30)).toBe(0);
    expect(captionMinutes(NaN)).toBe(0);
    expect(captionMinutes(-Infinity)).toBe(0);
  });
});
