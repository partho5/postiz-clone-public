// Workspace app credentials (T4): the workspace a piece of provider code runs for, and the one way
// provider code reads an app credential. There is no fallback to .env and no guessing: no workspace
// in context throws, a key the workspace has not set throws.
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpException } from '@nestjs/common';
import { decryptAppCredential } from '@gitroom/helpers/auth/app.credentials.encryption';

// What `AppCredentialsService.runWithWorkspace` puts in context: the workspace and a loader of its
// stored (encrypted) values, memoized for this context only (never shared between workspaces).
export interface WorkspaceContext {
  organizationId: string;
  stored: () => Promise<Map<string, string>>;
}

export const workspaceStorage = new AsyncLocalStorage<WorkspaceContext>();

// Provider code ran outside `runWithWorkspace`: a bug in the entry point, never a user error.
export class NoWorkspaceContextError extends Error {
  constructor() {
    super(
      'No workspace in context: wrap the call in AppCredentialsService.runWithWorkspace(orgId, fn).'
    );
    this.name = 'NoWorkspaceContextError';
  }
}

// The workspace has not entered this key on the App credentials page; the provider is unavailable
// for it. Answers 400 APP_CREDENTIAL_MISSING over HTTP.
export class MissingAppCredentialError extends HttpException {
  constructor(public readonly key: string) {
    super(
      {
        statusCode: 400,
        code: 'APP_CREDENTIAL_MISSING',
        key,
        message: `${key} is not set for this workspace. Add it on Settings > App credentials.`,
      },
      400
    );
    this.name = 'MissingAppCredentialError';
  }
}

// A connect was started for a provider whose required keys the workspace has not all set; refused
// before any OAuth starts. Answers 400 APP_CREDENTIAL_MISSING with every missing key.
export class AppCredentialsNotSetError extends HttpException {
  constructor(
    public readonly identifier: string,
    public readonly keys: string[]
  ) {
    super(
      {
        statusCode: 400,
        code: 'APP_CREDENTIAL_MISSING',
        identifier,
        keys,
        message: `Add this provider's app keys (${keys.join(
          ', '
        )}) on Settings > App credentials before connecting it.`,
      },
      400
    );
    this.name = 'AppCredentialsNotSetError';
  }
}

// The current workspace context; throws when there is none.
const currentContext = (): WorkspaceContext => {
  const context = workspaceStorage.getStore();
  if (!context?.organizationId) {
    throw new NoWorkspaceContextError();
  }
  return context;
};

// The id of the workspace the current code runs for; throws when there is none.
export const currentWorkspaceId = (): string => currentContext().organizationId;

// The current workspace's decrypted value for a key, or undefined when it has none.
const read = async (key: string): Promise<string | undefined> => {
  const context = currentContext();
  const encrypted = (await context.stored()).get(key);
  if (!encrypted) {
    return undefined;
  }
  return (
    decryptAppCredential(encrypted, {
      organizationId: context.organizationId,
      key,
    }) || undefined
  );
};

// The current workspace's value for an app credential key (the old .env name, e.g. X_API_KEY).
export const appCredential = async (key: string): Promise<string> => {
  const value = await read(key);
  if (!value) {
    throw new MissingAppCredentialError(key);
  }
  return value;
};

// The current workspace's value for an optional key (declared `optional: true`), or undefined;
// the caller applies the provider's built-in default, never an .env value.
export const optionalAppCredential = (
  key: string
): Promise<string | undefined> => read(key);
