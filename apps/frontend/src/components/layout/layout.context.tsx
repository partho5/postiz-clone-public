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
// Expires the session cookies the page itself can see. Run on every sign-out, over https too: a copy
// written while the site ran without TLS outlives the server's clear (it is scoped to this host only),
// keeps the proxy treating the browser as signed in and loops it back to the app.
export function clearPageSessionCookies() {
  setCookie('auth', '', -10);
  setCookie('showorg', '', -10);
  setCookie('impersonate', '', -10);
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
      if (logout) {
        clearPageSessionCookies();
      }
      if (logout && !isSecured) {
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

      // The session probe (/user/self) refused the token itself (bad signature, session row gone): the
      // proxy still sees an auth cookie, so only the proxy's logout can end it.
      if (
        response.status === 401 ||
        (response.status === 403 && url === '/user/self') ||
        response?.headers?.get('logout')
      ) {
        clearPageSessionCookies();
        // The auth cookie is httpOnly, so the page cannot clear it and '/' would be sent straight back to
        // /launches by the proxy (which only checks the cookie exists): loop. The proxy's logout clears it.
        window.location.href = '/auth/logout';
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
    clearPageSessionCookies();
    // Same as a 401: only the proxy's logout can clear the httpOnly auth cookie, '/' would loop
    window.location.href = '/auth/logout';
  }, []);
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
