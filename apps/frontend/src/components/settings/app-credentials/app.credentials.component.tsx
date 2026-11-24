'use client';

// Workspace app credentials (T4): the Settings "App credentials" card. Each workspace enters the
// keys of its own developer app per platform; saved secrets are never shown again, only "Saved".
import {
  FC,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import copy from 'copy-to-clipboard';
import { useSearchParams } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  AppCredentialsLoadError,
  AppCredentialsProvider,
  useAppCredentials,
} from '@gitroom/frontend/components/settings/app-credentials/use.app.credentials';

// The form values a provider starts with: a non-secret's saved value, a secret empty (typing replaces it).
const initialValues = (provider: AppCredentialsProvider) =>
  provider.fields.reduce(
    (all, field) => ({
      ...all,
      [field.key]: field.secret ? '' : field.value || '',
    }),
    {} as Record<string, string>
  );

// Enter must not submit the settings form this card sits in.
const stopEnter = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key === 'Enter') {
    event.preventDefault();
  }
};

// One platform: its callback URL, its keys, and saving or clearing them.
const AppCredentialsProviderForm: FC<{
  provider: AppCredentialsProvider;
  onChanged: () => void;
}> = ({ provider, onChanged }) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const t = useT();
  const [values, setValues] = useState(() => initialValues(provider));
  const [busy, setBusy] = useState(false);

  // Only what changed is sent: a typed secret, or a non-secret that differs from the saved one.
  const changed = provider.fields.reduce((all, field) => {
    const value = (values[field.key] || '').trim();
    if (field.secret ? !!value : value !== (field.value || '')) {
      all[field.key] = value;
    }
    return all;
  }, {} as Record<string, string>);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch(
        `/app-credentials/${encodeURIComponent(provider.identifier)}`,
        { method: 'PUT', body: JSON.stringify({ values: changed }) }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        toaster.show(
          body?.message ||
            t('failed_to_save_app_credentials', 'Failed to save the keys'),
          'warning'
        );
        return;
      }
      toaster.show(t('app_credentials_saved', 'Keys saved'), 'success');
      setValues((current) =>
        provider.fields.reduce(
          (all, field) => ({
            ...all,
            [field.key]: field.secret ? '' : current[field.key] || '',
          }),
          {} as Record<string, string>
        )
      );
      onChanged();
    } catch {
      toaster.show(
        t('failed_to_save_app_credentials', 'Failed to save the keys'),
        'warning'
      );
    } finally {
      setBusy(false);
    }
  }, [changed, fetch, onChanged, provider, t, toaster]);

  const clear = useCallback(async () => {
    if (
      !(await deleteDialog(
        t(
          'are_you_sure_clear_app_credentials',
          'Remove every key of this platform from this workspace? Its channels stop working until keys are entered again and the channels are reconnected.'
        ),
        t('yes_remove', 'Yes, remove')
      ))
    ) {
      return;
    }
    try {
      const response = await fetch(
        `/app-credentials/${encodeURIComponent(provider.identifier)}`,
        { method: 'DELETE' }
      );
      if (!response.ok) {
        toaster.show(
          t('failed_to_clear_app_credentials', 'Failed to remove the keys'),
          'warning'
        );
        return;
      }
      toaster.show(t('app_credentials_removed', 'Keys removed'), 'success');
      setValues(
        provider.fields.reduce(
          (all, field) => ({ ...all, [field.key]: '' }),
          {} as Record<string, string>
        )
      );
      onChanged();
    } catch {
      toaster.show(
        t('failed_to_clear_app_credentials', 'Failed to remove the keys'),
        'warning'
      );
    }
  }, [fetch, onChanged, provider, t, toaster]);

  return (
    <div className="flex flex-col gap-[12px] pt-[12px]">
      {!!provider.guideUrl && (
        <a
          href={provider.guideUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start text-[13px] font-[600] text-blue-500 hover:underline"
        >
          {t('app_credentials_guide', 'Step-by-step guide')} ↗
        </a>
      )}
      {!!provider.callbackUrl && (
        <div className="flex flex-col gap-[6px]">
          <div className="text-[13px] font-[600]">
            {t('app_credentials_callback_url', 'Callback / redirect URL')}
          </div>
          <div className="flex gap-[8px] items-center">
            <div className="flex-1 bg-newBgColorInner border border-newBorder rounded-[8px] px-[12px] py-[10px] text-[12px] break-all">
              {provider.callbackUrl}
            </div>
            <Button
              secondary
              onClick={() => {
                copy(provider.callbackUrl!);
                toaster.show(t('copied', 'Copied to clipboard'), 'success');
              }}
            >
              {t('copy', 'Copy')}
            </Button>
          </div>
          <div className="text-[12px] text-textItemBlur">
            {t(
              'app_credentials_callback_hint',
              'Add this exact URL to the allowed redirect URLs of your app on the platform.'
            )}
          </div>
        </div>
      )}

      {provider.fields.map((field) => (
        <div key={field.key} className="flex flex-col gap-[4px]">
          <div className="flex items-center gap-[8px] text-[13px]">
            <span className="font-[600]">{field.label}</span>
            <span className="text-textItemBlur text-[12px]">{field.key}</span>
            {field.optional && (
              <span className="text-textItemBlur text-[12px]">
                {t('optional', 'Optional')}
              </span>
            )}
            {field.secret && field.set && (
              <span className="text-[12px] text-green-500">
                {t('saved', 'Saved')}
              </span>
            )}
          </div>
          <Input
            label=""
            name={`app_credential_${field.key}`}
            disableForm
            removeError
            autoComplete="off"
            type={field.secret ? 'password' : 'text'}
            value={values[field.key] || ''}
            maxLength={4096}
            placeholder={
              field.secret && field.set
                ? t(
                    'app_credentials_replace_secret',
                    'Saved. Type a new value to replace it'
                  )
                : ''
            }
            onKeyDown={stopEnter}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [field.key]: event.target.value,
              }))
            }
          />
          {!!field.usedBy.length && (
            <div className="text-[12px] text-textItemBlur">
              {t('app_credentials_shared_with', 'Also used by')}{' '}
              {field.usedBy.join(', ')}
            </div>
          )}
        </div>
      ))}

      <div className="flex gap-[8px]">
        <Button
          loading={busy}
          disabled={!Object.keys(changed).length}
          onClick={save}
        >
          {t('save', 'Save')}
        </Button>
        {provider.fields.some((field) => field.set) && (
          <Button secondary onClick={clear}>
            {t('app_credentials_remove_all', 'Remove keys')}
          </Button>
        )}
      </div>
    </div>
  );
};

// The card: a warning, then every platform that needs app credentials, each opening its form.
// `?provider=<identifier>` (the link the mobile app gives) opens that platform and scrolls to it.
export const AppCredentialsComponent: FC = () => {
  const t = useT();
  const url = useSearchParams();
  const { data: providers, error, mutate } = useAppCredentials();
  const [open, setOpen] = useState(() => url.get('provider') || '');
  const linked = useRef<HTMLDivElement | null>(null);
  const changed = useCallback(() => {
    mutate();
  }, [mutate]);

  // Scrolls once to the linked platform when the list first arrives.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!providers || !linked.current || scrolled.current) {
      return;
    }
    scrolled.current = true;
    linked.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [providers]);

  if (error) {
    return (
      <div className="rounded-[12px] border border-newBorder p-[20px] text-[13px] text-textItemBlur">
        {error instanceof AppCredentialsLoadError && error.status === 403
          ? t(
              'app_credentials_admin_only',
              'Only workspace admins can add app keys. Ask your workspace owner to add them.'
            )
          : t(
              'failed_to_load_app_credentials',
              'Failed to load the app credentials'
            )}
      </div>
    );
  }

  if (providers === undefined) {
    return null;
  }

  return (
    <div className="rounded-[12px] border border-newBorder overflow-hidden">
      <div className="px-[20px] py-[14px] border-b border-newBorder">
        <div className="text-[15px] font-[600]">
          {t('app_credentials', 'App credentials')}
        </div>
        <div className="text-[13px] text-textItemBlur mt-[2px]">
          {t(
            'app_credentials_description',
            'This workspace publishes through its own developer app on each platform. A platform without its keys here cannot be connected or used in this workspace.'
          )}
        </div>
      </div>
      <div className="p-[20px] flex flex-col gap-[12px]">
        <div className="border border-newBorder rounded-[8px] p-[12px] text-[13px] font-[600]">
          {t(
            'app_credentials_reconnect_warning',
            "Changing or removing a platform's keys requires reconnecting that platform's channels in this workspace."
          )}
        </div>
        {providers.map((provider) => (
          <div
            key={provider.identifier}
            ref={
              provider.identifier === url.get('provider') ? linked : undefined
            }
            className="border border-newBorder rounded-[8px] p-[12px]"
          >
            <div
              className="flex items-center gap-[12px] cursor-pointer"
              onClick={() =>
                setOpen((current) =>
                  current === provider.identifier ? '' : provider.identifier
                )
              }
            >
              <img
                className="w-[28px] h-[28px] rounded-full"
                src={`/icons/platforms/${provider.identifier}.png`}
                alt={provider.name}
              />
              <div className="flex-1 text-[14px] font-[600]">
                {provider.name}
              </div>
              <div
                className={clsx(
                  'text-[12px]',
                  provider.configured ? 'text-green-500' : 'text-textItemBlur'
                )}
              >
                {provider.configured
                  ? t('app_credentials_configured', 'Configured')
                  : t('app_credentials_not_configured', 'Not configured')}
              </div>
            </div>
            {open === provider.identifier && (
              <AppCredentialsProviderForm
                provider={provider}
                onChanged={changed}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
