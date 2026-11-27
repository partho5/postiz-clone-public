// Mobile activity log (api.activity-log): the body of POST /activity/batches.
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsObject,
  IsOptional,
  IsUUID,
} from 'class-validator';

// Most events one upload may carry.
export const ACTIVITY_MAX_EVENTS = 100;

// The envelope of an upload. The events are checked one by one by the service, so one bad event costs
// that event and not the batch; `app` and `device` are read field by field there too.
export class ActivityBatchDto {
  @IsUUID()
  batchId: string;

  @IsUUID()
  deviceId: string;

  @IsOptional()
  @IsObject()
  app?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  device?: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ACTIVITY_MAX_EVENTS)
  events: unknown[];
}
