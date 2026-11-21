import { Global, Module } from '@nestjs/common';
import { PrismaRepository, PrismaService, PrismaTransaction } from './prisma.service';
import { OrganizationRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { UsersRepository } from '@gitroom/nestjs-libraries/database/prisma/users/users.repository';
import { SubscriptionService } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { SubscriptionRepository } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.repository';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { MediaRepository } from '@gitroom/nestjs-libraries/database/prisma/media/media.repository';
import { NotificationsRepository } from '@gitroom/nestjs-libraries/database/prisma/notifications/notifications.repository';
import { EmailService } from '@gitroom/nestjs-libraries/services/email.service';
import { PaymentService } from '@gitroom/nestjs-libraries/services/payment/payment.service';
import { PaymentProviderManager } from '@gitroom/nestjs-libraries/services/payment/payment.provider.manager';
import { RevenueCatProvider } from '@gitroom/nestjs-libraries/services/payment/providers/revenuecat.provider';
import { ExtractContentService } from '@gitroom/nestjs-libraries/openai/extract.content.service';
import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
import { DeepgramService } from '@gitroom/nestjs-libraries/deepgram/deepgram.service';
import { MuseTranscriptionService } from '@gitroom/nestjs-libraries/muse/muse.transcription.service';
import { MuseChatService } from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import { ElevenLabsTranscriptionService } from '@gitroom/nestjs-libraries/muse/elevenlabs.transcription.service';
import { ClippingService } from '@gitroom/nestjs-libraries/database/prisma/clipping/clipping.service';
import { ClippingRepository } from '@gitroom/nestjs-libraries/database/prisma/clipping/clipping.repository';
import { AgenciesService } from '@gitroom/nestjs-libraries/database/prisma/agencies/agencies.service';
import { AgenciesRepository } from '@gitroom/nestjs-libraries/database/prisma/agencies/agencies.repository';
import { TrackService } from '@gitroom/nestjs-libraries/track/track.service';
import { ShortLinkService } from '@gitroom/nestjs-libraries/short-linking/short.link.service';
import { WebhooksRepository } from '@gitroom/nestjs-libraries/database/prisma/webhooks/webhooks.repository';
import { WebhooksService } from '@gitroom/nestjs-libraries/database/prisma/webhooks/webhooks.service';
import { SignatureRepository } from '@gitroom/nestjs-libraries/database/prisma/signatures/signature.repository';
import { SignatureService } from '@gitroom/nestjs-libraries/database/prisma/signatures/signature.service';
import { AutopostRepository } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.repository';
import { AutopostService } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.service';
import { SetsService } from '@gitroom/nestjs-libraries/database/prisma/sets/sets.service';
import { SetsRepository } from '@gitroom/nestjs-libraries/database/prisma/sets/sets.repository';
import { ThirdPartyRepository } from '@gitroom/nestjs-libraries/database/prisma/third-party/third-party.repository';
import { ThirdPartyService } from '@gitroom/nestjs-libraries/database/prisma/third-party/third-party.service';
import { AppCredentialsRepository } from '@gitroom/nestjs-libraries/database/prisma/app-credentials/app.credentials.repository';
import { AppCredentialsService } from '@gitroom/nestjs-libraries/database/prisma/app-credentials/app.credentials.service';
import { VideoManager } from '@gitroom/nestjs-libraries/videos/video.manager';
import { FalService } from '@gitroom/nestjs-libraries/openai/fal.service';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { OAuthRepository } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.repository';
import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';
import { AnnouncementsRepository } from '@gitroom/nestjs-libraries/database/prisma/announcements/announcements.repository';
import { AnnouncementsService } from '@gitroom/nestjs-libraries/database/prisma/announcements/announcements.service';
import { ErrorsRepository } from '@gitroom/nestjs-libraries/database/prisma/errors/errors.repository';
import { ErrorsService } from '@gitroom/nestjs-libraries/database/prisma/errors/errors.service';
import { AdminStatsRepository } from '@gitroom/nestjs-libraries/database/prisma/admin-stats/admin-stats.repository';
import { AdminStatsService } from '@gitroom/nestjs-libraries/database/prisma/admin-stats/admin-stats.service';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { EmailOtpRepository } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.repository';
import { CreditsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.repository';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { MoneyScope } from '@gitroom/nestjs-libraries/database/prisma/credits/scope/money.scope';
import { PricingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.repository';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';
import { CreditGrantsRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.repository';
import { CreditGrantsService } from '@gitroom/nestjs-libraries/database/prisma/credits/grants/credit.grants.service';
import { PublishChargingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.repository';
import { PublishChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.service';
import { RecurringChargingRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/recurring/recurring.charging.repository';
import { RecurringChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/recurring/recurring.charging.service';
import { CreditBalanceRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/balance/credit.balance.repository';
import { CreditBalanceService } from '@gitroom/nestjs-libraries/database/prisma/credits/balance/credit.balance.service';
import { FreeGrantRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/free-grant/free.grant.repository';
import { FreeGrantService } from '@gitroom/nestjs-libraries/database/prisma/credits/free-grant/free.grant.service';
import { CreditsReconcileRepository } from '@gitroom/nestjs-libraries/database/prisma/credits/reconcile/credits.reconcile.repository';
import { CreditsReconcileService } from '@gitroom/nestjs-libraries/database/prisma/credits/reconcile/credits.reconcile.service';
import { AiChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service';
import { PaypalClient } from '@gitroom/nestjs-libraries/services/paypal/paypal.client';
import { PaypalEventsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.events.repository';
import { PaypalWebhookIntake } from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.webhook.intake';
import { PaypalSubscriptionsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/subscriptions/paypal.subscriptions.repository';
import { PaypalSubscriptionsService } from '@gitroom/nestjs-libraries/database/prisma/billing/subscriptions/paypal.subscriptions.service';
import { PaypalProvider } from '@gitroom/nestjs-libraries/services/payment/providers/paypal.provider';
import { TopupsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/topups/topups.repository';
import { TopupsService } from '@gitroom/nestjs-libraries/database/prisma/billing/topups/topups.service';
import { ReversalsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/reversals/reversals.repository';
import { ReversalsService } from '@gitroom/nestjs-libraries/database/prisma/billing/reversals/reversals.service';
import { IdempotencyRepository } from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.repository';
import { IdempotencyService } from '@gitroom/nestjs-libraries/database/prisma/idempotency/idempotency.service';
import { DeviceSessionsRepository } from '@gitroom/nestjs-libraries/database/prisma/device-sessions/device.sessions.repository';
import { ApiKeysRepository } from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.repository';
import { ApiKeysService } from '@gitroom/nestjs-libraries/database/prisma/api-keys/api-keys.service';
import { BrandsRepository } from '@gitroom/nestjs-libraries/database/prisma/brands/brands.repository';
import { BrandsService } from '@gitroom/nestjs-libraries/database/prisma/brands/brands.service';
import { AutoPublishRepository } from '@gitroom/nestjs-libraries/database/prisma/auto-publish/auto.publish.repository';
import { AutoPublishService } from '@gitroom/nestjs-libraries/database/prisma/auto-publish/auto.publish.service';
import { AutoPublishPlatformsService } from '@gitroom/nestjs-libraries/database/prisma/auto-publish/auto.publish.platforms.service';
import { MobileUploadRepository } from '@gitroom/nestjs-libraries/database/prisma/mobile-upload/mobile.upload.repository';
import { MobileUploadService } from '@gitroom/nestjs-libraries/database/prisma/mobile-upload/mobile.upload.service';
import { MediaRetentionRepository } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.repository';
import { MediaRetentionService } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.retention.service';
import { MediaSweepRepository } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.sweep.repository';
import { MediaSweepService } from '@gitroom/nestjs-libraries/database/prisma/media-retention/media.sweep.service';
import { WebHandoffRepository } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.repository';
import { WebHandoffService } from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.service';
import { ActivityLogRepository } from '@gitroom/nestjs-libraries/database/prisma/activity-log/activity.log.repository';
import { ActivityLogService } from '@gitroom/nestjs-libraries/database/prisma/activity-log/activity.log.service';
import { EntitlementsRepository } from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlements.repository';
import { EntitlementsService } from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlements.service';
import { EntitlementTokenSigner } from '@gitroom/nestjs-libraries/database/prisma/entitlements/entitlement.token.signer';
import { PromptBookRepository } from '@gitroom/nestjs-libraries/database/prisma/prompt-book/prompt.book.repository';
import { PromptBookService } from '@gitroom/nestjs-libraries/database/prisma/prompt-book/prompt.book.service';
import { AiCaptionsGenerator } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.generator';
import { AiCaptionsRepository } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.repository';
import { AiCaptionsService } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service';
import { ContentPlanGenerator } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.generator';
import { ContentPlanRepository } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.repository';
import { ContentPlanService } from '@gitroom/nestjs-libraries/database/prisma/content-plan/content.plan.service';
import { ClefOmniClient } from '@gitroom/nestjs-libraries/ai-video-edit/clef.omni.client';
import { EditAssetsService } from '@gitroom/nestjs-libraries/ai-video-edit/assets/edit.assets.service';
import { EditLlmService } from '@gitroom/nestjs-libraries/ai-video-edit/edit.llm.service';
import { AnthropicService } from '@gitroom/nestjs-libraries/anthropic/anthropic.service';
import { IconscoutClient } from '@gitroom/nestjs-libraries/ai-video-edit/assets/iconscout.client';
import { AiEditAssetsRepository } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.edit.assets.repository';
import { AiVideoEditsRepository } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edits.repository';
import { AiVideoEditTraceRepository } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.repository';
import { TraceService } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.service';
import { AiVideoEditsService } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edits.service';
import { TrackerRepository } from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.repository';
import { TrackerService } from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.service';

@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [
    PrismaService,
    PrismaRepository,
    PrismaTransaction,
    UsersService,
    UsersRepository,
    OrganizationService,
    OrganizationRepository,
    SubscriptionService,
    SubscriptionRepository,
    NotificationService,
    NotificationsRepository,
    WebhooksRepository,
    WebhooksService,
    IntegrationService,
    IntegrationRepository,
    PostsService,
    PostsRepository,
    PaymentService,
    PaymentProviderManager,
    RevenueCatProvider,
    SignatureRepository,
    AutopostRepository,
    AutopostService,
    SignatureService,
    MediaService,
    MediaRepository,
    AgenciesService,
    AgenciesRepository,
    IntegrationManager,
    RefreshIntegrationService,
    ExtractContentService,
    OpenaiService,
    AnthropicService,
    DeepgramService,
    MuseChatService,
    ElevenLabsTranscriptionService,
    {
      provide: MuseTranscriptionService,
      useClass: ElevenLabsTranscriptionService,
    },
    ClippingService,
    ClippingRepository,
    FalService,
    EmailService,
    TrackService,
    ShortLinkService,
    SetsService,
    SetsRepository,
    ThirdPartyRepository,
    ThirdPartyService,
    AppCredentialsRepository,
    AppCredentialsService,
    OAuthRepository,
    OAuthService,
    VideoManager,
    AnnouncementsRepository,
    AnnouncementsService,
    ErrorsRepository,
    ErrorsService,
    AdminStatsRepository,
    AdminStatsService,
    AccountsRepository,
    AccountsService,
    CreditsRepository,
    CreditsService,
    MoneyScope,
    PricingRepository,
    PricingService,
    CreditGrantsRepository,
    CreditGrantsService,
    PublishChargingRepository,
    PublishChargingService,
    RecurringChargingRepository,
    RecurringChargingService,
    CreditBalanceRepository,
    CreditBalanceService,
    FreeGrantRepository,
    FreeGrantService,
    CreditsReconcileRepository,
    CreditsReconcileService,
    AiChargingService,
    PaypalClient,
    PaypalEventsRepository,
    PaypalWebhookIntake,
    PaypalSubscriptionsRepository,
    PaypalSubscriptionsService,
    PaypalProvider,
    TopupsRepository,
    TopupsService,
    ReversalsRepository,
    ReversalsService,
    IdempotencyRepository,
    IdempotencyService,
    DeviceSessionsRepository,
    ApiKeysRepository,
    ApiKeysService,
    BrandsRepository,
    BrandsService,
    AutoPublishRepository,
    AutoPublishService,
    AutoPublishPlatformsService,
    MobileUploadRepository,
    MobileUploadService,
    MediaRetentionRepository,
    MediaRetentionService,
    MediaSweepRepository,
    MediaSweepService,
    EmailOtpRepository,
    WebHandoffRepository,
    WebHandoffService,
    ActivityLogRepository,
    ActivityLogService,
    EntitlementsRepository,
    EntitlementsService,
    EntitlementTokenSigner,
    PromptBookRepository,
    PromptBookService,
    AiCaptionsGenerator,
    AiCaptionsRepository,
    AiCaptionsService,
    ContentPlanGenerator,
    ContentPlanRepository,
    ContentPlanService,
    ClefOmniClient,
    IconscoutClient,
    AiEditAssetsRepository,
    EditAssetsService,
    EditLlmService,
    AiVideoEditsRepository,
    AiVideoEditTraceRepository,
    TraceService,
    AiVideoEditsService,
    TrackerRepository,
    TrackerService,
  ],
  get exports() {
    return this.providers;
  },
})
export class DatabaseModule {}
