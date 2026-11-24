// Web handoff (B2): a one-time link that opens a web page already signed in as the app's user, so the
// app never sends its user to a login page.
import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { workspacePath } from '@gitroom/helpers/utils/workspace.path';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { AccountsService } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.service';
import { AiCaptionsRepository } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.repository';
import { DeviceSessionsRepository } from '@gitroom/nestjs-libraries/database/prisma/device-sessions/device.sessions.repository';
import {
  WebHandoffGrant,
  WebHandoffRepository,
} from '@gitroom/nestjs-libraries/database/prisma/web-handoff/web.handoff.repository';
import { WebLinkTarget } from '@gitroom/nestjs-libraries/dtos/web-handoff/web.link.request.dto';

// How long a link works, and the random bytes of its code (43 base64url characters).
const TTL_SECONDS = 60;
const CODE_BYTES = 32;
const CODE_FORMAT = /^[A-Za-z0-9_-]{43}$/;

// The page each target opens, before the workspace prefix; the identifier is a provider, a tier key for
// the plans page, or a caption id; the content plan page takes none.
const TARGET_PATHS: Record<WebLinkTarget, (identifier: string) => string> = {
  credentials: (identifier) =>
    `/settings?tab=app_credentials&provider=${encodeURIComponent(identifier)}`,
  connect: (identifier) =>
    `/launches?connect=${encodeURIComponent(identifier)}`,
  billing: (identifier) => `/billing?tier=${encodeURIComponent(identifier)}`,
  'ai-caption': (identifier) =>
    `/ai-captions?open=${encodeURIComponent(identifier)}`,
  'content-plan': () => '/plan',
};

// The SHA-256 of a code as lowercase hex; the only form in which one is stored.
const hashOf = (code: string) =>
  createHash('sha256').update(code).digest('hex');

// Whether a path stays on this site: it starts with one slash and holds no backslash and no control
// character (a browser drops tabs and newlines from a URL, so `/\t/evil` would open `//evil`).
const isSameSitePath = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.startsWith('/') &&
  !path.startsWith('//') &&
  ![...path].some(
    (c) => c === '\\' || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f
  );

// What a redeemed link signs in: the user, the page to open and the name of the web session.
export interface RedeemedWebHandoff {
  userId: string;
  next: string;
  sessionName: string;
}

// Creates the one-time links the app opens on the web and redeems them once.
@Injectable()
export class WebHandoffService {
  // Receives the link store, the provider list, the device sessions the asking device is named from, the
  // accounts that decide whose plans page opens and the captions whose ownership a caption link checks.
  constructor(
    private _webHandoffRepository: WebHandoffRepository,
    private _integrationManager: IntegrationManager,
    private _deviceSessionsRepository: DeviceSessionsRepository,
    private _accountsService: AccountsService,
    private _aiCaptionsRepository: AiCaptionsRepository
  ) {}

  // A link valid for one use within 60 seconds that signs the user in on the web, in this workspace,
  // on the target's page for the provider (a hidden provider is a 400), for a caption of the workspace
  // (another workspace's, or a deleted one, is a 404 CAPTION_NOT_FOUND), or for the plans page, on the
  // tier, in a workspace whose account the user owns (none is a 403 NOT_ACCOUNT_OWNER).
  async createLink(
    userId: string,
    organizationId: string,
    sessionId: string | undefined,
    target: WebLinkTarget,
    identifier: string
  ): Promise<{ url: string }> {
    if (target === 'ai-caption') {
      await this.requireCaption(organizationId, identifier);
    } else if (
      target !== 'billing' &&
      target !== 'content-plan' &&
      this._integrationManager.isHiddenProvider(identifier)
    ) {
      throw new BadRequestException({ msg: 'Unknown provider' });
    }
    const workspaceId =
      target === 'billing'
        ? await this.ownedWorkspace(userId, organizationId)
        : organizationId;
    const session = sessionId
      ? await this._deviceSessionsRepository.findById(sessionId)
      : null;
    const grant: WebHandoffGrant = {
      userId,
      organizationId: workspaceId,
      next: workspacePath(TARGET_PATHS[target](identifier), workspaceId),
      deviceName: session?.name || null,
    };
    const code = randomBytes(CODE_BYTES).toString('base64url');
    await this._webHandoffRepository.save(hashOf(code), grant, TTL_SECONDS);
    const base = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
    return { url: `${base}/auth/continue?code=${code}` };
  }

  // Uses the link's code: what it signs in, or null when it is malformed, expired, already used or
  // names a page off this site.
  async redeem(code: string): Promise<RedeemedWebHandoff | null> {
    if (!CODE_FORMAT.test(code)) {
      return null;
    }
    const grant = await this._webHandoffRepository.take(hashOf(code));
    if (
      !grant ||
      typeof grant.userId !== 'string' ||
      !isSameSitePath(grant.next)
    ) {
      return null;
    }
    return {
      userId: grant.userId,
      next: grant.next,
      sessionName: grant.deviceName
        ? `Web browser (from ${grant.deviceName})`
        : 'Web browser (from the app)',
    };
  }

  // The caption's page opens only for a live caption of the workspace; any other id, another workspace's included,
  // is a 404 CAPTION_NOT_FOUND (the answer of the caption routes).
  private async requireCaption(organizationId: string, id: string) {
    if (!(await this._aiCaptionsRepository.getCaption(organizationId, id))) {
      throw new HttpException(
        {
          statusCode: 404,
          code: 'CAPTION_NOT_FOUND',
          message: 'Caption not found',
        },
        404
      );
    }
  }

  // The workspace whose plans page the user can use: the active one when they own its account, else the
  // oldest workspace they are an active member of whose account they own. Only the owner manages the plan.
  private async ownedWorkspace(userId: string, organizationId: string) {
    const account = await this._accountsService.getAccountById(
      await this._accountsService.getAccountIdForOrganization(organizationId)
    );
    if (account?.ownerId === userId) {
      return organizationId;
    }
    const owned = await this._accountsService.getOwnedOrganization(userId);
    if (!owned) {
      throw new HttpException(
        {
          statusCode: 403,
          code: 'NOT_ACCOUNT_OWNER',
          message: 'Only the account owner can manage the plan',
        },
        403
      );
    }
    return owned.id;
  }
}
