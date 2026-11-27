'use client';

// Workspace app credentials (T4): what a person sees when they try to connect a platform whose app
// keys this workspace has not entered, with the way to the App credentials tab that fixes it.
import { FC, useCallback } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useWorkspaceRouter } from '@gitroom/frontend/components/layout/workspace.navigation';

// The explanation, the missing keys and a button to the App credentials tab.
const AppCredentialsMissing: FC<{ keys: string[] }> = ({ keys }) => {
  const modals = useModals();
  const router = useWorkspaceRouter();
  const t = useT();
  return (
    <div className="flex flex-col gap-[16px] pt-[8px]">
      <p className="text-[14px] text-textColor/80">
        {t(
          'app_credentials_missing',
          'This workspace has not added the app keys for this platform yet. A workspace admin can add them on the App credentials page, then connect again.'
        )}
      </p>
      {!!keys.length && (
        <p className="text-[13px] text-textColor/60 break-all">
          {t('app_credentials_missing_keys', 'Missing')}: {keys.join(', ')}
        </p>
      )}
      <div className="flex gap-[10px]">
        <Button
          type="button"
          className="flex-1"
          onClick={() => {
            modals.closeAll();
            router.push('/settings?tab=app_credentials');
          }}
        >
          {t('open_app_credentials', 'Open App credentials')}
        </Button>
        <Button
          type="button"
          className="flex-1 !bg-transparent border border-tableBorder text-textColor"
          onClick={() => modals.closeCurrent()}
        >
          {t('cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  );
};

// Shows the explanation when a connect answer says the workspace lacks the platform's app keys
// (code APP_CREDENTIAL_MISSING); returns true when it did, so the caller stops there.
export const useAppCredentialsMissing = () => {
  const modals = useModals();
  const t = useT();
  return useCallback(
    (answer: { code?: string; keys?: string[]; key?: string } | undefined) => {
      if (answer?.code !== 'APP_CREDENTIAL_MISSING') {
        return false;
      }
      modals.openModal({
        title: t('app_keys_needed', 'App keys needed'),
        withCloseButton: true,
        children: (
          <AppCredentialsMissing
            keys={answer.keys || (answer.key ? [answer.key] : [])}
          />
        ),
      });
      return true;
    },
    [modals, t]
  );
};
