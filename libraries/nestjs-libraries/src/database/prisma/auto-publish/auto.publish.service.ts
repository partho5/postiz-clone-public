// Mobile auto-publish (api.mobile-auto-publish): the phone app publishes every finished recording to
// the workspace's channels. With no Set chosen (automatic mode) every eligible channel gets the post
// with its provider's AUTO_DEFAULTS; a workspace may instead name one Set as its preset (advanced
// override). Channels the workspace switched off are skipped in both modes. This service reads that
// choice, turns it and a recording into a create-post body for the shared publish path, and reads
// post states. With an AI caption (ai.video-captions) the text of each channel is written from the
// recording's speech, and the text-only channels the workspace switched on get a text post.
import { HttpException, Injectable } from '@nestjs/common';
import { Integration } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { AutoPublishRepository } from '@gitroom/nestjs-libraries/database/prisma/auto-publish/auto.publish.repository';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PublishChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.service';
import { CreditBalanceService } from '@gitroom/nestjs-libraries/database/prisma/credits/balance/credit.balance.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import {
  AUTO_PUBLISH_TIMINGS,
  AutoPublishTiming,
} from '@gitroom/nestjs-libraries/dtos/auto-publish/auto.publish.preset.dto';
import { AutoPublishRequestDto } from '@gitroom/nestjs-libraries/dtos/auto-publish/auto.publish.request.dto';
import { workspacePath } from '@gitroom/helpers/utils/workspace.path';
import {
  autoPublishDefaults,
  autoPublishSupported,
  textPostDefaults,
  textPostSupported,
} from '@gitroom/nestjs-libraries/integrations/auto.publish.defaults';
import { AiCaptionsService } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import {
  fitText,
  titleRule,
} from '@gitroom/nestjs-libraries/integrations/post.text.limits';

dayjs.extend(utc);

// The most post ids one status request may name.
export const MAX_STATUS_IDS = 50;

// The most characters of a post's error that a status answer carries.
const MAX_ERROR_LENGTH = 1000;

// The placeholder in a Set's text that the recording's name replaces.
const TITLE_PLACEHOLDER = '{title}';

// Where a workspace picks its preset: the Sets tab of the settings page.
const SETUP_PATH = '/settings?tab=sets';

// The name a recording goes by when no AI caption names it: the name the phone sends is a file name
// (myvideo-23-9-26x9x16), never a caption, so it is not used at all.
const recordingName = () => `New video ${dayjs.utc().format('D MMM YYYY')}`;

// Whether the workspace publishes with a chosen Set ('preset') or to every eligible channel with
// default settings ('automatic').
export type AutoPublishMode = 'automatic' | 'preset';

// A channel auto-publish posts to, as the phone shows it.
export interface AutoPublishChannel {
  id: string;
  name: string;
  identifier: string;
  picture: string | null;
  disabled: boolean;
}

// The answer of GET /public/v1/auto-publish.
export interface AutoPublishInfo {
  configured: boolean;
  mode?: AutoPublishMode;
  setName?: string;
  timing?: AutoPublishTiming;
  channels: AutoPublishChannel[];
  cost: number;
  available: number;
  setupUrl: string;
}

// The state of one post, as GET /public/v1/posts/status answers it.
export interface PostStatus {
  id: string;
  state: 'QUEUE' | 'PUBLISHED' | 'ERROR' | 'DRAFT' | 'DELETED';
  publishDate: string;
  releaseURL?: string;
  error?: string;
}

// The create-post body built from a Set and a recording (the input of the shared publish path).
export interface AutoPublishPostBody {
  type: 'now' | 'schedule';
  shortLink: boolean;
  date: string;
  tags: unknown[];
  posts: Array<{
    integration: { id: string };
    settings: Record<string, unknown>;
    value: Array<{
      content: string;
      delay: number;
      image: Array<{ id: string; path: string }>;
    }>;
  }>;
}

// 409: no channel to publish to (automatic mode with no eligible channel, or a Set with no usable
// channel left).
export class AutoPublishNotConfiguredException extends HttpException {
  // Answers 409 AUTO_PUBLISH_NOT_CONFIGURED.
  constructor() {
    super(
      {
        statusCode: 409,
        code: 'AUTO_PUBLISH_NOT_CONFIGURED',
        message: 'Auto-publish is not set up for this workspace',
      },
      409
    );
  }
}

// 404: the media is not one of the workspace's.
export class AutoPublishMediaNotFoundException extends HttpException {
  // Answers 404 MEDIA_NOT_FOUND.
  constructor() {
    super(
      {
        statusCode: 404,
        code: 'MEDIA_NOT_FOUND',
        message: 'Media not found',
      },
      404
    );
  }
}

// What a saved Set holds that auto-publish reads: its channel entries, short-link choice and tags.
interface SetContent {
  shortLink: boolean;
  tags: unknown[];
  posts: SetPost[];
}

// One channel entry of a saved Set.
interface SetPost {
  integration: { id: string };
  settings: Record<string, unknown>;
  value: Array<{ content?: unknown; delay?: unknown }>;
}

// A saved Set's content as a SetContent; null when it is not the editor's post data.
const parseSetContent = (content: string): SetContent | null => {
  let raw: any;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.posts)) {
    return null;
  }
  const posts: SetPost[] = raw.posts
    .filter(
      (p: any) =>
        p &&
        typeof p.integration?.id === 'string' &&
        Array.isArray(p.value) &&
        p.value.length > 0
    )
    .map((p: any) => ({
      integration: { id: p.integration.id },
      settings:
        p.settings && typeof p.settings === 'object' ? { ...p.settings } : {},
      value: p.value,
    }));
  return {
    shortLink: raw.shortLink === true,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    posts,
  };
};

// A workspace channel as the phone shows it.
const channelOf = (
  integration: Pick<
    Integration,
    'id' | 'name' | 'providerIdentifier' | 'picture' | 'disabled'
  >
): AutoPublishChannel => ({
  id: integration.id,
  name: integration.name,
  identifier: integration.providerIdentifier,
  picture: integration.picture ?? null,
  disabled: integration.disabled,
});

// A channel's stored additionalSettings (JSON text) as the array providers' maxLength reads; [] when
// missing or not JSON.
const parseAdditionalSettings = (value: unknown): unknown[] => {
  try {
    const parsed = JSON.parse(typeof value === 'string' && value ? value : '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

@Injectable()
export class AutoPublishService {
  // Receives the preset storage and the services whose answers the preset is built from.
  constructor(
    private _autoPublishRepository: AutoPublishRepository,
    private _integrationService: IntegrationService,
    private _publishChargingService: PublishChargingService,
    private _creditBalanceService: CreditBalanceService,
    private _postsService: PostsService,
    private _mediaService: MediaService,
    private _integrationManager: IntegrationManager,
    private _aiCaptionsService: AiCaptionsService
  ) {}

  // The workspace's preset (the Set's id and name and the timing); null when no Set is chosen.
  async getPreset(organizationId: string) {
    const preset = await this._autoPublishRepository.getPreset(organizationId);
    return preset?.set
      ? {
          setId: preset.set.id,
          setName: preset.set.name,
          timing: this.timingOf(preset.timing),
        }
      : null;
  }

  // Makes one of the workspace's Sets its preset; 404 for a Set that is not the workspace's.
  async setPreset(
    organizationId: string,
    setId: string,
    timing: AutoPublishTiming = 'now'
  ) {
    const set = await this._autoPublishRepository.getSet(organizationId, setId);
    if (!set) {
      throw new HttpException(
        { statusCode: 404, code: 'SET_NOT_FOUND', message: 'Set not found' },
        404
      );
    }
    await this._autoPublishRepository.setPreset(organizationId, setId, timing);
    return this.getPreset(organizationId);
  }

  // Stops using a Set: the workspace goes back to automatic mode, its excluded channels kept.
  async clearPreset(organizationId: string) {
    await this._autoPublishRepository.clearPreset(organizationId);
    return { cleared: true };
  }

  // The ids of the workspace's channels auto-publish skips.
  getExcluded(organizationId: string) {
    return this._autoPublishRepository.getExcluded(organizationId);
  }

  // Switches auto-publish off (excluded) or back on for one of the workspace's channels; 404 for a
  // channel that is not the workspace's or is deleted.
  async setChannelExcluded(
    organizationId: string,
    integrationId: string,
    excluded: boolean
  ) {
    await this.ownChannel(organizationId, integrationId);
    await this._autoPublishRepository.setExcluded(
      organizationId,
      integrationId,
      excluded
    );
  }

  // The ids of the text-only channels the workspace switched on for a text post from a recording.
  getTextIntegrations(organizationId: string) {
    return this._autoPublishRepository.getTextIntegrations(organizationId);
  }

  // Switches the text post from a recording on or off for one of the workspace's channels and answers the
  // channels that are on; 404 for a channel that is not the workspace's or is deleted, 400 for a provider
  // that has no text post (TEXT_POST_DEFAULTS).
  async setTextChannel(
    organizationId: string,
    integrationId: string,
    enabled: boolean
  ) {
    const integration = await this.ownChannel(organizationId, integrationId);
    if (!textPostSupported(integration.providerIdentifier)) {
      throw new HttpException(
        {
          statusCode: 400,
          code: 'TEXT_POST_NOT_SUPPORTED',
          message: 'This channel cannot get a text post from a recording',
        },
        400
      );
    }
    return {
      textIntegrations: await this._autoPublishRepository.setTextIntegration(
        organizationId,
        integrationId,
        enabled
      ),
    };
  }

  // The ids of the channels automatic mode posts a text to when the recording has a caption: the text-only
  // channels the workspace switched on and that are ready to post. None with a Set, which decides itself.
  async textChannelIds(organizationId: string) {
    const loaded = await this.load(organizationId);
    return (loaded?.textChannels || []).map((c) => c.id);
  }

  // What the phone reads before it uploads: whether auto-publish has a channel to post to, the
  // channels, the cost of one publish to the usable ones and the credits available. setName is ''
  // in automatic mode (kept for older app versions, as is setupUrl). The cost also counts the text
  // channels the workspace switched on, so it is the most a publish can cost (they post only when the
  // recording has a caption).
  async info(
    organizationId: string,
    userId?: string
  ): Promise<AutoPublishInfo> {
    const { available } = await this._creditBalanceService.view(
      organizationId,
      userId ?? ''
    );
    const setupUrl = this.setupUrl(organizationId);
    const loaded = await this.load(organizationId);
    if (!loaded) {
      return { configured: false, channels: [], cost: 0, available, setupUrl };
    }
    const usable = loaded.channels.filter((c) => !c.disabled);
    const { amount } = usable.length
      ? await this._publishChargingService.preview(organizationId, {
          integrationIds: [...usable, ...loaded.textChannels].map((c) => c.id),
        })
      : { amount: 0 };
    return {
      configured: usable.length > 0,
      mode: loaded.mode,
      setName: loaded.setName,
      timing: loaded.timing,
      channels: loaded.channels,
      cost: amount,
      available,
      setupUrl,
    };
  }

  // The create-post body for one recording: the usable channels with their settings (the Set's, or
  // the provider defaults in automatic mode), the text with {title} replaced, the recording as the
  // only media, and now or the next free slot. In automatic mode the text (the recording's name) is
  // cut to each channel's provider limit, so one long name cannot fail every channel's validation.
  // With `aiCaptionId` the text is the caption's (AiCaptionsService.applyToPosts, before {title} is
  // replaced), the channels that take no video get the text without it, and the text channels the
  // workspace switched on are added when the credits pay for them. Without it nothing changes.
  // The `title` the phone sends is a file name and is never the text: without an AI caption the text is
  // 'New video {today's date}'.
  // 409 when auto-publish is not configured (or nothing is left to post), 404 when the media is not the
  // workspace's.
  async buildPostBody(
    organizationId: string,
    request: AutoPublishRequestDto
  ): Promise<AutoPublishPostBody> {
    const loaded = await this.load(organizationId);
    const usable = loaded?.channels.filter((c) => !c.disabled) || [];
    if (!loaded || !usable.length) {
      throw new AutoPublishNotConfiguredException();
    }
    const media = await this.ownMedia(organizationId, request.media.id);
    const name = recordingName();
    // A workspace without posting times has no slot to take, so next_slot publishes now.
    const scheduled =
      loaded.timing === 'next_slot' &&
      (await this._integrationService.findFreeDateTime(organizationId)).length >
        0;
    const date = scheduled
      ? await this._postsService.findFreeDateTime(organizationId)
      : dayjs.utc().format('YYYY-MM-DDTHH:mm:ss');

    const automatic = loaded.mode === 'automatic';
    const entries: AutoPublishPostBody['posts'] = loaded.content.posts
      .filter((p) => usable.some((c) => c.id === p.integration.id))
      .map((p) => ({
        integration: { id: p.integration.id },
        settings: p.settings,
        value: p.value.map((value, index) => ({
          content: String(value.content ?? ''),
          delay: typeof value.delay === 'number' ? value.delay : 0,
          image: index === 0 ? [{ id: media.id, path: media.path }] : [],
        })),
      }));

    // With an AI caption the caption writes each channel's text (where {title} is) and the text-only channels
    // the workspace switched on get a text post; a channel the caption wrote nothing for keeps today's text.
    const texts: AutoPublishPostBody['posts'] = request.aiCaptionId
      ? loaded.textChannels.map((c) => ({
          integration: { id: c.id },
          settings: textPostDefaults(c.identifier),
          value: [{ content: TITLE_PLACEHOLDER, delay: 0, image: [] }],
        }))
      : [];
    const captioned = request.aiCaptionId
      ? await this._aiCaptionsService.applyToPosts(
          organizationId,
          request.aiCaptionId,
          [...entries, ...texts],
          { placeholder: TITLE_PLACEHOLDER }
        )
      : entries;
    // A text channel posts only the text the caption wrote for it: one still holding {title} was not reached (the
    // captions service failed), and the recording's name alone is not a post.
    const textIds = texts.map((p) => p.integration.id);
    const kept = await this.affordable(
      organizationId,
      captioned.filter(
        (p) =>
          !textIds.includes(p.integration.id) ||
          p.value[0]?.content !== TITLE_PLACEHOLDER
      ),
      textIds
    );
    if (!kept.length) {
      throw new AutoPublishNotConfiguredException();
    }

    const identifiers = new Map(
      [...usable, ...loaded.textChannels].map((c): [string, string] => [
        c.id,
        c.identifier,
      ])
    );
    const posts = kept.map((p) => {
      const identifier = identifiers.get(p.integration.id)!;
      const text = automatic
        ? fitText(identifier, name, loaded.textLimits[p.integration.id])
        : name;
      return {
        integration: p.integration,
        settings: this.settingsWithTitle(identifier, p.settings, name),
        value: p.value.map((value) => ({
          ...value,
          content: value.content.split(TITLE_PLACEHOLDER).join(text),
        })),
      };
    });

    return {
      type: scheduled ? 'schedule' : 'now',
      shortLink: loaded.content.shortLink,
      date,
      tags: loaded.content.tags,
      posts,
    };
  }

  // The state of the workspace's posts with these ids (1 to 50 as received); unknown or foreign ids are omitted.
  async postStatuses(organizationId: string, ids: string[]) {
    const received = ids.filter((id) => id);
    if (received.length === 0 || received.length > MAX_STATUS_IDS) {
      throw new HttpException(
        {
          statusCode: 400,
          code: 'INVALID_IDS',
          message: `ids must name 1 to ${MAX_STATUS_IDS} posts`,
        },
        400
      );
    }
    const rows = await this._autoPublishRepository.postStatuses(
      organizationId,
      [...new Set(received)]
    );
    return rows.map((row): PostStatus => {
      const state = row.deletedAt ? 'DELETED' : row.state;
      return {
        id: row.id,
        state,
        publishDate: row.publishDate.toISOString(),
        ...(row.releaseURL ? { releaseURL: row.releaseURL } : {}),
        ...(state === 'ERROR' && row.error
          ? { error: row.error.slice(0, MAX_ERROR_LENGTH) }
          : {}),
      };
    });
  }

  // What auto-publish posts with, minus the excluded channels: the preset's Set parsed and its
  // channels looked up among the workspace's live channels; or, with no Set chosen, automatic mode:
  // every eligible channel with its provider's defaults and the recording's name as the text.
  // null when the chosen Set's content is not post data.
  private async load(organizationId: string) {
    const preset = await this._autoPublishRepository.getPreset(organizationId);
    const excluded = preset?.excludedIntegrations || [];
    const integrations = (
      await this._integrationService.getIntegrationsList(organizationId)
    ).filter((i) => !excluded.includes(i.id));

    if (!preset?.set) {
      const live = integrations.filter(
        (i) =>
          !i.disabled && !i.deletedAt && !i.refreshNeeded && !i.inBetweenSteps
      );
      const eligible = live.filter((i) =>
        autoPublishSupported(i.providerIdentifier)
      );
      // The text-only channels the workspace switched on: they post a text when the recording has a caption.
      const switchedOn = preset?.textIntegrations || [];
      const content: SetContent = {
        shortLink: false,
        tags: [],
        posts: eligible.map((i) => ({
          integration: { id: i.id },
          settings: autoPublishDefaults(i.providerIdentifier),
          value: [{ content: TITLE_PLACEHOLDER, delay: 0 }],
        })),
      };
      // Each channel's text limit, as the shared create-post validation reads it.
      const textLimits: Record<string, number | undefined> = {};
      for (const post of content.posts) {
        const integration = eligible.find((i) => i.id === post.integration.id)!;
        textLimits[integration.id] = this._integrationManager
          .getSocialIntegration(integration.providerIdentifier)
          ?.maxLength(
            parseAdditionalSettings(integration.additionalSettings),
            post.settings
          );
      }
      return {
        mode: 'automatic' as AutoPublishMode,
        setName: '',
        timing: 'now' as AutoPublishTiming,
        content,
        textLimits,
        channels: eligible.map(channelOf),
        textChannels: live
          .filter(
            (i) =>
              switchedOn.includes(i.id) && textPostSupported(i.providerIdentifier)
          )
          .map(channelOf),
      };
    }

    const parsed = parseSetContent(preset.set.content);
    if (!parsed) {
      return null;
    }
    const content: SetContent = {
      ...parsed,
      posts: parsed.posts.filter((p) => !excluded.includes(p.integration.id)),
    };
    const channels: AutoPublishChannel[] = [];
    for (const post of content.posts) {
      const integration = integrations.find(
        (i) => i.id === post.integration.id
      );
      if (integration && !channels.some((c) => c.id === integration.id)) {
        channels.push(channelOf(integration));
      }
    }
    return {
      mode: 'preset' as AutoPublishMode,
      setName: preset.set.name,
      timing: this.timingOf(preset.timing),
      content,
      // A Set's text is the workspace's own: it is never cut.
      textLimits: {} as Record<string, number | undefined>,
      channels,
      // The Set decides its channels: no text channel is added to it.
      textChannels: [] as AutoPublishChannel[],
    };
  }

  // The workspace's channel with this id (404 for another workspace's or a deleted one).
  private async ownChannel(organizationId: string, integrationId: string) {
    const integration = await this._integrationService.getIntegrationById(
      organizationId,
      integrationId
    );
    if (!integration || integration.deletedAt) {
      throw new HttpException(
        {
          statusCode: 404,
          code: 'CHANNEL_NOT_FOUND',
          message: 'Channel not found',
        },
        404
      );
    }
    return integration;
  }

  // The workspace's media with this id (404 for another workspace's or a deleted one).
  private async ownMedia(organizationId: string, id: string) {
    try {
      return await this._mediaService.getMediaStatus(organizationId, id);
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 404) {
        throw new AutoPublishMediaNotFoundException();
      }
      throw err;
    }
  }

  // The posts without the extra ones (the text channels switched on, by id) that the workspace's credits cannot
  // pay for on top of the others, so the recording still goes out to its own channels instead of the whole
  // request being refused for lack of credits. A publish costs the same on every channel, so the last extra
  // posts are left out first.
  private async affordable<P extends { integration: { id: string } }>(
    organizationId: string,
    posts: P[],
    extraIds: string[]
  ) {
    const extra = posts.filter((p) => extraIds.includes(p.integration.id));
    if (!extra.length) {
      return posts;
    }
    const [{ amount }, { available }] = await Promise.all([
      this._publishChargingService.preview(organizationId, {
        integrationIds: posts.map((p) => p.integration.id),
      }),
      this._creditBalanceService.view(organizationId, ''),
    ]);
    if (amount <= available) {
      return posts;
    }
    // how many channels the credits pay for, the others' first
    const paid = Math.floor(available / (amount / posts.length));
    const dropped = extra.slice(
      Math.max(0, paid - (posts.length - extra.length))
    );
    return posts.filter((p) => !dropped.includes(p));
  }

  // The channel's settings with its `title` filled by the recording's name when the channel's
  // settings class has a title and the Set left it empty; cut to the class's length limit. In
  private settingsWithTitle(
    identifier: string,
    settings: Record<string, unknown>,
    title: string
  ) {
    const rule = titleRule(identifier);
    const current = settings.title;
    if (!rule || (typeof current === 'string' && current.trim())) {
      return settings;
    }
    return {
      ...settings,
      title: rule.max ? title.slice(0, rule.max) : title,
    };
  }

  // The stored timing when it is a known one, else 'now'.
  private timingOf(value: string): AutoPublishTiming {
    return (AUTO_PUBLISH_TIMINGS as readonly string[]).includes(value)
      ? (value as AutoPublishTiming)
      : 'now';
  }

  // The web page where the workspace picks its preset, with the /w/<id> prefix.
  private setupUrl(organizationId: string) {
    const base = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
    return `${base}${workspacePath(SETUP_PATH, organizationId)}`;
  }
}
