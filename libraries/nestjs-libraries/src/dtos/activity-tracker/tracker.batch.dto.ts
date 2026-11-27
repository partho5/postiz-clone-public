// Activity tracker (api.activity-tracker): the body of POST /tracker/batches.
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { TRACKER_MAX_ACTIVITIES } from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.config';

// The envelope of an upload. The activities are checked one by one by the clean file, so one bad activity
// costs that activity and not the batch; `app` and `device` are read field by field there too.
export class TrackerBatchDto {
  @IsUUID()
  batchId: string;

  @IsUUID()
  deviceId: string;

  @IsOptional()
  @IsNumber()
  sentAt?: number;

  @IsOptional()
  @IsObject()
  app?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  device?: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TRACKER_MAX_ACTIVITIES)
  activities: unknown[];
}
