// Workspace app credentials (T4): the App credentials page's data, saving and clearing a provider's
// keys, and the workspace context provider code reads its credentials from.
import { HttpException, Injectable } from '@nestjs/common';
import {
  decryptAppCredential,
  encryptAppCredential,
} from '@gitroom/helpers/auth/app.credentials.encryption';
import { AppCredentialsRepository } from '@gitroom/nestjs-libraries/database/prisma/app-credentials/app.credentials.repository';
import {
  AppCredentialsNotSetError,
  NoWorkspaceContextError,
  workspaceStorage,
} from '@gitroom/nestjs-libraries/database/prisma/app-credentials/app.credentials.context';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { credentialGuideUrl } from '@gitroom/nestjs-libraries/integrations/credential.guides';

export const APP_CREDENTIAL_MAX_LENGTH = 4096;

// Whether a member with this workspace role may see and change the workspace's app credentials.
export const canManageAppCredentials = (role?: string): boolean =>
  role === 'ADMIN' || role === 'SUPERADMIN';

// One declared key of a provider as the page shows it; a secret's value never leaves the server.
export interface AppCredentialFieldView {
  key: string;
  label: string;
  secret: boolean;
  optional: boolean;
  set: boolean;
  value: string | null;
  usedBy: string[];
}

// One provider on the page: its keys, the redirect URL its developer app must list, its setup guide
// ('' when none), and whether every required key is set.
export interface AppCredentialsProviderView {
  identifier: string;
  name: string;
  callbackUrl: string | null;
  guideUrl: string;
  configured: boolean;
  fields: AppCredentialFieldView[];
}

@Injectable()
export class AppCredentialsService {
  constructor(
    private _appCredentialsRepository: AppCredentialsRepository,
    private _integrationManager: IntegrationManager
  ) {}

  // Runs `fn` for one workspace: inside it, `appCredential(key)` reads this workspace's keys only.
  // The stored rows are loaded once per call (never cached across calls or workspaces) and each
  // value is decrypted when it is read. Wrap a synchronous call as `async () => ...`.
  runWithWorkspace<T>(
    organizationId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    if (!organizationId) {
      throw new NoWorkspaceContextError();
    }

    // Credentials of two workspaces must never mix: a nested call for another workspace is a bug.
    const outer = workspaceStorage.getStore();
    if (outer && outer.organizationId !== organizationId) {
      throw new Error(
        'runWithWorkspace was nested inside another workspace; credentials must never mix.'
      );
    }

    let loaded: Promise<Map<string, string>> | undefined;
    const stored = () => {
      if (!loaded) {
        loaded = this.storedValues(organizationId).catch((err) => {
          loaded = undefined;
          throw err;
        });
      }
      return loaded;
    };

    return workspaceStorage.run({ organizationId, stored }, fn);
  }

  // Every provider that needs app credentials, with what this workspace has set.
  async list(organizationId: string): Promise<AppCredentialsProviderView[]> {
    const stored = await this.storedValues(organizationId);
    const providers = this._integrationManager.getAppCredentialProviders();

    return providers.map((provider) => {
      const fields = (provider.appCredentials || []).map((field) => {
        const encrypted = stored.get(field.key);
        return {
          key: field.key,
          label: field.label,
          secret: field.secret,
          optional: !!field.optional,
          set: !!encrypted,
          value:
            !field.secret && encrypted
              ? this.readable(organizationId, field.key, encrypted)
              : null,
          usedBy: providers
            .filter(
              (other) =>
                other.identifier !== provider.identifier &&
                other.appCredentials?.some((f) => f.key === field.key)
            )
            .map((other) => other.name.replace(/\n/g, ' ')),
        };
      });

      return {
        identifier: provider.identifier,
        name: provider.name.replace(/\n/g, ' '),
        callbackUrl: provider.appCallbackUrl(),
        guideUrl: credentialGuideUrl(provider.identifier),
        configured: fields.every((field) => field.optional || field.set),
        fields,
      };
    });
  }

  // Sets, replaces or (empty value) removes keys of one provider; keys it does not declare are refused.
  async save(
    organizationId: string,
    identifier: string,
    values: Record<string, unknown>
  ): Promise<void> {
    const declared = this.declaredKeys(identifier);
    const upserts: { key: string; value: string }[] = [];
    const removals: string[] = [];

    for (const [key, raw] of Object.entries(values)) {
      if (!declared.includes(key)) {
        throw new HttpException(`${key} is not a key of ${identifier}`, 400);
      }
      if (typeof raw !== 'string') {
        throw new HttpException(`${key} must be text`, 400);
      }
      const value = raw.trim();
      if (value.length > APP_CREDENTIAL_MAX_LENGTH) {
        throw new HttpException(
          `${key} is longer than ${APP_CREDENTIAL_MAX_LENGTH} characters`,
          400
        );
      }
      if (!value) {
        removals.push(key);
        continue;
      }
      upserts.push({
        key,
        value: encryptAppCredential(value, { organizationId, key }),
      });
    }

    await this._appCredentialsRepository.save(
      organizationId,
      upserts,
      removals
    );
  }

  // Removes every key of one provider (a key shared with another provider is removed for both).
  async clear(organizationId: string, identifier: string): Promise<void> {
    await this._appCredentialsRepository.save(
      organizationId,
      [],
      this.declaredKeys(identifier)
    );
  }

  // The required keys of a provider this workspace has not set; empty when it can be used.
  async missingKeys(
    organizationId: string,
    identifier: string
  ): Promise<string[]> {
    if (!this.declaresKeys(identifier)) {
      return [];
    }

    return this.missingOf(identifier, await this.storedValues(organizationId));
  }

  // missingKeys of several providers with one read of the workspace's keys: identifier → the
  // required keys not set (empty when the provider can be used).
  async missingKeysByProvider(
    organizationId: string,
    identifiers: string[]
  ): Promise<Map<string, string[]>> {
    const stored = identifiers.some((id) => this.declaresKeys(id))
      ? await this.storedValues(organizationId)
      : new Map<string, string>();
    return new Map<string, string[]>(
      identifiers.map((id) => [id, this.missingOf(id, stored)])
    );
  }

  // Refuses to start connecting a provider until this workspace has set every required key.
  async assertConfigured(
    organizationId: string,
    identifier: string
  ): Promise<void> {
    const keys = await this.missingKeys(organizationId, identifier);
    if (keys.length) {
      throw new AppCredentialsNotSetError(identifier, keys);
    }
  }

  // Whether a provider needs app credentials at all.
  private declaresKeys(identifier: string): boolean {
    return !!this._integrationManager.getSocialIntegration(identifier)
      ?.appCredentials?.length;
  }

  // The required keys of a provider that are not among the stored ones.
  private missingOf(identifier: string, stored: Map<string, string>): string[] {
    return (
      this._integrationManager.getSocialIntegration(identifier)
        ?.appCredentials || []
    )
      .filter((field) => !field.optional && !stored.get(field.key))
      .map((field) => field.key);
  }

  // The keys a provider declares; refuses an identifier that declares none.
  private declaredKeys(identifier: string): string[] {
    const keys = (
      this._integrationManager.getSocialIntegration(identifier)
        ?.appCredentials || []
    ).map((field) => field.key);
    if (!keys.length) {
      throw new HttpException('This provider has no app credentials', 404);
    }
    return keys;
  }

  // The workspace's stored (still encrypted) values by key.
  private async storedValues(
    organizationId: string
  ): Promise<Map<string, string>> {
    const rows = await this._appCredentialsRepository.list(organizationId);
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  // A non-secret value for the page; null when it cannot be decrypted (the page then asks for it again).
  private readable(organizationId: string, key: string, encrypted: string) {
    try {
      return decryptAppCredential(encrypted, { organizationId, key });
    } catch (err) {
      return null;
    }
  }
}
