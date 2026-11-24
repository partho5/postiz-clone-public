import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { Response } from 'express';
import { streamUploadOptions } from '@gitroom/nestjs-libraries/upload/multer.stream.engine';
import { ApiTags } from '@nestjs/swagger';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetIncludeDeletedFromRequest } from '@gitroom/nestjs-libraries/user/include.deleted.from.request';
import { Organization, User } from '@prisma/client';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import {
  AutoPublishNotConfiguredException,
  AutoPublishService,
} from '@gitroom/nestjs-libraries/database/prisma/auto-publish/auto.publish.service';
import { AutoPublishRequestDto } from '@gitroom/nestjs-libraries/dtos/auto-publish/auto.publish.request.dto';
import { AutoPublishChannelDto } from '@gitroom/nestjs-libraries/dtos/auto-publish/auto.publish.channel.dto';
import { AutoPublishPlatformsService } from '@gitroom/nestjs-libraries/database/prisma/auto-publish/auto.publish.platforms.service';
import { MobileUploadService } from '@gitroom/nestjs-libraries/database/prisma/mobile-upload/mobile.upload.service';
import { MobileUploadCreateDto } from '@gitroom/nestjs-libraries/dtos/mobile-upload/mobile.upload.create.dto';
import { MobileUploadCompleteDto } from '@gitroom/nestjs-libraries/dtos/mobile-upload/mobile.upload.complete.dto';
import { MobileUploadPartsDto } from '@gitroom/nestjs-libraries/dtos/mobile-upload/mobile.upload.parts.dto';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { ChangePostStatusDto } from '@gitroom/nestjs-libraries/dtos/posts/change.post.status.dto';
import { UpdatePostSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/update.post.settings.dto';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { VideoDto } from '@gitroom/nestjs-libraries/dtos/videos/video.dto';
import { VideoFunctionDto } from '@gitroom/nestjs-libraries/dtos/videos/video.function.dto';
import { UploadDto } from '@gitroom/nestjs-libraries/dtos/media/upload.dto';
import { ClippingDto } from '@gitroom/nestjs-libraries/dtos/clipping/clipping.dto';
import { ClippingService } from '@gitroom/nestjs-libraries/database/prisma/clipping/clipping.service';
import {
  AiCaptionsException,
  AiCaptionsService,
} from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service';
import { AiCaptionCreateDto } from '@gitroom/nestjs-libraries/dtos/ai-captions/ai.captions.create.dto';
import { AiVideoEditsService } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edits.service';
import { appVersionOf, requestIdOf } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.helpers';
import { AiVideoEditCreateDto } from '@gitroom/nestjs-libraries/dtos/ai-video-edits/ai.video.edit.create.dto';
import { AiVideoEditRenderReportDto } from '@gitroom/nestjs-libraries/dtos/ai-video-edits/ai.video.edit.render.report.dto';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { GetNotificationsDto } from '@gitroom/nestjs-libraries/dtos/notifications/get.notifications.dto';
import * as Sentry from '@sentry/nestjs';
import {
  socialIntegrationList,
  IntegrationManager,
} from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { getValidationSchemas } from '@gitroom/nestjs-libraries/chat/validation.schemas.helper';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { PostValidationException } from '@gitroom/backend/api/routes/posts.validation.exception';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { SuperAdminGuard } from '@gitroom/backend/services/auth/super.admin.guard';
import { timer } from '@gitroom/helpers/utils/timer';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { AdminStatsService } from '@gitroom/nestjs-libraries/database/prisma/admin-stats/admin-stats.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { GetOrgActivityDto } from '@gitroom/nestjs-libraries/dtos/analytics/get.org.activity.dto';
import dayjs from 'dayjs';
import { RequireScope } from '@gitroom/backend/services/auth/scopes/require.scope';
import { AppCredentialsService } from '@gitroom/nestjs-libraries/database/prisma/app-credentials/app.credentials.service';
import { MissingAppCredentialError } from '@gitroom/nestjs-libraries/database/prisma/app-credentials/app.credentials.context';
import { ScopeGuard } from '@gitroom/backend/services/auth/scopes/scope.guard';
import { RequireFeature } from '@gitroom/backend/services/auth/scopes/require.feature';
import { FeatureGuard } from '@gitroom/backend/services/auth/scopes/feature.guard';

@ApiTags('Public API')
@Controller('/public/v1')
@UseGuards(ScopeGuard, FeatureGuard)
export class PublicIntegrationsController {
  constructor(
    private _integrationService: IntegrationService,
    private _postsService: PostsService,
    private _mediaService: MediaService,
    private _notificationService: NotificationService,
    private _integrationManager: IntegrationManager,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _usersService: UsersService,
    private _adminStatsService: AdminStatsService,
    private _organizationService: OrganizationService,
    private _clippingService: ClippingService,
    private _autoPublishService: AutoPublishService,
    private _mobileUploadService: MobileUploadService,
    private _appCredentialsService: AppCredentialsService,
    private _autoPublishPlatformsService: AutoPublishPlatformsService,
    private _aiCaptionsService: AiCaptionsService,
    private _aiVideoEditsService: AiVideoEditsService
  ) {}

  @Post('/upload')
  @RequireScope('media:write')
  @UseInterceptors(FileInterceptor('file', streamUploadOptions()))
  async uploadSimple(
    @GetOrgFromRequest() org: Organization,
    @UploadedFile('file') file: Express.Multer.File
  ) {
    Sentry.metrics.count('public_api-request', 1);
    if (!file) {
      throw new HttpException({ msg: 'No file provided' }, 400);
    }

    return this._mediaService.saveFile(org.id, file.filename, file.path);
  }

  @Post('/upload/multipart')
  @RequireScope('media:write')
  async createMultipartUpload(
    @GetOrgFromRequest() org: Organization,
    @Body() body: MobileUploadCreateDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._mobileUploadService.create(org.id, body);
  }

  @Post('/upload/multipart/:id/parts')
  @HttpCode(200)
  @RequireScope('media:write')
  async signMultipartUploadParts(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: MobileUploadPartsDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._mobileUploadService.signParts(org.id, id, body.partNumbers);
  }

  @Get('/upload/multipart/:id')
  @RequireScope('media:write')
  async getMultipartUpload(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._mobileUploadService.status(org.id, id);
  }

  @Post('/upload/multipart/:id/complete')
  @RequireScope('media:write')
  async completeMultipartUpload(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: MobileUploadCompleteDto,
    @Res({ passthrough: true }) res: Response
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const done = await this._mobileUploadService.complete(
      org.id,
      id,
      body.parts,
      body.poster
    );
    // A caption audio answers 200 with only its id; a media keeps the 201 with its path
    if (!('path' in done)) {
      res.status(200);
    }
    return done;
  }

  @Delete('/upload/multipart/:id')
  @HttpCode(204)
  @RequireScope('media:write')
  async abortMultipartUpload(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    await this._mobileUploadService.abort(org.id, id);
  }

  @Post('/upload-from-url')
  @RequireScope('media:write')
  async uploadsFromUrl(
    @GetOrgFromRequest() org: Organization,
    @Body() body: UploadDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    try {
      return await this._mediaService.uploadFromUrl(org.id, body.url);
    } catch (err) {
      // Validation failures keep this route's { msg } error shape
      if (err instanceof BadRequestException) {
        throw new HttpException({ msg: err.message }, 400);
      }
      throw err;
    }
  }

  @Get('/find-slot/:id')
  @RequireScope('posts:read')
  async findSlotIntegration(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id?: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return { date: await this._postsService.findFreeDateTime(org.id, id) };
  }

  @Get('/posts')
  @RequireScope('posts:read')
  async getPosts(
    @GetOrgFromRequest() org: Organization,
    @Query() query: GetPostsDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const posts = await this._postsService.getPosts(org.id, query);
    return {
      posts,
      // comments,
    };
  }

  @Post('/posts')
  @RequireScope('posts:write')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  async createPost(
    @GetOrgFromRequest() org: Organization,
    @Body() rawBody: any
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const aiCaptionId = rawBody?.aiCaptionId;
    if (
      typeof aiCaptionId !== 'string' ||
      !aiCaptionId ||
      !Array.isArray(rawBody.posts)
    ) {
      return this.createPostFromBody(org.id, rawBody);
    }
    // ai.video-captions: the caption's text goes into the posts before the shared code validates and charges them
    const created = await this.createPostFromBody(org.id, {
      ...rawBody,
      posts: await this._aiCaptionsService.applyToPosts(
        org.id,
        aiCaptionId,
        rawBody.posts
      ),
    });
    await this._aiCaptionsService.linkPosts(org.id, aiCaptionId, created);
    await this._aiCaptionsService.useCaption(org.id, aiCaptionId);
    return created;
  }

  @Get('/posts/status')
  @RequireScope('posts:read')
  async getPostStatuses(
    @GetOrgFromRequest() org: Organization,
    @Query('ids') ids?: string | string[]
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const rawIds = Array.isArray(ids) ? ids.join(',') : ids;
    return this._autoPublishService.postStatuses(
      org.id,
      (typeof rawIds === 'string' ? rawIds : '')
        .split(',')
        .map((id) => id.trim())
    );
  }

  @Get('/auto-publish')
  @RequireScope('posts:read')
  async getAutoPublish(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user?: User
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const [info, costPerMinute] = await Promise.all([
      this._autoPublishService.info(org.id, user?.id),
      this._aiCaptionsService.costPerMinute(org.id),
    ]);
    return { ...info, aiCaptions: { costPerMinute } };
  }

  @Post('/auto-publish')
  @RequireScope('posts:write')
  @RequireFeature('auto_publish')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  async createAutoPublish(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AutoPublishRequestDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const rawBody = await this._autoPublishService.buildPostBody(org.id, body);
    const created = await this.createPostFromBody(org.id, rawBody);
    if (body.aiCaptionId) {
      await this._aiCaptionsService.linkPosts(org.id, body.aiCaptionId, created);
      await this._aiCaptionsService.useCaption(org.id, body.aiCaptionId);
    }
    return created;
  }

  // Switches auto-publish on or off for one of the workspace's channels (404 CHANNEL_NOT_FOUND for
  // another workspace's or a deleted channel).
  @Put('/auto-publish/channels/:integrationId')
  @HttpCode(204)
  @RequireScope('posts:write')
  @RequireFeature('auto_publish')
  async setAutoPublishChannel(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Body() body: AutoPublishChannelDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    await this._autoPublishService.setChannelExcluded(
      org.id,
      integrationId,
      !body.enabled
    );
  }

  // Switches the text post from a recording on or off for one of the channels that can get one (404
  // CHANNEL_NOT_FOUND for another workspace's or a deleted channel, 400 TEXT_POST_NOT_SUPPORTED for a
  // provider that cannot) and answers the channels that are on.
  @Put('/auto-publish/text-channels/:integrationId')
  @RequireScope('posts:write')
  async setAutoPublishTextChannel(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Body() body: AutoPublishChannelDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._autoPublishService.setTextChannel(
      org.id,
      integrationId,
      body.enabled
    );
  }

  // Validates a create-post body with the dashboard's rules and creates it, charging the workspace:
  // the one path behind POST /posts and POST /auto-publish.
  private async createPostFromBody(orgId: string, rawBody: any) {
    const body = await this._postsService.mapTypeToPost(
      rawBody,
      orgId,
      rawBody?.type === 'draft' || true
    );
    body.type = rawBody.type;

    if (
      process.env.RESTRICT_UPLOAD_DOMAINS &&
      body.posts.some((p) =>
        p.value.some((a) =>
          a.image.some(
            (i) => i.path.indexOf(process.env.RESTRICT_UPLOAD_DOMAINS) === -1
          )
        )
      )
    ) {
      throw new HttpException(
        {
          msg: `All media must be uploaded through our upload API route and contain the domain: ${process.env.RESTRICT_UPLOAD_DOMAINS}`,
        },
        400
      );
    }

    // Server-side validation — same rules as the dashboard, surfaced as a
    // readable 400 (see PostValidationExceptionFilter).
    const validation = await this._postsService.validatePosts(
      orgId,
      body.posts
    );

    const fail = (item: (typeof validation)[number], error: string) => {
      throw new PostValidationException({
        provider: item.identifier,
        name: item.name,
        error,
      });
    };

    for (const item of validation) {
      if (item.emptyContent) {
        fail(
          item,
          'Your post should have at least one character or one image.'
        );
      }
    }

    if (body.type !== 'draft') {
      for (const item of validation) {
        if (!item.valid) {
          fail(item, item.settingsError || 'Please fix your settings');
        }
        if (item.errors !== true) {
          fail(item, item.errors as string);
        }
        if (item.tooLong) {
          fail(item, 'post is too long, please fix it');
        }
      }
    }

    const allowedCreationMethods = ['CLI', 'API'] as const;
    const creationMethod = allowedCreationMethods.includes(
      rawBody.creationMethod
    )
      ? (rawBody.creationMethod as 'CLI' | 'API')
      : 'API';

    return this._postsService.createPost(orgId, body, creationMethod);
  }

  @Delete('/posts/:id')
  @RequireScope('posts:write')
  async deletePost(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const getPostById = await this._postsService.getPost(org.id, id);
    return this._postsService.deletePost(org.id, getPostById.group);
  }

  @Delete('/posts/group/:group')
  @RequireScope('posts:write')
  deletePostByGroup(
    @GetOrgFromRequest() org: Organization,
    @Param('group') group: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._postsService.deletePost(org.id, group);
  }

  @Get('/is-connected')
  @RequireScope('channels:read')
  async getActiveIntegrations(@GetOrgFromRequest() org: Organization) {
    Sentry.metrics.count('public_api-request', 1);
    return { connected: true };
  }

  @Get('/groups')
  @RequireScope('posts:read')
  async listGroups(@GetOrgFromRequest() org: Organization) {
    Sentry.metrics.count('public_api-request', 1);
    return (await this._integrationService.customers(org.id)).map(
      (customer) => ({
        id: customer.id,
        name: customer.name,
      })
    );
  }

  @Get('/integrations')
  @RequireScope('channels:read')
  async listIntegration(
    @GetOrgFromRequest() org: Organization,
    @Query('group') group?: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return (await this._integrationService.getIntegrationsList(org.id))
      .filter((integration) => !group || integration.customer?.id === group)
      .map((integration) => ({
        id: integration.id,
        name: integration.name,
        identifier: integration.providerIdentifier,
        picture: integration.picture,
        disabled: integration.disabled,
        profile: integration.profile,
        customer: integration.customer
          ? {
              id: integration.customer.id,
              name: integration.customer.name,
            }
          : undefined,
      }));
  }

  // Every provider the app can show, whether the workspace can connect it yet, its channels with
  // their auto-publish switch, and the auto-publish mode. canManageCredentials follows the caller's
  // own workspace role (false for an API key or OAuth-app token, which act as no member).
  @Get('/platforms')
  @RequireScope('channels:read')
  async listPlatforms(@GetOrgFromRequest() org: Organization) {
    Sentry.metrics.count('public_api-request', 1);
    return this._autoPublishPlatformsService.list(
      org.id,
      (org as Organization & { users?: { role?: string }[] }).users?.[0]?.role
    );
  }

  @Get('/social/:integration')
  @RequireScope('channels:read')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async getIntegrationUrl(
    @Param('integration') integration: string,
    @Query('refresh') refresh: string,
    @GetOrgFromRequest() org: Organization
  ) {
    Sentry.metrics.count('public_api-request', 1);
    if (
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(integration)
    ) {
      throw new HttpException({ msg: 'Integration not allowed' }, 400);
    }

    // A provider migrated via MIGRATE_PROVIDERS reconnects through its target
    // provider's OAuth: the callback lands on the target and the channel is
    // migrated in place (see migrateIntegration).
    const migrateTo = refresh
      ? this._integrationManager.getMigrationTarget(integration)
      : undefined;

    const integrationProvider = this._integrationManager.getSocialIntegration(
      migrateTo || integration
    );

    if (integrationProvider.externalUrl) {
      throw new HttpException(
        {
          msg: 'This integration requires an external URL and is not supported via the public API',
        },
        400
      );
    }

    // a provider this workspace has no app keys for cannot be connected (400 APP_CREDENTIAL_MISSING)
    await this._appCredentialsService.assertConfigured(
      org.id,
      integrationProvider.identifier
    );

    try {
      const { codeVerifier, state, url } =
        await this._appCredentialsService.runWithWorkspace(org.id, () =>
          integrationProvider.generateAuthUrl()
        );

      if (refresh) {
        await ioRedis.set(`refresh:${state}`, refresh, 'EX', 3600);
      }

      await ioRedis.set(`organization:${state}`, org.id, 'EX', 3600);
      await ioRedis.set(`login:${state}`, codeVerifier, 'EX', 3600);

      return { url };
    } catch (err) {
      // the workspace has not set this provider's app keys (400 APP_CREDENTIAL_MISSING)
      if (err instanceof MissingAppCredentialError) {
        throw err;
      }
      throw new HttpException({ msg: 'Failed to generate auth URL' }, 500);
    }
  }

  @Get('/users')
  @RequireScope('account:read')
  @UseGuards(SuperAdminGuard)
  async listUsers(
    @GetOrgFromRequest() org: Organization,
    @Query('name') name: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const term = name?.trim();

    if (!term) {
      throw new HttpException({ msg: 'A search term is required' }, 400);
    }

    return this._usersService.getImpersonateUser(term);
  }

  @Get('/debug/posts/:id')
  @RequireScope('account:read')
  @UseGuards(SuperAdminGuard)
  async getPostTimeline(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const timeline = await this._postsService.getPostTimeline(id, org.id);

    if (!timeline) {
      throw new HttpException({ msg: 'Post not found' }, 404);
    }

    return timeline;
  }

  @Get('/debug/account')
  @RequireScope('account:read')
  @UseGuards(SuperAdminGuard)
  async getAccountOverview(@GetOrgFromRequest() org: Organization) {
    Sentry.metrics.count('public_api-request', 1);
    const account = await this._organizationService.getAccountOverview(org.id);

    if (!account) {
      throw new HttpException({ msg: 'Organization not found' }, 404);
    }

    return account;
  }

  @Get('/debug/channels')
  @RequireScope('account:read')
  @UseGuards(SuperAdminGuard)
  async getChannelHealth(
    @GetOrgFromRequest() org: Organization,
    @GetIncludeDeletedFromRequest() includeDeleted: boolean
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._integrationService.getChannelHealth(org.id, includeDeleted);
  }

  @Get('/debug/activity')
  @RequireScope('account:read')
  @UseGuards(SuperAdminGuard)
  async getOrgActivity(
    @GetOrgFromRequest() org: Organization,
    @GetIncludeDeletedFromRequest() includeDeleted: boolean,
    @Query() query: GetOrgActivityDto
  ) {
    Sentry.metrics.count('public_api-request', 1);

    const from = query.from ? dayjs(query.from) : dayjs().subtract(30, 'day');
    const to = query.to ? dayjs(query.to) : dayjs();

    return this._adminStatsService.getOrgActivity({
      organizationId: org.id,
      from: from.startOf('day').toDate(),
      to: to.endOf('day').toDate(),
      includeDeleted,
    });
  }

  @Get('/notifications')
  @RequireScope('account:read')
  async getNotifications(
    @GetOrgFromRequest() org: Organization,
    @Query() query: GetNotificationsDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._notificationService.getNotificationsPaginated(
      org.id,
      query.page ?? 0
    );
  }

  @Post('/generate-video')
  @RequireScope('ai:use')
  generateVideo(
    @GetOrgFromRequest() org: Organization,
    @Body() body: VideoDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._mediaService.generateVideo(org, body);
  }

  @Post('/video/function')
  @RequireScope('ai:use')
  videoFunction(@Body() body: VideoFunctionDto) {
    Sentry.metrics.count('public_api-request', 1);
    return this._mediaService.videoFunction(
      body.identifier,
      body.functionName,
      body.params
    );
  }

  @Post('/clipping')
  @RequireScope('ai:use')
  startClipping(
    @GetOrgFromRequest() org: Organization,
    @Body() body: ClippingDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._clippingService.startClipping(org, body);
  }

  @Get('/clipping')
  @RequireScope('ai:use')
  getClippings(
    @GetOrgFromRequest() org: Organization,
    @Query('page') page: number
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._clippingService.getClippings(org.id, page);
  }

  @Get('/clipping/:id')
  @RequireScope('ai:use')
  getClipping(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    Sentry.metrics.count('public_api-request', 1);
    return this._clippingService.getClipping(org.id, id);
  }

  // Starts the AI caption job of an uploaded speech audio (ai.video-captions): 202 with the job, or 200 SKIPPED
  // when the credits for the captions and the publish do not both fit.
  @Post('/ai-captions')
  @RequireScope('posts:write')
  @RequireFeature('ai_captions')
  async createAiCaption(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User | undefined,
    @Body() body: AiCaptionCreateDto,
    @Res({ passthrough: true }) res: Response
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const created = await this._aiCaptionsService.create(
      org.id,
      user?.id,
      body,
      await this.captionChannelIds(org.id, user?.id, body)
    );
    res.status('id' in created ? 202 : 200);
    return created;
  }

  // A caption job's status and, once READY, the text of each channel and subtitle timing data (404 for another workspace's).
  @Get('/ai-captions/:id')
  @RequireScope('posts:read')
  getAiCaption(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._aiCaptionsService.get(org.id, id);
  }

  // The phone used a caption's transcript (the "sub" embed): commits the credits held for it, once. 200
  // `{ creditState }`, which is still HELD when they could not be committed now (the phone asks again later); 404
  // CAPTION_NOT_FOUND for another workspace's or a deleted caption.
  @Post('/ai-captions/:id/use')
  @HttpCode(200)
  @RequireScope('posts:write')
  async useAiCaption(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this.creditState(await this._aiCaptionsService.useCaption(org.id, id));
  }

  // The phone threw the recording away for good without using the caption: gives the held credits back. 200
  // `{ creditState }` (RELEASED, or what it already was); 404 CAPTION_NOT_FOUND for another workspace's caption.
  @Post('/ai-captions/:id/release')
  @HttpCode(200)
  @RequireScope('posts:write')
  async releaseAiCaption(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this.creditState(
      await this._aiCaptionsService.releaseCaption(org.id, id)
    );
  }

  // The AI editing engine contract (ai.video-editing): version, level rules, effect registry, text looks, palette,
  // phrases and sounds. The phone checks `contract_version` and refreshes its bundled copy from it. Declared
  // before any `/ai-edits/:id` route so `contract` is never read as an id.
  @Get('/ai-edits/contract')
  @RequireScope('posts:read')
  getAiEditContract() {
    Sentry.metrics.count('public_api-request', 1);
    return this._aiVideoEditsService.contract();
  }

  // What an AI edit of a recording `seconds` long costs this workspace at each level, for the level sheet. Declared
  // before `/ai-edits/:id` so `quote` is never read as an id.
  @Get('/ai-edits/quote')
  @RequireScope('posts:read')
  getAiEditQuote(
    @GetOrgFromRequest() org: Organization,
    @Query('seconds') seconds?: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._aiVideoEditsService.quote(org.id, Number(seconds));
  }

  // Starts the AI edit of a recording at a level (ai.video-editing): 202 with the job and the credits it holds.
  // Credits and the free plan's AI cap are the gate, so no plan feature is named.
  @Post('/ai-edits')
  @HttpCode(202)
  @RequireScope('posts:write')
  createAiEdit(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User | undefined,
    @Body() body: AiVideoEditCreateDto,
    @Headers('x-request-id') requestId?: string | string[]
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._aiVideoEditsService.create(org.id, user?.id, body, requestIdOf(requestId));
  }

  // An AI edit's status and, once READY, its plan and assets (404 EDIT_NOT_FOUND for another workspace's). The app's
  // `x-app-version` header is written on the trace row that logs the serve.
  @Get('/ai-edits/:id')
  @RequireScope('posts:read')
  getAiEdit(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Headers('x-app-version') appVersion?: string | string[]
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._aiVideoEditsService.get(org.id, id, appVersionOf(appVersion));
  }

  // The phone's receipt of one render attempt of an edit's plan (ai.video-editing): codes, ids and numbers only (a field
  // that is not in the receipt, or is free text, is a 400), body at most 64 KB (main.ts). The workspace's own edit only (404
  // EDIT_NOT_FOUND otherwise). Idempotent per attemptId: a repeat answers 200 and writes nothing. Scope `posts:write`, as
  // the other `/ai-edits` writes: there is no `ai-edit` scope.
  @Post('/ai-edits/:id/render-report')
  @HttpCode(200)
  @RequireScope('posts:write')
  reportAiEditRender(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    body: AiVideoEditRenderReportDto,
    @Headers('x-request-id') requestId?: string | string[]
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._aiVideoEditsService.renderReport(org.id, id, body, requestIdOf(requestId));
  }

  // The answer of the use and release routes: where the caption's credits stand; 404 when there is no such caption.
  private creditState(creditState: string | null) {
    if (!creditState) {
      throw new AiCaptionsException(404, 'CAPTION_NOT_FOUND', 'Caption not found');
    }
    return { creditState };
  }

  // The channels a caption job writes for: the ones the phone named (manual), or the ones auto-publish posts to
  // (409 when it has none) and the text-only channels the workspace switched on.
  private async captionChannelIds(
    orgId: string,
    userId: string | undefined,
    body: AiCaptionCreateDto
  ) {
    if (body.mode === 'manual') {
      return body.integrationIds || [];
    }
    const { channels } = await this._autoPublishService.info(orgId, userId);
    const usable = channels.filter((channel) => !channel.disabled);
    if (!usable.length) {
      throw new AutoPublishNotConfiguredException();
    }
    return [
      ...usable.map((channel) => channel.id),
      ...(await this._autoPublishService.textChannelIds(orgId)),
    ];
  }

  @Delete('/integrations/:id')
  @RequireScope('channels:write')
  async deleteChannel(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const isTherePosts = await this._integrationService.getPostsForChannel(
      org.id,
      id
    );
    if (isTherePosts.length) {
      for (const post of isTherePosts) {
        this._postsService.deletePost(org.id, post.group).catch(() => {});
      }
    }

    return this._integrationService.deleteChannel(org.id, id);
  }

  @Get('/integration-settings/:id')
  @RequireScope('channels:read')
  async getIntegrationSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const loadIntegration = await this._integrationService.getIntegrationById(
      org.id,
      id
    );

    if (!loadIntegration) {
      throw new HttpException({ msg: 'Integration not found' }, 404);
    }

    const verified =
      JSON.parse(loadIntegration.additionalSettings || '[]')?.find(
        (p: any) => p?.title === 'Verified'
      )?.value || false;

    const integration = socialIntegrationList.find(
      (p) => p.identifier === loadIntegration.providerIdentifier
    )!;

    if (!integration) {
      return {
        output: { rules: '', maxLength: 0, settings: {}, tools: [] as any[] },
      };
    }

    const maxLength = integration.maxLength(verified);
    const schemas = !integration.dto
      ? false
      : getValidationSchemas()[integration.dto.name];
    const tools = this._integrationManager.getAllTools();
    const rules = this._integrationManager.getAllRulesDescription();

    return {
      output: {
        rules: rules[integration.identifier],
        maxLength,
        settings: !schemas ? 'No additional settings required' : schemas,
        tools: tools[integration.identifier],
      },
    };
  }

  @Get('/posts/:id/missing')
  @RequireScope('posts:read')
  async getMissingContent(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._postsService.getMissingContent(org.id, id);
  }

  @Put('/posts/:id/settings')
  @RequireScope('posts:write')
  async updatePostSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdatePostSettingsDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._postsService.updatePostSettings(
      org.id,
      id,
      body.settings,
      'API'
    );
  }

  @Put('/posts/:id/status')
  @RequireScope('posts:write')
  async changePostStatus(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: ChangePostStatusDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._postsService.changePostStatus(org.id, id, body.status);
  }

  @Put('/posts/:id/release-id')
  @RequireScope('posts:write')
  async updateReleaseId(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body('releaseId') releaseId: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._postsService.updateReleaseId(org.id, id, releaseId);
  }

  @Get('/analytics/:integration')
  @RequireScope('channels:read')
  async getAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('integration') integration: string,
    @Query('date') date: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._integrationService.checkAnalytics(org, integration, date);
  }

  @Get('/analytics/post/:postId')
  @RequireScope('posts:read')
  async getPostAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string,
    @Query('date') date: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._postsService.checkPostAnalytics(org.id, postId, +date);
  }

  @Post('/integration-trigger/:id')
  @RequireScope('channels:write')
  async triggerIntegrationTool(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { methodName: string; data: Record<string, string> }
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const getIntegration = await this._integrationService.getIntegrationById(
      org.id,
      id
    );

    if (!getIntegration) {
      throw new HttpException({ msg: 'Integration not found' }, 404);
    }

    const integrationProvider = socialIntegrationList.find(
      (p) => p.identifier === getIntegration.providerIdentifier
    )!;

    if (!integrationProvider) {
      throw new HttpException({ msg: 'Integration provider not found' }, 404);
    }

    const tools = this._integrationManager.getAllTools();
    if (
      // @ts-ignore
      !tools[integrationProvider.identifier]?.some(
        (p: any) => p.methodName === body.methodName
      ) ||
      // @ts-ignore
      !integrationProvider[body.methodName]
    ) {
      throw new HttpException({ msg: 'Tool not found' }, 404);
    }

    while (true) {
      try {
        const result = await this._appCredentialsService.runWithWorkspace(
          org.id,
          async () =>
            // @ts-ignore
            integrationProvider[body.methodName](
              getIntegration.token,
              body.data || {},
              getIntegration.internalId,
              getIntegration
            )
        );

        return { output: result };
      } catch (err) {
        // the workspace has not set this provider's keys (400 APP_CREDENTIAL_MISSING)
        if (err instanceof MissingAppCredentialError) {
          throw err;
        }
        if (err instanceof RefreshToken) {
          const data = await this._refreshIntegrationService.refresh(
            getIntegration
          );

          if (!data) {
            await this._integrationService.disconnectChannel(
              org.id,
              getIntegration
            );
            throw new HttpException(
              { msg: 'Channel disconnected due to expired token' },
              401
            );
          }

          const { accessToken } = data;

          if (accessToken) {
            getIntegration.token = accessToken;

            if (integrationProvider.refreshWait) {
              await timer(10000);
            }

            continue;
          }
        }
        throw new HttpException({ msg: 'Unexpected error' }, 500);
      }
    }
  }
}
