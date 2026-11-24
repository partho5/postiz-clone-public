// AI captions: the one rule that turns the length of a recording's speech into the minutes
// charged. The charge, the quote and every preview call it, so they can never disagree.

// The longest speech audio a caption job is charged for: 60 minutes, in seconds.
export const MAX_CAPTION_SECONDS = 3600;

// Whole minutes of speech audio charged: rounded down, never up (owner call 2026-10-21), at most 60.
// Under a minute is 0, which costs nothing; anything that is not a positive number is 0 too.
export const captionMinutes = (seconds: number) =>
  seconds > 0 ? Math.floor(Math.min(seconds, MAX_CAPTION_SECONDS) / 60) : 0;
