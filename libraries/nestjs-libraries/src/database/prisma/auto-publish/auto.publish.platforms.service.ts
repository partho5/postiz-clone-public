// Zero-friction auto-publish (B5, api.platforms): the list the phone's "Auto upload" screen shows:
// every provider the instance offers, in a fixed order, whether the workspace can connect it yet,
// its channels with their auto-publish switch (and, for a provider that can get a text post from a
// recording, that switch), and whether auto-publish runs automatically or with a Set. One read each of
// the channels, the app keys, the preset row and its text channels, whatever the provider count.
import { Injectable } from '@nestjs/common';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import {
  AppCredentialsService,
  canManageAppCredentials,
} from '@gitroom/nestjs-libraries/database/prisma/app-credentials/app.credentials.service';
import {
  AutoPublishMode,
  AutoPublishService,
} from '@gitroom/nestjs-libraries/database/prisma/auto-publish/auto.publish.service';
import {
  autoPublishSupported,
  platformGroup,
  textPostSupported,
  VIDEO_PLATFORMS,
} from '@gitroom/nestjs-libraries/integrations/auto.publish.defaults';
import { credentialGuideUrl } from '@gitroom/nestjs-libraries/integrations/credential.guides';

// Whether the workspace can post to a provider now ('connected'), must first enter its app keys
// ('needs_credentials'), or can start connecting it ('ready_to_connect').
export type PlatformStatus =
  | 'connected'
  | 'needs_credentials'
  | 'ready_to_connect';

// One of the workspace's channels of a provider, with its auto-publish switch.
export interface PlatformChannelView {
  id: string;
  name: string;
  picture: string | null;
  disabled: boolean;
  refreshNeeded: boolean;
  autoPublish: boolean;
  // switched on for a text post from a recording (AI captions); only a `textPost` provider can be
  textPostOn: boolean;
}

// One provider as the phone lists it.
export interface PlatformView {
  identifier: string;
  name: string;
  icon: string;
  group: 'video' | 'other';
  status: PlatformStatus;
  guideUrl: string;
  autoPublishSupported: boolean;
  // the provider can get a text post from a recording (TEXT_POST_DEFAULTS)
  textPost: boolean;
  channels: PlatformChannelView[];
}

// The answer of GET /public/v1/platforms.
export interface PlatformsView {
  canManageCredentials: boolean;
  autoPublish: { mode: AutoPublishMode; presetName?: string };
  platforms: PlatformView[];
}

// Where a provider sits in the list: the 'video' providers first in their display order, then
// every other one.
const rankOf = (identifier: string) => {
  const index = VIDEO_PLATFORMS.indexOf(identifier);
  return index === -1 ? VIDEO_PLATFORMS.length : index;
};

@Injectable()
export class AutoPublishPlatformsService {
  // Receives the provider list and the services that hold the workspace's channels, keys and preset.
  constructor(
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _appCredentialsService: AppCredentialsService,
    private _autoPublishService: AutoPublishService
  ) {}

  // Every provider that is not hidden, video ones first (VIDEO_PLATFORMS order) then the rest in the
  // provider list's order, for a member with this workspace role. A channel still being set up
  // (inBetweenSteps) is not listed and does not make its provider 'connected'.
  async list(organizationId: string, role?: string): Promise<PlatformsView> {
    const { social } = await this._integrationManager.getAllIntegrations();
    const [integrations, missing, preset, excluded, textOn] = await Promise.all([
      this._integrationService.getIntegrationsList(organizationId),
      this._appCredentialsService.missingKeysByProvider(
        organizationId,
        social.map((p) => p.identifier)
      ),
      this._autoPublishService.getPreset(organizationId),
      this._autoPublishService.getExcluded(organizationId),
      this._autoPublishService.getTextIntegrations(organizationId),
    ]);
    const frontend = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');

    const platforms = [...social]
      .sort((a, b) => rankOf(a.identifier) - rankOf(b.identifier))
      .map((provider): PlatformView => {
        const supported = autoPublishSupported(provider.identifier);
        const textPost = textPostSupported(provider.identifier);
        const channels = integrations
          .filter(
            (i) =>
              i.providerIdentifier === provider.identifier &&
              !i.deletedAt &&
              !i.inBetweenSteps
          )
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (i): PlatformChannelView => ({
              id: i.id,
              name: i.name,
              picture: i.picture || null,
              disabled: i.disabled,
              refreshNeeded: i.refreshNeeded,
              autoPublish: supported && !excluded.includes(i.id),
              textPostOn: textPost && textOn.includes(i.id),
            })
          );

        return {
          identifier: provider.identifier,
          name: provider.name.replace(/\s+/g, ' ').trim(),
          icon: `${frontend}/icons/platforms/${provider.identifier}.png`,
          group: platformGroup(provider.identifier),
          status: channels.length
            ? 'connected'
            : missing.get(provider.identifier)?.length
            ? 'needs_credentials'
            : 'ready_to_connect',
          guideUrl: credentialGuideUrl(provider.identifier),
          autoPublishSupported: supported,
          textPost,
          channels,
        };
      });

    return {
      canManageCredentials: canManageAppCredentials(role),
      autoPublish: preset
        ? { mode: 'preset', presetName: preset.setName }
        : { mode: 'automatic' },
      platforms,
    };
  }
}
