'use client';

// Scoped API keys: the Settings "API keys" card, creating a key (shown once), listing the
// workspace's keys and revoking one.
import { FC, useCallback, useState } from 'react';
import copy from 'copy-to-clipboard';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useIdempotencyKey } from '@gitroom/frontend/components/layout/use.idempotency.key';
import {
  API_SCOPES,
  ApiScope,
} from '@gitroom/nestjs-libraries/dtos/api-keys/api.scopes';
import {
  ApiKeyItem,
  ApiKeysLoadError,
  useApiKeys,
} from '@gitroom/frontend/components/settings/api-keys/use.api.keys';

// What each scope lets a key do, in the words the create form shows next to it.
const scopeLabels: Record<ApiScope, [string, string]> = {
  'posts:read': ['scope_posts_read', 'Read posts'],
  'posts:write': ['scope_posts_write', 'Create, change and delete posts'],
  'media:write': ['scope_media_write', 'Upload media'],
  'channels:read': ['scope_channels_read', 'See connected channels'],
  'channels:write': ['scope_channels_write', 'Disconnect channels and start connects'],
  'ai:use': ['scope_ai_use', 'Generate videos and clips (uses credits)'],
  'account:read': ['scope_account_read', 'Read notifications and account details'],
};

// The scopes a key holds as one line, "All scopes" when it holds every one.
const scopeSummary = (scopes: ApiScope[], all: string) =>
  scopes.length === API_SCOPES.length ? all : scopes.join(', ');

// The card: a form to make a key, the key just made (once), and the workspace's keys.
export const ApiKeysComponent: FC<{
  createdKey: string;
  onCreated: (key: string) => void;
}> = ({ createdKey, onCreated }) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const t = useT();
  const idempotency = useIdempotencyKey();
  const { frontEndUrl } = useVariables();
  const { data: keys, error, mutate } = useApiKeys();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [busy, setBusy] = useState(false);

  // Adds or removes a scope from the form.
  const toggle = useCallback(
    (scope: ApiScope) => () =>
      setScopes((held) =>
        held.includes(scope) ? held.filter((s) => s !== scope) : [...held, scope]
      ),
    []
  );

  // Selects every scope, or none when every scope is already selected.
  const toggleAll = useCallback(
    () =>
      setScopes((held) =>
        held.length === API_SCOPES.length ? [] : [...API_SCOPES]
      ),
    []
  );

  // Creates the key from the form and keeps its secret for the page to show once.
  const create = useCallback(async () => {
    setBusy(true);
    try {
      const intent = JSON.stringify({ name: name.trim(), scopes: [...scopes].sort() });
      const response = await fetch('/workspace-keys', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotency.key(intent) },
        body: JSON.stringify({ name: name.trim(), scopes }),
      });
      if (response.status < 500) {
        idempotency.reset();
      }
      if (response.status === 409) {
        toaster.show(
          t(
            'api_key_may_exist',
            'This key may already have been created. Check the list below and revoke any key you did not get to copy.'
          ),
          'warning'
        );
        mutate();
        return;
      }
      if (!response.ok) {
        toaster.show(
          t('failed_to_create_api_key', 'Failed to create the API key'),
          'warning'
        );
        return;
      }
      const created = await response.json();
      onCreated(created.key);
      setName('');
      setScopes([]);
      mutate();
    } catch {
      toaster.show(
        t('failed_to_create_api_key', 'Failed to create the API key'),
        'warning'
      );
    } finally {
      setBusy(false);
    }
  }, [fetch, idempotency, mutate, name, onCreated, scopes, t, toaster]);

  // Revokes one key after confirmation; anything still using it stops working on its next request.
  const revoke = useCallback(
    (key: ApiKeyItem) => async () => {
      if (
        await deleteDialog(
          t(
            'are_you_sure_revoke_api_key',
            'Are you sure you want to revoke this key? Anything using it stops working.'
          ),
          t('yes_revoke', 'Yes, revoke')
        )
      ) {
        try {
          const response = await fetch(`/workspace-keys/${key.id}`, {
            method: 'DELETE',
          });
          if (!response.ok) {
            toaster.show(
              t('failed_to_revoke_api_key', 'Failed to revoke the API key'),
              'warning'
            );
            return;
          }
          toaster.show(t('api_key_revoked', 'API key revoked'), 'success');
          mutate();
        } catch {
          toaster.show(
            t('failed_to_revoke_api_key', 'Failed to revoke the API key'),
            'warning'
          );
        }
      }
    },
    [fetch, mutate, t, toaster]
  );

  if (error) {
    return (
      <div className="bg-newBgColorInnerInner rounded-[12px] border border-newBorder p-[20px] text-[13px] text-customColor18">
        {error instanceof ApiKeysLoadError && error.status === 403
          ? t(
              'api_keys_admin_only',
              'Only workspace admins can manage API keys.'
            )
          : t('failed_to_load_api_keys', 'Failed to load the API keys')}
      </div>
    );
  }

  if (keys === undefined) {
    return null;
  }

  return (
    <div className="bg-newBgColorInnerInner rounded-[12px] border border-newBorder overflow-hidden">
      <div className="bg-newBgColorInner px-[20px] py-[14px] border-b border-newBorder flex items-start justify-between gap-[12px]">
        <div>
          <div className="text-[15px] font-[600]">
            {t('api_keys', 'API keys')}
          </div>
          <div className="text-[13px] text-customColor18 mt-[2px]">
            {t(
              'api_keys_description',
              'A key works only in this workspace and only for the scopes you give it.'
            )}
          </div>
        </div>
        <div className="flex gap-[6px] shrink-0 pt-[2px]">
          <Button
            secondary
            data-tooltip-id="tooltip"
            data-tooltip-content={t(
              'payload_wizard_description',
              'Building a POST request to /posts can be complex. Use the wizard to schedule a post with the UI, then copy the generated payload.'
            )}
            onClick={() => window.open(`${frontEndUrl}/modal/dark/all`, '_blank')}
          >
            {t('open_wizard', 'Open Wizard')}
          </Button>
        </div>
      </div>
      <div className="p-[20px] flex flex-col gap-[16px]">
        {!!createdKey && (
          <div className="flex flex-col gap-[8px] border border-newBorder rounded-[8px] p-[12px]">
            <div className="text-[13px] font-[600]">
              {t(
                'copy_your_api_key_now',
                'Copy your new key now. It is shown only once and cannot be recovered.'
              )}
            </div>
            <pre className="bg-newBgColorInner border border-newBorder rounded-[8px] p-[12px] text-[12px] whitespace-pre-wrap break-all leading-[1.5]">
              {createdKey}
            </pre>
            <div className="flex gap-[8px]">
              <Button
                onClick={() => {
                  copy(createdKey);
                  toaster.show(t('copied', 'Copied to clipboard'), 'success');
                }}
              >
                {t('copy', 'Copy')}
              </Button>
              <Button secondary onClick={() => onCreated('')}>
                {t('hide_key', 'Hide the key')}
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-[10px]">
          <div className="text-[14px] font-[600]">
            {t('create_api_key', 'Create a key')}
          </div>
          <Input
            label=""
            name="api_key_name"
            disableForm
            removeError
            value={name}
            maxLength={60}
            placeholder={t('api_key_name', 'Key name, for example "Zapier"')}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex flex-col gap-[8px]">
            <Checkbox
              disableForm
              checked={scopes.length === API_SCOPES.length}
              onChange={toggleAll}
              label={`${t('all_scopes', 'All scopes')} ${t(
                'all_scopes_mcp_note',
                '(needed for MCP)'
              )}`}
            />
            {API_SCOPES.map((scope) => (
              <Checkbox
                key={scope}
                disableForm
                checked={scopes.includes(scope)}
                onChange={toggle(scope)}
                label={`${scope}: ${t(scopeLabels[scope][0], scopeLabels[scope][1])}`}
              />
            ))}
          </div>
          <div>
            <Button
              loading={busy}
              disabled={!name.trim() || !scopes.length}
              onClick={create}
            >
              {t('create_key', 'Create key')}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-[10px]">
          {keys.length === 0 && (
            <div className="text-customColor18 text-[13px]">
              {t('no_api_keys_yet', 'No API keys yet.')}
            </div>
          )}
          {keys.map((key) => (
            <div
              key={key.id}
              className="flex items-center justify-between p-[12px] border border-newBorder rounded-[8px]"
            >
              <div>
                <div className="text-[14px] font-bold">
                  {key.name}
                  {!!key.revokedAt && (
                    <span className="ms-[8px] text-[12px] text-customColor18 font-normal">
                      {t('revoked', 'Revoked')}
                    </span>
                  )}
                </div>
                <div className="text-customColor18 text-[12px]">
                  {scopeSummary(key.scopes, t('all_scopes', 'All scopes'))}
                </div>
                <div className="text-customColor18 text-[12px]">
                  {t('created', 'Created')}{' '}
                  {new Date(key.createdAt).toLocaleString()}
                  {' · '}
                  {key.lastUsedAt
                    ? `${t('last_used', 'Last used')} ${new Date(
                        key.lastUsedAt
                      ).toLocaleString()}`
                    : t('never_used', 'Never used')}
                </div>
              </div>
              {!key.revokedAt && (
                <Button onClick={revoke(key)}>{t('revoke', 'Revoke')}</Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
