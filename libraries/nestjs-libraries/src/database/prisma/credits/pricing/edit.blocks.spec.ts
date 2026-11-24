// AI video editing: an AI edit is charged per started 3 minutes of the recording, at least one block.
// Needs no database.
import {
  EDIT_BLOCK_SECONDS,
  editBlocks,
} from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/edit.blocks';

describe('credits.ai-charging: editBlocks', () => {
  it.each([
    [0.5, 1],
    [1, 1],
    [179.9, 1],
    [180, 1],
    [180.1, 2],
    [360, 2],
    [361, 3],
    [600, 4],
  ])('turns %p seconds into %p blocks', (seconds, blocks) => {
    expect(editBlocks(seconds)).toBe(blocks);
  });

  it('rounds up: a second into the next block starts it', () => {
    expect(EDIT_BLOCK_SECONDS).toBe(180);
    for (let block = 1; block <= 20; block++) {
      expect(editBlocks(block * 180)).toBe(block);
      expect(editBlocks(block * 180 + 1)).toBe(block + 1);
    }
  });

  it('is never less than one block', () => {
    expect(editBlocks(0)).toBe(1);
    expect(editBlocks(-30)).toBe(1);
    expect(editBlocks(NaN)).toBe(1);
    expect(editBlocks(-Infinity)).toBe(1);
  });
});
