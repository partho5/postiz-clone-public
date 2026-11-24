// Mobile auto-publish (api.mobile-auto-publish): the body that chooses a workspace's preset.
import { IsDefined, IsIn, IsOptional, IsString } from 'class-validator';

export const AUTO_PUBLISH_TIMINGS = ['now', 'next_slot'] as const;
export type AutoPublishTiming = (typeof AUTO_PUBLISH_TIMINGS)[number];

// The Set to publish every finished recording with, and when ('now' when left out).
export class AutoPublishPresetDto {
  @IsString()
  @IsDefined()
  setId: string;

  @IsOptional()
  @IsIn(AUTO_PUBLISH_TIMINGS)
  timing?: AutoPublishTiming;
}
