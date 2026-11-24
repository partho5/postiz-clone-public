'use client';

import { ReactNode, useCallback } from 'react';
import { FetchWrapperComponent } from '@gitroom/helpers/utils/custom.fetch';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useReturnUrl } from '@gitroom/frontend/app/(app)/auth/return.url.component';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import {
  broadcastAuth,
  wipeSessionData,
} from '@gitroom/frontend/components/layout/workspace.navigation';
import { workspacePath } from '@gitroom/helpers/utils/workspace.path';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { mutateCreditBalance } from '@gitroom/frontend/components/credits/balance/use.credit.balance';
import {
  CreditRefusal,
  isCreditRefusal,
} from '@gitroom/frontend/components/credits/balance/credit.refusal';
import i18next from 'i18next';
export default function LayoutContext(params: { children: ReactNode }) {
  if (params?.children) {
    // eslint-disable-next-line react/no-children-prop
    return <LayoutContextInner children={params.children} />;
  }
  return <></>;
}
export function setCookie(cname: string, cvalue: string, exdays: number) {
  if (typeof document === 'undefined') {
    return;
  }
  const d = new Date();
  d.setTime(d.getTime() + exdays * 24 * 60 * 60 * 1000);
  const expires = 'expires=' + d.toUTCString();
  document.cookie = cname + '=' + cvalue + ';' + expires + ';path=/';
}
// Wraps the app's requests with the session handling: cookies from response headers, reload on a changed session, sign-out when the session is lost.
function LayoutContextInner(params: { children: ReactNode }) {
  const returnUrl = useReturnUrl();
  const { backendUrl, isSecured } = useVariables();
  const { openModal } = useModals();
  const afterRequest = useCallback(
    async (url: string, options: RequestInit, response: Response) => {
      if (
        typeof window !== 'undefined' &&
        (window.location.href.includes('/p/') ||
          window.location.pathname.startsWith('/provider/'))
      ) {
        return true;
      }
      const headerAuth =
        response?.headers?.get('auth') || response?.headers?.get('Auth');
      const showOrg =
        response?.headers?.get('showorg') || response?.headers?.get('Showorg');
      const impersonate =
        response?.headers?.get('impersonate') ||
        response?.headers?.get('Impersonate');
      const logout =
        response?.headers?.get('logout') || response?.headers?.get('Logout');
      if (headerAuth) {
        setCookie('auth', headerAuth, 365);
      }
      if (showOrg) {
        setCookie('showorg', showOrg, 365);
      }
      if (impersonate) {
        setCookie('impersonate', impersonate, 365);
      }
      if (response.status === 409 || response.status === 403) {
        const { code } = await response
          .clone()
          .json()
          .catch(() => ({} as { code?: string }));
        // Another tab signed in as someone else, or this tab's workspace is
        // gone: start over rather than act on what is on screen.
        if (code === 'SESSION_CHANGED' || code === 'WORKSPACE_FORBIDDEN') {
          // eslint-disable-next-line no-restricted-syntax -- bare / exit: 409 SESSION_CHANGED / 403 WORKSPACE_FORBIDDEN leave this workspace
          window.location.href = '/';
          return false;
        }
      }
      if (logout) {
        await wipeSessionData();
        broadcastAuth({ type: 'logout' });
      }
      if (logout && !isSecured) {
        setCookie('auth', '', -10);
        setCookie('showorg', '', -10);
        setCookie('impersonate', '', -10);
        // eslint-disable-next-line no-restricted-syntax -- bare / exit: logout
        window.location.href = '/';
        return true;
      }
      const reloadOrOnboarding =
        response?.headers?.get('reload') ||
        response?.headers?.get('onboarding');
      if (reloadOrOnboarding) {
        const getAndClear = returnUrl.getAndClear();
        if (getAndClear) {
          window.location.href = getAndClear;
          return true;
        }
      }
      if (response?.headers?.get('onboarding')) {
        window.location.href = workspacePath('/quick-start');
        return true;
      }

      if (response?.headers?.get('reload')) {
        window.location.reload();
        return true;
      }

      if (response.status === 401 || response?.headers?.get('logout')) {
        if (!isSecured) {
          setCookie('auth', '', -10);
          setCookie('showorg', '', -10);
          setCookie('impersonate', '', -10);
        }
        // eslint-disable-next-line no-restricted-syntax -- bare / exit: logout (401 or logout header)
        window.location.href = '/';
      }

      // A write that went through may have changed the balance (a post saved, moved or deleted, an
      // AI generation, a top-up or plan change): the header asks the server again.
      if (
        response.ok &&
        (options?.method || 'GET').toUpperCase() !== 'GET'
      ) {
        mutateCreditBalance();
      }

      if (response.status === 402) {
        const refusal = await response
          .clone()
          .json()
          .catch(() => null);
        if (isCreditRefusal(refusal)) {
          mutateCreditBalance();
          openModal({
            title: i18next.t('not_enough_credits', 'Not enough credits'),
            children: (close) => (
              <CreditRefusal refusal={refusal} onClose={close} />
            ),
          });
          return true;
        }
        if (
          await deleteDialog(
            (
              await response.json()
            ).message,
            'Move to billing',
            'Payment Required'
          )
        ) {
          window.open(workspacePath('/billing'), '_blank');
          return false;
        }
        return true;
      }
      return true;
    },
    [openModal]
  );
  // The session can no longer be refreshed: sign this tab out and every other tab with it.
  const onSessionLost = useCallback(async () => {
    await wipeSessionData();
    broadcastAuth({ type: 'logout' });
    if (!isSecured) {
      setCookie('auth', '', -10);
      setCookie('showorg', '', -10);
      setCookie('impersonate', '', -10);
    }
    // eslint-disable-next-line no-restricted-syntax -- bare / exit: logout (session lost)
    window.location.href = '/';
  }, [isSecured]);
  return (
    <FetchWrapperComponent
      baseUrl={backendUrl}
      afterRequest={afterRequest}
      onSessionLost={onSessionLost}
    >
      {params?.children || <></>}
    </FetchWrapperComponent>
  );
}
