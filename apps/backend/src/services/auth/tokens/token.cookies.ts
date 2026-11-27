// Token auth: the cookies and header a browser client gets for a session.
import { Response } from 'express';
import { getCookieUrlFromDomain } from '@gitroom/helpers/subdomain/subdomain.management';
import { tokenConfig } from '@gitroom/backend/services/auth/tokens/token.config';
import { TokenPair } from '@gitroom/backend/services/auth/tokens/token.service';

// The attributes every auth cookie carries: shared across the app's subdomains, and httpOnly over https.
const cookieAttributes = () => ({
  domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
  ...(!process.env.NOT_SECURED
    ? {
        secure: true,
        httpOnly: true,
        sameSite: 'none' as const,
      }
    : {}),
});

// The path the refresh cookie is sent on: the token endpoints, under the path the browser reaches the backend at.
export const refreshCookiePath = () => {
  const backendPath = new URL(
    process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost'
  ).pathname.replace(/\/+$/, '');
  return `${backendPath}/auth/token`;
};

// Sets the access cookie (kept as long as the session can refresh, so an expired token still reaches
// the server) and the refresh cookie; without TLS the access token is also returned in the `auth` header.
export const setSessionCookies = (res: Response, pair: TokenPair) => {
  const expires = new Date(
    Date.now() + tokenConfig().refreshTtlDays * 24 * 60 * 60 * 1000
  );
  res.cookie('auth', pair.access_token, { ...cookieAttributes(), expires });
  res.cookie('refresh', pair.refresh_token, {
    ...cookieAttributes(),
    path: refreshCookiePath(),
    expires,
  });
  if (process.env.NOT_SECURED) {
    res.header('auth', pair.access_token);
  }
};

// Expires the access and refresh cookies.
export const clearSessionCookies = (res: Response) => {
  res.cookie('auth', '', {
    ...cookieAttributes(),
    expires: new Date(0),
    maxAge: -1,
  });
  res.cookie('refresh', '', {
    ...cookieAttributes(),
    path: refreshCookiePath(),
    expires: new Date(0),
    maxAge: -1,
  });
};
