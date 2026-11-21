import { Module } from '@nestjs/common';
import { PostActivity } from '@gitroom/orchestrator/activities/post.activity';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { AutopostService } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.service';
import { EmailActivity } from '@gitroom/orchestrator/activities/email.activity';
import { IntegrationsActivity } from '@gitroom/orchestrator/activities/integrations.activity';
import { VideoActivity } from '@gitroom/orchestrator/activities/video.activity';
import { MediaActivity } from '@gitroom/orchestrator/activities/media.activity';
import { ClippingActivity } from '@gitroom/orchestrator/activities/clipping.activity';
import { AiCaptionsActivity } from '@gitroom/orchestrator/activities/ai.captions.activity';
import { AiVideoEditActivity } from '@gitroom/orchestrator/activities/ai.video.edit.activity';
import { AiEditAssetActivity } from '@gitroom/orchestrator/activities/ai.edit.asset.activity';
import { AiEditTraceActivity } from '@gitroom/orchestrator/activities/ai.edit.trace.activity';
import { VideoModule } from '@gitroom/nestjs-libraries/videos/video.module';
import { HealthController } from '@gitroom/orchestrator/health.controller';
import { PublishChargingActivity } from '@gitroom/orchestrator/activities/publish.charging.activity';
import { RecurringChargingActivity } from '@gitroom/orchestrator/activities/recurring.charging.activity';
import { FreeGrantActivity } from '@gitroom/orchestrator/activities/free.grant.activity';
import { CreditsReconcileActivity } from '@gitroom/orchestrator/activities/credits.reconcile.activity';
import { PaypalPollActivity } from '@gitroom/orchestrator/activities/paypal.poll.activity';
import { IdempotencyActivity } from '@gitroom/orchestrator/activities/idempotency.activity';
import { MobileUploadActivity } from '@gitroom/orchestrator/activities/mobile.upload.activity';
import { MediaRetentionActivity } from '@gitroom/orchestrator/activities/media.retention.activity';
import { MediaSweepActivity } from '@gitroom/orchestrator/activities/media.sweep.activity';
import { ActivityLogActivity } from '@gitroom/orchestrator/activities/activity.log.activity';
import { ContentPlanActivity } from '@gitroom/orchestrator/activities/content.plan.activity';
import { TrackerCleanupActivity } from '@gitroom/orchestrator/activities/tracker.cleanup.activity';

const activities = [
  PostActivity,
  AutopostService,
  EmailActivity,
  IntegrationsActivity,
  VideoActivity,
  MediaActivity,
  ClippingActivity,
  AiCaptionsActivity,
  AiVideoEditActivity,
  AiEditAssetActivity,
  AiEditTraceActivity,
  PublishChargingActivity,
  RecurringChargingActivity,
  FreeGrantActivity,
  CreditsReconcileActivity,
  PaypalPollActivity,
  IdempotencyActivity,
  MobileUploadActivity,
  MediaRetentionActivity,
  MediaSweepActivity,
  ActivityLogActivity,
  ContentPlanActivity,
  TrackerCleanupActivity,
];
@Module({
  imports: [
    DatabaseModule,
    VideoModule,
    getTemporalModule(true, require.resolve('./workflows'), activities),
  ],
  controllers: [HealthController],
  providers: [...activities],
  get exports() {
    return [...this.providers, ...this.imports];
  },
})
export class AppModule {}
