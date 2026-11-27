// AI video editing: the one rule that turns the length of a recording into the blocks an AI edit is
// charged for. The charge, the quote and every preview call it, so they can never disagree.

// How long one charged block of an AI edit is: 3 minutes, in seconds.
export const EDIT_BLOCK_SECONDS = 180;

// Started 3-minute blocks of the recording, at least 1: any part of a block counts as the whole block, and a
// length that is not a positive finite number is still the one block every edit costs.
export const editBlocks = (seconds: number) =>
  Number.isFinite(seconds) && seconds > 0
    ? Math.max(1, Math.ceil(seconds / EDIT_BLOCK_SECONDS))
    : 1;
