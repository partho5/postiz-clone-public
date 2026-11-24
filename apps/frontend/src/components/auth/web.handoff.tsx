'use client';

// Web handoff (B2): the page the app's one-time links open. It exchanges the link's code for a web
// session, as the sign-in form does, and opens the page the link was made for.
import { FC, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  FetchWrapperComponent,
  useFetch,
} from '@gitroom/helpers/utils/custom.fetch';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import Spinner from '@gitroom/frontend/components/layout/loading';
import { keepPage } from '@gitroom/frontend/components/auth/otp/otp.sign.in';

// Whether a path stays on this site: it starts with one slash, holds no backslash and no control
// character (a browser drops tabs and newlines from a URL, so `/\t/evil` would open `//evil`), and
// resolves to this origin.
const isSameSitePath = (path: unknown): path is string => {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    [...path].some(
      (c) => c === '\\' || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f
    )
  ) {
    return false;
  }
  try {
    const { origin } = window.location;
    return new URL(path, origin).origin === origin;
  } catch {
    return false;
  }
};

// Redeems the code once and leaves for the link's page; a refused, used or expired code shows a short
// line that sends the person back to the app.
const Redeem: FC = () => {
  const fetchData = useFetch();
  const query = useSearchParams();
  const t = useT();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  // Exchanges the code for a session the first time the page renders (never twice: a code works once).
  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    const code = query?.get('code');
    // the code leaves the address bar at once; it is useless after this one try anyway
    window.history.replaceState(null, '', window.location.pathname);
    if (!code) {
      setFailed(true);
      return;
    }
    fetchData('/auth/token', {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'web_handoff', code }),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('handoff refused');
        }
        const { next } = (await response.json()) as { next?: string };
        if (!isSameSitePath(next)) {
          throw new Error('handoff refused');
        }
        // a full load, as after every sign-in, and replaced so back never returns to a used link
        window.location.replace(next);
      })
      .catch(() => setFailed(true));
  }, [fetchData, query]);

  if (failed) {
    return (
      <div className="flex flex-1 justify-center text-center text-[16px] py-[40px]">
        {t(
          'web_handoff_expired',
          'This link has expired. Go back to the app and tap again.'
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 items-center justify-center gap-[16px] py-[40px]">
      <Spinner width={40} height={40} />
      <div className="text-[14px]">
        {t('web_handoff_signing_in', 'Signing you in…')}
      </div>
    </div>
  );
};

// The /auth/continue screen, with the sign-in form's own fetch handler so a refused code stays on
// this page instead of the app-wide 401 redirect.
export const WebHandoff: FC = () => {
  const { backendUrl, isSecured } = useVariables();
  return (
    <div className="flex flex-col flex-1 text-textColor">
      <FetchWrapperComponent
        baseUrl={backendUrl}
        afterRequest={keepPage(isSecured)}
      >
        <Redeem />
      </FetchWrapperComponent>
    </div>
  );
};
