import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import {
  AnalyticsData,
  AuthTokenDetails,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import dayjs from 'dayjs';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import {
  BadBody,
  Disconnect,
  RefreshToken,
  SocialAbstract,
  ValidityMedia,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { TikTokDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/tiktok.dto';
import { timer } from '@gitroom/helpers/utils/timer';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import { createReadStream } from 'fs';
import { getSsrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { Integration } from '@prisma/client';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { mediaBaseUrl } from '@gitroom/helpers/utils/media.base.url';
import { appCredential } from '@gitroom/nestjs-libraries/database/prisma/app-credentials/app.credentials.context';

// Feature: media-publish-url (PUB-B2). The channel's own switch (stored in
// Integration.additionalSettings, found by this title like X's `Verified`):
// let TikTok pull a video from the media base URL instead of the VPS streaming
// the bytes. Off unless the channel owner turned it on.
export const TIKTOK_PULL_SETTING = 'Let TikTok fetch from my media domain';

// Travels through the workflow history between postPending, checkPostStatus
// and finalizePost - keep it small JSON. `pullFallback` exists only while a
// PULL_FROM_URL video has not been confirmed yet: it carries what the
// FILE_UPLOAD retry needs. The attempting / confirmed flags are the same
// arm -> confirm -> run handshake as Pinterest's create, so an upload that
// died with an unknown outcome is detected instead of run (and posted) again.
type TiktokPendingData = {
  publishId: string;
  pullFallback?: {
    endpoint: string; // the init path, e.g. /video/init/
    postInfo: Record<string, any>;
    path: string; // the video URL
    attempting?: boolean;
    confirmed?: boolean;
  };
};

// What TikTok answers when it cannot fetch (or does not trust) the URL.
const TIKTOK_PULL_FAILURES = [
  'url_ownership_unverified',
  'video_pull_failed',
  'url_not_supported',
];

@Rules(
  [
    'TikTok can have one video or one picture or multiple pictures, it cannot be without an attachment.',
    'content_posting_method=DIRECT_POST publishes the post to the account. content_posting_method=UPLOAD does NOT publish: it only sends the media to the user inbox of the TikTok app, where the user must manually complete and publish it within 24 hours or it is discarded. Use DIRECT_POST unless the user explicitly asks to review or edit the post inside the TikTok app first.',
    'With content_posting_method=UPLOAD, TikTok ignores every setting except the title / post content. Never tell the user that video_made_with_ai, privacy_level, duet, stitch, comment, autoAddMusic, brand_content_toggle or brand_organic_toggle will be applied in UPLOAD mode - they are silently discarded. If the user asks for any of those settings, tell them it requires DIRECT_POST.',
    'video_made_with_ai, duet and stitch apply to video posts only. TikTok has no equivalent field for photo posts, so those settings are discarded when the attachment is a picture.',
  ].join(' ')
)
export class TiktokProvider extends SocialAbstract implements SocialProvider {
  identifier = 'tiktok';
  appCredentials = [
    { key: 'TIKTOK_CLIENT_ID', label: 'Client Key', secret: false },
    { key: 'TIKTOK_CLIENT_SECRET', label: 'Client Secret', secret: true },
  ];

  override appCallbackUrl() {
    return this.httpsCallbackUrl();
  }

  name = 'Tiktok';
  isBetweenSteps = false;
  convertToJPEG = true;
  scopes = [
    'video.list',
    'user.info.basic',
    'video.publish',
    'video.upload',
    'user.info.profile',
    'user.info.stats',
  ];
  override maxConcurrentJob = 10000;
  dto = TikTokDto;
  editor = 'normal' as const;
  maxLength() {
    return 2000;
  }

  defaultAdditionalSettings() {
    return [
      {
        title: TIKTOK_PULL_SETTING,
        description:
          'Off by default: the video is uploaded to TikTok for you. When on, TikTok downloads the video straight ' +
          `from ${mediaBaseUrl() || 'your media domain'}, which is faster. It only works after you verify that ` +
          'domain (or URL prefix) in your TikTok developer app under URL properties, with a DNS signature ' +
          'recommended. The address must be HTTPS, must not redirect, and must stay reachable while TikTok ' +
          'downloads (up to 1 hour). If TikTok cannot fetch the video, it is uploaded automatically instead.',
        type: 'checkbox' as const,
        value: false,
      },
    ];
  }

  override async checkValidity(
    items: Array<ValidityMedia[]>
  ): Promise<string | true> {
    const [firstItems] = items ?? [];
    if ((firstItems?.length ?? 0) === 0) {
      return 'No video / images selected';
    }
    if (
      (firstItems?.length ?? 0) > 1 &&
      firstItems?.some((p) => (p?.path?.indexOf?.('mp4') ?? -1) > -1)
    ) {
      return 'Only pictures are supported when selecting multiple items';
    } else if (
      firstItems?.length !== 1 &&
      (firstItems?.[0]?.path?.indexOf?.('mp4') ?? -1) > -1
    ) {
      return 'You need one media';
    }

    // TikTok fails the whole photo post when a single image is oversized, and
    // the status only says `picture_size_check_failed` without naming it.
    if (firstItems?.every((p) => (p?.path?.indexOf?.('mp4') ?? -1) === -1)) {
      const dimensions = await Promise.all(
        firstItems?.map((p) => this.getImageDimensions(p?.path)) ?? []
      );
      const tooBig = dimensions.findIndex(
        (p) => Math.min(p?.width ?? 0, p?.height ?? 0) > 1080
      );
      if (tooBig > -1) {
        return `Image ${tooBig + 1} is ${dimensions[tooBig]?.width}x${
          dimensions[tooBig]?.height
        }, TikTok allows a maximum of 1080px on the shorter side`;
      }
    }
    return true;
  }

  override handleErrors(body: string):
    | {
        type: 'refresh-token' | 'bad-body' | 'disconnect';
        value: string;
      }
    | undefined {
    // Authentication/Authorization errors - require re-authentication
    if (body.indexOf('access_token_invalid') > -1) {
      return {
        type: 'refresh-token' as const,
        value:
          'Access token invalid, please re-authenticate your TikTok account',
      };
    }

    if (body.indexOf('scope_not_authorized') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Missing required permissions, please re-authenticate with all scopes',
      };
    }

    if (body.indexOf('scope_permission_missed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Additional permissions required, please re-authenticate',
      };
    }

    // Rate limiting errors
    if (body.indexOf('rate_limit_exceeded') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'TikTok API rate limit exceeded, please try again later',
      };
    }

    if (body.indexOf('file_format_check_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'File format is invalid, please check video specifications',
      };
    }

    if (body.indexOf('app_version_check_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'In order to use the TikTok upload feature, you have to update your app to the latest version',
      };
    }

    if (body.indexOf('duration_check_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Video duration is invalid, please check video specifications',
      };
    }

    if (body.indexOf('frame_rate_check_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Video frame rate is invalid, please check video specifications',
      };
    }

    if (body.indexOf('video_pull_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Failed to pull video from URL, please check the URL',
      };
    }

    if (body.indexOf('photo_pull_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Failed to pull photo from URL, please check the URL',
      };
    }

    if (body.indexOf('spam_risk_user_banned_from_posting') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Account banned from posting, please check TikTok account status',
      };
    }

    if (body.indexOf('spam_risk_text') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'TikTok detected potential spam in the post text',
      };
    }

    if (body.indexOf('spam_risk_too_many_posts') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'TikTok says your daily post limit reached, please try again tomorrow',
      };
    }

    if (body.indexOf('spam_risk_too_many_pending_share') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'TikTok limits pending posts to 5 within any 24-hour period. Please check your TikTok inbox in the TikTok mobile app and try again after 24 hours.',
      };
    }

    if (body.indexOf('spam_risk_user_banned_from_posting') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Account banned from posting, please check TikTok account status',
      };
    }

    if (body.indexOf('spam_risk') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'TikTok detected potential spam',
      };
    }

    // TikTok limits how many users of this app can post per day: refreshing
    // the token cannot help, the channel must be re-connected (and can be
    // migrated to another app via MIGRATE_PROVIDERS).
    if (body.indexOf('reached_active_user_cap') > -1) {
      return {
        type: 'disconnect' as const,
        value:
          'TikTok daily user limit reached, please re-connect your account',
      };
    }

    if (
      body.indexOf('unaudited_client_can_only_post_to_private_accounts') > -1
    ) {
      return {
        type: 'bad-body' as const,
        value: 'App not approved for public posting, contact support',
      };
    }

    if (body.indexOf('url_ownership_unverified') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          `You have to upload the picture/video to ${PRODUCT_NAME} when sending a URL`,
      };
    }

    if (body.indexOf('privacy_level_option_mismatch') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Privacy level mismatch, please check privacy settings',
      };
    }

    // Content/Format validation errors
    if (body.indexOf('invalid_file_upload') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid file format or specifications not met',
      };
    }

    if (body.indexOf('invalid_params') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid request parameters, please check content format',
      };
    }

    // Server errors
    if (body.indexOf('internal') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'There is a problem with TikTok servers, please try again later',
      };
    }

    // Generic TikTok API errors
    if (body.indexOf('picture_size_check_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Media size not supported by TikTok: images up to 1080px on the shorter side, videos at least 360px on both sides',
      };
    }

    if (body.indexOf('TikTok API error') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'TikTok API error, please try again',
      };
    }

    // Fall back to parent class error handling
    return undefined;
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const value = {
      client_key: await appCredential('TIKTOK_CLIENT_ID'),
      client_secret: await appCredential('TIKTOK_CLIENT_SECRET'),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    };

    const { access_token, refresh_token, ...all } = await (
      await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
        body: new URLSearchParams(value).toString(),
      })
    ).json();

    const {
      data: {
        user: { avatar_url, display_name, open_id, username },
      },
    } = await (
      await fetch(
        'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name,union_id,username',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${access_token}`,
          },
        }
      )
    ).json();

    return {
      refreshToken: refresh_token,
      expiresIn: dayjs().add(23, 'hours').unix() - dayjs().unix(),
      accessToken: access_token,
      id: open_id.replace(/-/g, ''),
      name: display_name,
      picture: avatar_url || '',
      username: username,
    };
  }

  async generateAuthUrl() {
    const state = makeSecureId(16);

    return {
      url:
        'https://www.tiktok.com/v2/auth/authorize/' +
        `?client_key=${await appCredential('TIKTOK_CLIENT_ID')}` +
        `&redirect_uri=${encodeURIComponent(
          `${this.appCallbackUrl()}`
        )}` +
        `&state=${state}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(this.scopes.join(','))}`,
      codeVerifier: state,
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const value = {
      client_key: await appCredential('TIKTOK_CLIENT_ID'),
      client_secret: await appCredential('TIKTOK_CLIENT_SECRET'),
      code: params.code,
      grant_type: 'authorization_code',
      code_verifier: params.codeVerifier,
      redirect_uri: `${this.appCallbackUrl()}`,
    };

    const { access_token, refresh_token, scope } = await (
      await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
        body: new URLSearchParams(value).toString(),
      })
    ).json();

    this.checkScopes(this.scopes, scope);

    const {
      data: {
        user: { avatar_url, display_name, open_id, username },
      },
    } = await (
      await fetch(
        'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name,union_id,username',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${access_token}`,
          },
        }
      )
    ).json();

    return {
      id: open_id.replace(/-/g, ''),
      name: display_name,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: dayjs().add(23, 'hours').unix() - dayjs().unix(),
      picture: avatar_url,
      username: username,
    };
  }

  async maxVideoLength(accessToken: string) {
    const {
      data: { max_video_post_duration_sec },
    } = await (
      await fetch(
        'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      )
    ).json();

    return {
      maxDurationSeconds: max_video_post_duration_sec,
    };
  }

  // Single status check for a publish_id, no loops and no timers: `post` returns
  // a `pending` PostResponse right after the upload, and the post workflow polls
  // this method with durable timers, so a stuck/retried check can never re-run
  // the publish and duplicate the post.
  override async checkPostStatus(
    accessToken: string,
    pendingData: TiktokPendingData,
    integration: Integration
  ): Promise<PendingCheckResponse> {
    const fallback = pendingData.pullFallback;

    // A confirmed upload attempt died without reporting its result: TikTok
    // gives no way to ask whether it was received, so never run it again.
    if (fallback?.attempting && fallback?.confirmed) {
      throw new BadBody(
        'tiktok-error-upload',
        '{}',
        Buffer.from('{}'),
        'TikTok may have already received this video, please check your TikTok account before posting again to avoid duplicates'
      );
    }

    // witness the armed upload so finalizePost knows the attempt is uniquely
    // accounted for before it uploads anything
    if (fallback?.attempting && !fallback?.confirmed) {
      return {
        status: 'ready',
        pendingData: {
          ...pendingData,
          pullFallback: { ...fallback, confirmed: true },
        },
      };
    }

    let post: any;
    try {
      post = await (
        await this.fetch(
          'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              publish_id: pendingData.publishId,
            }),
          },
          '',
          0,
          true
        )
      ).json();
    } catch (err) {
      if (err instanceof RefreshToken || err instanceof Disconnect) {
        throw err;
      }

      // Transient API error while checking the status: the post may already
      // be live, so keep polling instead of failing it - if the API stays
      // broken the caller exhausts its checks and warns the user properly.
      return { status: 'pending', pendingData };
    }

    const { status, publicaly_available_post_id } = post?.data || {};

    if (status === 'SEND_TO_USER_INBOX') {
      return {
        status: 'completed',
        releaseURL: 'https://www.tiktok.com/messages?lang=en',
        postId: 'missing',
      };
    }

    if (status === 'PUBLISH_COMPLETE') {
      // an empty array is truthy, so index it once and branch on the value
      const publicPostId = publicaly_available_post_id?.[0];

      return {
        status: 'completed',
        releaseURL: !publicPostId
          ? `https://www.tiktok.com/@${integration.profile}`
          : `https://www.tiktok.com/@${integration.profile}/video/${publicPostId}`,
        // TikTok returns the id as a number, releaseId in the db is a string
        postId: !publicPostId ? pendingData.publishId : String(publicPostId),
      };
    }

    if (status === 'FAILED') {
      // TikTok could not pull the video from our media domain: hand over to
      // finalizePost, which uploads the file instead (the post did not publish)
      if (fallback && this.isPullFailure(JSON.stringify(post))) {
        return { status: 'ready', pendingData };
      }

      const handleError = this.handleErrors(JSON.stringify(post));
      throw new BadBody(
        'titok-error-upload',
        JSON.stringify(post),
        Buffer.from(JSON.stringify(post)),
        handleError?.value || ''
      );
    }

    return { status: 'pending', pendingData };
  }

  // UPLOAD does not publish - it only drops the media into the user's TikTok
  // inbox - so only an explicit UPLOAD selects it. A missing value (drafts, or
  // any caller that skipped the setting) publishes instead of silently landing
  // in the inbox.
  private contentPostingMethod(
    firstPost: PostDetails<TikTokDto>
  ): TikTokDto['content_posting_method'] {
    return firstPost?.settings?.content_posting_method === 'UPLOAD'
      ? 'UPLOAD'
      : 'DIRECT_POST';
  }

  private postingMethod(
    method: TikTokDto['content_posting_method'],
    isPhoto: boolean
  ): string {
    switch (method) {
      case 'UPLOAD':
        return isPhoto ? '/content/init/' : '/inbox/video/init/';
      case 'DIRECT_POST':
      default:
        return isPhoto ? '/content/init/' : '/video/init/';
    }
  }

  private buildTikokPostInfoBody(firstPost: PostDetails<TikTokDto>) {
    const isPhoto = !hasExtension(firstPost?.media?.[0]?.path, 'mp4');
    const method = this.contentPostingMethod(firstPost);

    if (method === 'DIRECT_POST') {
      return {
        post_info: {
          ...(isPhoto && firstPost.settings.title
            ? { title: firstPost.settings.title.slice(0, 90) }
            : {}),
          ...(!isPhoto && firstPost.message
            ? { title: firstPost.message }
            : {}),
          ...(isPhoto ? { description: firstPost.message } : {}),
          privacy_level:
            firstPost.settings.privacy_level || 'PUBLIC_TO_EVERYONE',
          ...(isPhoto
            ? {}
            : { disable_duet: !this.assetBoolean(firstPost.settings.duet) }),
          disable_comment: !this.assetBoolean(firstPost.settings.comment),
          ...(isPhoto
            ? {}
            : {
                disable_stitch: !this.assetBoolean(firstPost.settings.stitch),
              }),
          ...(isPhoto
            ? {}
            : {
                is_aigc: this.assetBoolean(
                  firstPost.settings.video_made_with_ai
                ),
              }),
          brand_content_toggle: this.assetBoolean(
            firstPost.settings.brand_content_toggle
          ),
          brand_organic_toggle: this.assetBoolean(
            firstPost.settings.brand_organic_toggle
          ),
          ...(isPhoto
            ? {
                auto_add_music: firstPost.settings.autoAddMusic === 'yes',
              }
            : {}),
        },
      };
    }

    return {
      post_info: {
        ...(isPhoto && firstPost.settings.title
          ? { title: firstPost.settings.title }
          : {}),
        ...(!isPhoto && firstPost.message ? { title: firstPost.message } : {}),
        ...(isPhoto ? { description: firstPost.message } : {}),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // OLD PULL_FROM_URL IMPLEMENTATION (reference only: video pull is now
  // implemented above, behind the per-channel opt-in setting with an automatic
  // FILE_UPLOAD fallback; see `canPull` and `publish`)
  // ---------------------------------------------------------------------------
  // private buildTikokSourceInfoBody(firstPost: PostDetails<TikTokDto>) {
  //   const isPhoto = !hasExtension(firstPost?.media?.[0]?.path, 'mp4');
  //
  //   if (isPhoto) {
  //     return {
  //       post_mode:
  //         firstPost?.settings?.content_posting_method === 'DIRECT_POST'
  //           ? 'DIRECT_POST'
  //           : 'MEDIA_UPLOAD',
  //       media_type: 'PHOTO',
  //       source_info: {
  //         source: 'PULL_FROM_URL',
  //         photo_cover_index: 0,
  //         photo_images: firstPost.media?.map((p) => p.path),
  //       },
  //     };
  //   }
  //
  //   return {
  //     source_info: {
  //       source: 'PULL_FROM_URL',
  //       video_url: firstPost?.media?.[0]?.path!,
  //       ...(firstPost?.media?.[0]?.thumbnailTimestamp!
  //         ? {
  //             video_cover_timestamp_ms:
  //               firstPost?.media?.[0]?.thumbnailTimestamp!,
  //           }
  //         : {}),
  //     },
  //   };
  // }
  //
  // async post(
  //   id: string,
  //   accessToken: string,
  //   postDetails: PostDetails<TikTokDto>[],
  //   integration: Integration
  // ): Promise<PostResponse[]> {
  //   const [firstPost] = postDetails;
  //   const isPhoto = !hasExtension(firstPost?.media?.[0]?.path, 'mp4');
  //
  //   console.log({
  //     ...this.buildTikokPostInfoBody(firstPost),
  //     ...this.buildTikokSourceInfoBody(firstPost),
  //   });
  //   const {
  //     data: { publish_id },
  //   } = await (
  //     await this.fetch(
  //       `https://open.tiktokapis.com/v2/post/publish${this.postingMethod(
  //         firstPost.settings.content_posting_method,
  //         !hasExtension(firstPost?.media?.[0]?.path, 'mp4')
  //       )}`,
  //       {
  //         method: 'POST',
  //         headers: {
  //           'Content-Type': 'application/json; charset=UTF-8',
  //           Authorization: `Bearer ${accessToken}`,
  //         },
  //         body: JSON.stringify({
  //           ...this.buildTikokPostInfoBody(firstPost),
  //           ...this.buildTikokSourceInfoBody(firstPost),
  //         }),
  //       }
  //     )
  //   ).json();
  //
  //   const { url, id: videoId } = await this.uploadedVideoSuccess(
  //     integration.profile!,
  //     publish_id,
  //     accessToken
  //   );
  //
  //   return [
  //     {
  //       id: firstPost.id,
  //       releaseURL: url,
  //       postId: String(videoId),
  //       status: 'success',
  //     },
  //   ];
  // }

  // ---------------------------------------------------------------------------
  // FILE_UPLOAD IMPLEMENTATION (videos are pulled from the URL only when the
  // channel owner turned on TIKTOK_PULL_SETTING, with this upload as fallback)
  // ---------------------------------------------------------------------------
  // TikTok video chunk constraints: a chunk must be between 5MB and 64MB.
  // When the whole file fits in a single chunk (<= 64MB) we upload it in one
  // request; otherwise we split it into 10MB chunks (the final chunk carries
  // the remainder, which TikTok allows to exceed chunk_size).
  private static readonly TIKTOK_MAX_SINGLE_CHUNK = 64 * 1024 * 1024;
  private static readonly TIKTOK_CHUNK_SIZE = 10 * 1024 * 1024;

  private tiktokChunkPlan(videoSize: number) {
    if (videoSize <= TiktokProvider.TIKTOK_MAX_SINGLE_CHUNK) {
      return { chunkSize: videoSize, totalChunkCount: 1 };
    }

    const chunkSize = TiktokProvider.TIKTOK_CHUNK_SIZE;
    return {
      chunkSize,
      totalChunkCount: Math.floor(videoSize / chunkSize),
    };
  }

  // Returns a streaming body for the [start, end] byte range of the media so we
  // never hold the whole file in memory: a ranged GET for remote URLs, a ranged
  // read stream for local files.
  private async tiktokChunkStream(path: string, start: number, end: number) {
    if (path.indexOf('http') === 0) {
      // identity encoding so the store keeps content-length and can answer
      // with the requested range, matching every other media read
      const response = await fetch(path, {
        headers: {
          Range: `bytes=${start}-${end}`,
          'accept-encoding': 'identity',
        },
        dispatcher: getSsrfSafeDispatcher(),
      } as any);

      // A store that ignores Range (200 with the full file) or answers with an
      // error page would corrupt the upload at this offset.
      if (response.status !== 206) {
        throw new BadBody(
          'tiktok-error-upload',
          '{}',
          '{}',
          'The media storage did not return the requested byte range, please try again'
        );
      }

      return response.body;
    }

    return createReadStream(path, { start, end });
  }

  // Streams the video bytes to the upload_url returned by the init call.
  // We use the global fetch (not this.fetch) because chunked uploads answer
  // with 206 (Partial Content), which this.fetch would treat as an error.
  private async uploadTikTokVideoBytes(
    uploadUrl: string,
    path: string,
    videoSize: number,
    contentType: string
  ) {
    const { chunkSize, totalChunkCount } = this.tiktokChunkPlan(videoSize);

    for (let i = 0; i < totalChunkCount; i++) {
      const start = i * chunkSize;
      const end =
        i === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
      const contentLength = end - start + 1;

      const body = await this.tiktokChunkStream(path, start, end);

      const upload = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(contentLength),
          'Content-Range': `bytes ${start}-${end}/${videoSize}`,
        },
        body,
        // Required by undici when streaming a request body.
        duplex: 'half',
      } as any);

      if (
        upload.status !== 200 &&
        upload.status !== 201 &&
        upload.status !== 206
      ) {
        const text = await upload.text().catch(() => '{}');
        const handleError = this.handleErrors(text);
        throw new BadBody(
          'tiktok-error-upload',
          text,
          Buffer.from(text),
          handleError?.value || 'Failed to upload the video to TikTok'
        );
      }
    }
  }

  private buildTikokSourceInfoBody(
    firstPost: PostDetails<TikTokDto>,
    videoSize?: number
  ) {
    const isPhoto = !hasExtension(firstPost?.media?.[0]?.path, 'mp4');

    // TikTok photo posts only support PULL_FROM_URL, there is no FILE_UPLOAD
    // path for photos, so this branch keeps pulling from the URL.
    if (isPhoto) {
      return {
        post_mode:
          this.contentPostingMethod(firstPost) === 'DIRECT_POST'
            ? 'DIRECT_POST'
            : 'MEDIA_UPLOAD',
        media_type: 'PHOTO',
        source_info: {
          source: 'PULL_FROM_URL',
          photo_cover_index: 0,
          photo_images: firstPost.media?.map((p) => p.path),
        },
      };
    }

    return this.fileUploadSourceInfo(videoSize || 0);
  }

  private fileUploadSourceInfo(videoSize: number) {
    const { chunkSize, totalChunkCount } = this.tiktokChunkPlan(videoSize);

    return {
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    };
  }

  // The channel owner's switch, see TIKTOK_PULL_SETTING.
  private pullEnabled(integration: Integration): boolean {
    try {
      return (
        JSON.parse(integration?.additionalSettings || '[]')?.find(
          (p: any) => p?.title === TIKTOK_PULL_SETTING
        )?.value === true
      );
    } catch (err) {
      return false;
    }
  }

  // Only a video that sits on our own media base URL can be pulled: that is
  // the domain the channel owner verifies in the TikTok developer app.
  private canPull(
    videoPath: string,
    isPhoto: boolean,
    integration: Integration
  ): boolean {
    const base = mediaBaseUrl();
    return (
      !isPhoto &&
      !!base &&
      videoPath?.indexOf(`${base}/`) === 0 &&
      this.pullEnabled(integration)
    );
  }

  private isPullFailure(body: string): boolean {
    return TIKTOK_PULL_FAILURES.some((code) => body.indexOf(code) > -1);
  }

  // Calls the init endpoint with a ready body and returns the ids it answers.
  private async initPublish(
    accessToken: string,
    endpoint: string,
    body: Record<string, any>
  ): Promise<{ publish_id: string; upload_url?: string }> {
    const {
      data: { publish_id, upload_url },
    } = await (
      await this.fetch(
        `https://open.tiktokapis.com/v2/post/publish${endpoint}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(body),
        }
      )
    ).json();

    return { publish_id, upload_url };
  }

  // FILE_UPLOAD of a video: init, then stream the bytes to the upload_url.
  // Returns the publish id to poll.
  private async startFileUpload(
    accessToken: string,
    endpoint: string,
    postInfo: Record<string, any>,
    videoPath: string
  ): Promise<string> {
    // only the total size is needed up front (HEAD / statSync); the bytes are
    // streamed later, never fully loaded into memory
    const videoSize = await this.mediaSize(videoPath, 'tiktok-error-upload');

    const { publish_id, upload_url } = await this.initPublish(
      accessToken,
      endpoint,
      { ...postInfo, ...this.fileUploadSourceInfo(videoSize) }
    );

    if (upload_url && videoSize) {
      try {
        await this.uploadTikTokVideoBytes(
          upload_url,
          videoPath,
          videoSize,
          'video/mp4'
        );
      } catch (err) {
        // An explicit rejection from TikTok: the post won't publish, fail it
        if (err instanceof BadBody) {
          throw err;
        }

        // A network error here is ambiguous - TikTok may have received all
        // the bytes and still publish. Return the id and let checkPostStatus
        // deliver TikTok's own verdict instead of letting the caller retry
        // the publish.
      }
    }

    return publish_id;
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails<TikTokDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return this.publish(accessToken, postDetails, integration, true);
  }

  // allowPull is false for the old blocking `post`: its loop only knows a
  // publish id, not the `ready` hand-over a failed pull needs, so it always
  // uploads the file.
  private async publish(
    accessToken: string,
    postDetails: PostDetails<TikTokDto>[],
    integration: Integration,
    allowPull: boolean
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const isPhoto = !hasExtension(firstPost?.media?.[0]?.path, 'mp4');
    const videoPath = firstPost?.media?.[0]?.path!;
    const endpoint = this.postingMethod(
      this.contentPostingMethod(firstPost),
      isPhoto
    );
    const postInfo = this.buildTikokPostInfoBody(firstPost);

    // The publish is irreversible on TikTok's side once it is initialised:
    // return `pending` so the workflow polls checkPostStatus instead of
    // blocking (and possibly timing out and re-posting) inside this activity.
    const pending = (pendingData: TiktokPendingData): PostResponse[] => [
      {
        id: firstPost.id,
        releaseURL: '',
        postId: '',
        status: 'pending',
        pendingData,
      },
    ];

    // Photos only support PULL_FROM_URL (see buildTikokSourceInfoBody). A
    // video is pulled only when the channel owner opted in and the file is on
    // our media base URL; every other case is the FILE_UPLOAD below, as before.
    let pullNote = '';
    if (allowPull && this.canPull(videoPath, isPhoto, integration)) {
      try {
        const { publish_id } = await this.initPublish(accessToken, endpoint, {
          ...postInfo,
          source_info: { source: 'PULL_FROM_URL', video_url: videoPath },
        });

        return pending({
          publishId: publish_id,
          pullFallback: { endpoint, postInfo, path: videoPath },
        });
      } catch (err) {
        // TikTok refused the URL (usually the media domain is not verified in
        // the developer app): nothing was published, upload the file instead.
        const refused =
          err instanceof BadBody &&
          this.isPullFailure(String((err.details?.[0] as any)?.json || ''));
        if (!refused) {
          throw err;
        }

        pullNote = `TikTok could not fetch the video from ${mediaBaseUrl()}, so it was uploaded instead. To let TikTok fetch it: verify that domain or URL prefix in your TikTok developer app (URL properties, DNS signature recommended); the address must be HTTPS, must not redirect and must stay reachable while TikTok downloads.`;
        console.warn(
          `tiktok: pull from URL refused, falling back. ${pullNote}`
        );
      }
    }

    if (isPhoto) {
      const { publish_id } = await this.initPublish(accessToken, endpoint, {
        ...postInfo,
        ...this.buildTikokSourceInfoBody(firstPost),
      });

      return pending({ publishId: publish_id });
    }

    try {
      return pending({
        publishId: await this.startFileUpload(
          accessToken,
          endpoint,
          postInfo,
          videoPath
        ),
      });
    } catch (err) {
      // the fallback failed as well: name the missing pull step with it
      if (pullNote && err instanceof BadBody) {
        throw new BadBody(
          'tiktok-error-upload',
          String((err.details?.[0] as any)?.json || '{}'),
          Buffer.from('{}'),
          `${err.message} ${pullNote}`
        );
      }

      throw err;
    }
  }

  // Runs after checkPostStatus reported a failed pull: uploads the file in
  // place of the failed PULL_FROM_URL, behind the arm -> confirm -> run
  // handshake (see TiktokPendingData). Answers `pending` with the new publish
  // id, which no longer carries a fallback, so it can never run twice.
  override async finalizePost(
    accessToken: string,
    pendingData: TiktokPendingData,
    integration: Integration
  ): Promise<PendingCheckResponse> {
    const fallback = pendingData.pullFallback;

    // nothing left to run: keep tracking the publish
    if (!fallback) {
      return { status: 'pending', pendingData };
    }

    // arm without uploading; checkPostStatus witnesses it before we upload
    if (!fallback.attempting || !fallback.confirmed) {
      return {
        status: 'pending',
        pendingData: {
          ...pendingData,
          pullFallback: { ...fallback, attempting: true, confirmed: false },
        },
      };
    }

    console.warn(
      `tiktok: pull from URL failed for publish ${pendingData.publishId}, uploading the file instead`
    );

    try {
      const publishId = await this.startFileUpload(
        accessToken,
        fallback.endpoint,
        fallback.postInfo,
        fallback.path
      );

      return { status: 'pending', pendingData: { publishId } };
    } catch (err) {
      if (err instanceof BadBody) {
        throw new BadBody(
          'tiktok-error-upload',
          String((err.details?.[0] as any)?.json || '{}'),
          Buffer.from('{}'),
          `${err.message} TikTok could not fetch the video from ${mediaBaseUrl()} first: verify that domain or URL prefix in your TikTok developer app (URL properties, DNS signature recommended), HTTPS, no redirect.`
        );
      }

      throw err;
    }
  }

  // Old blocking behavior, kept for workflow versions before v1.0.6 that still
  // run (scheduled posts sleep inside them until publish time) and don't know
  // how to resolve a `pending` response - they keep polling inside the
  // activity exactly like before.
  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<TikTokDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [response] = await this.publish(
      accessToken,
      postDetails,
      integration,
      false
    );

    const started = Date.now();

    for (const _ of Array(27).keys()) {
      // ~9 minutes at 20s interval
      const check = await this.checkPostStatus(
        accessToken,
        response.pendingData,
        integration
      );

      if (check.status === 'completed') {
        return [
          {
            id: response.id,
            releaseURL: check.releaseURL,
            postId: String(check.postId),
            status: 'success',
          },
        ];
      }

      // Cap below the 10-minute activity timeout of the old workflows using
      // this method: failing here (non-retryable) is safe, timing the activity
      // out is not - a retried activity would publish the post again.
      if (Date.now() - started > 8 * 60 * 1000) {
        break;
      }

      await timer(20000);
    }

    throw new BadBody(
      'titok-error-upload',
      JSON.stringify({}),
      Buffer.from(JSON.stringify({})),
      'TikTok refused to publish your post'
    );
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const today = dayjs().format('YYYY-MM-DD');

    try {
      // Get user stats (follower_count, following_count, likes_count, video_count)
      const userStatsResponse = await fetch(
        'https://open.tiktokapis.com/v2/user/info/?fields=follower_count,following_count,likes_count,video_count',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const userStatsData = await userStatsResponse.json();
      const userStats = userStatsData?.data?.user;

      const result: AnalyticsData[] = [];

      if (userStats) {
        if (userStats.follower_count !== undefined) {
          result.push({
            label: 'Followers',
            percentageChange: 0,
            data: [{ total: String(userStats.follower_count), date: today }],
          });
        }

        if (userStats.following_count !== undefined) {
          result.push({
            label: 'Following',
            percentageChange: 0,
            data: [{ total: String(userStats.following_count), date: today }],
          });
        }

        if (userStats.likes_count !== undefined) {
          result.push({
            label: 'Total Likes',
            percentageChange: 0,
            data: [{ total: String(userStats.likes_count), date: today }],
          });
        }

        if (userStats.video_count !== undefined) {
          result.push({
            label: 'Videos',
            percentageChange: 0,
            data: [{ total: String(userStats.video_count), date: today }],
          });
        }
      }

      // Get recent videos and aggregate their stats
      const videoListResponse = await fetch(
        'https://open.tiktokapis.com/v2/video/list/?fields=id',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ max_count: 20 }),
        }
      );

      const videoListData = await videoListResponse.json();
      const videos = videoListData?.data?.videos;

      if (videos && videos.length > 0) {
        const videoIds = videos.map((v: { id: string }) => v.id);

        // Query video details to get engagement metrics
        const videoQueryResponse = await fetch(
          'https://open.tiktokapis.com/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              filters: { video_ids: videoIds },
            }),
          }
        );

        const videoQueryData = await videoQueryResponse.json();
        const videoDetails = videoQueryData?.data?.videos;

        if (videoDetails && videoDetails.length > 0) {
          let totalViews = 0;
          let totalLikes = 0;
          let totalComments = 0;
          let totalShares = 0;

          for (const video of videoDetails) {
            totalViews += video.view_count || 0;
            totalLikes += video.like_count || 0;
            totalComments += video.comment_count || 0;
            totalShares += video.share_count || 0;
          }

          result.push({
            label: 'Views',
            percentageChange: 0,
            data: [{ total: String(totalViews), date: today }],
          });

          result.push({
            label: 'Recent Likes',
            percentageChange: 0,
            data: [{ total: String(totalLikes), date: today }],
          });

          result.push({
            label: 'Recent Comments',
            percentageChange: 0,
            data: [{ total: String(totalComments), date: today }],
          });

          result.push({
            label: 'Recent Shares',
            percentageChange: 0,
            data: [{ total: String(totalShares), date: today }],
          });
        }
      }

      return result;
    } catch (err) {
      console.error('Error fetching TikTok analytics:', err);
      return [];
    }
  }

  async missing(
    id: string,
    accessToken: string
  ): Promise<{ id: string; url: string }[]> {
    try {
      const videoListResponse = await this.fetch(
        'https://open.tiktokapis.com/v2/video/list/?fields=id,cover_image_url,title',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ max_count: 20 }),
        }
      );

      const videoListData = await videoListResponse.json();
      const videos = videoListData?.data?.videos;

      if (!videos || videos.length === 0) {
        return [];
      }

      return videos.map((v: { id: string; cover_image_url: string }) => ({
        id: String(v.id),
        url: v.cover_image_url,
      }));
    } catch (err) {
      console.error('Error fetching TikTok missing content:', err);
      return [];
    }
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    fromDate: number
  ): Promise<AnalyticsData[]> {
    const today = dayjs().format('YYYY-MM-DD');

    if (postId.indexOf('v_pub_url') > -1) {
      const post = await (
        await fetch(
          'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              publish_id: postId,
            }),
          }
        )
      ).json();

      if (!post?.data?.publicaly_available_post_id?.[0]) {
        return [];
      }

      postId = post.data.publicaly_available_post_id[0];
    }

    try {
      // Query video details using the video ID
      const response = await fetch(
        'https://open.tiktokapis.com/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            filters: {
              video_ids: [postId],
            },
          }),
        }
      );

      const data = await response.json();
      const video = data?.data?.videos?.[0];

      if (!video) {
        return [];
      }

      const result: AnalyticsData[] = [];

      if (video.view_count !== undefined) {
        result.push({
          label: 'Views',
          percentageChange: 0,
          data: [{ total: String(video.view_count), date: today }],
        });
      }

      if (video.like_count !== undefined) {
        result.push({
          label: 'Likes',
          percentageChange: 0,
          data: [{ total: String(video.like_count), date: today }],
        });
      }

      if (video.comment_count !== undefined) {
        result.push({
          label: 'Comments',
          percentageChange: 0,
          data: [{ total: String(video.comment_count), date: today }],
        });
      }

      if (video.share_count !== undefined) {
        result.push({
          label: 'Shares',
          percentageChange: 0,
          data: [{ total: String(video.share_count), date: today }],
        });
      }

      return result;
    } catch (err) {
      console.error('Error fetching TikTok post analytics:', err);
      return [];
    }
  }
}
