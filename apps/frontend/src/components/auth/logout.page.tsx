'use client';

// The way out for a browser stuck with a session the app cannot use (a stale or refused token that keeps
// sending the person back to the same page): it ends the session on the server, wipes the tab's data and
// goes to /auth/logout, which clears the httpOnly auth cookie. It never calls the app's own fetch wrapper,
// so nothing it receives can send the person anywhere else.
import { FC, useEffect, useRef, useState } from 'react';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { clearPageSessionCookies } from '@gitroom/frontend/components/layout/layout.context';
import {
  broadcastAuth,
  wipeSessionData,
} from '@gitroom/frontend/components/layout/workspace.navigation';

// Signs out once on load; the sign-out never depends on the server answering.
export const LogoutPage: FC = () => {
  const { backendUrl } = useVariables();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    (async () => {
      try {
        // Needs no valid access token: it ends the session the refresh cookie belongs to and clears both cookies
        await fetch(backendUrl + '/auth/token/revoke', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        });
      } catch (err) {
        setFailed(true);
      }
      clearPageSessionCookies();
      await wipeSessionData();
      broadcastAuth({ type: 'logout' });
      // The proxy clears the httpOnly auth cookie of this site and lands on the sign-in page
      window.location.href = '/auth/logout';
    })();
  }, []);

  return (
    <div className="bg-newBgColor min-h-screen text-newTextColor flex items-center justify-center">
      <div className="text-[16px]">
        {failed ? 'Signing out on this device…' : 'Signing you out…'}
      </div>
    </div>
  );
};
