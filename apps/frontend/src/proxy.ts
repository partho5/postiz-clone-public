import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getCookieUrlFromDomain } from '@gitroom/helpers/subdomain/subdomain.management';
import { internalFetch } from '@gitroom/helpers/utils/internal.fetch';
import acceptLanguage from 'accept-language';
import { splitWorkspacePath } from '@gitroom/helpers/utils/workspace.path';
import {
  cookieName,
  headerName,
  languages,
} from '@gitroom/react/translation/i18n.config';
acceptLanguage.languages(languages);

// Legal pages answer every visitor, signed in or not, and belong to no workspace
const LEGAL_PATHS = ['/terms', '/privacy', '/data-deletion'];

// The page the app's one-time web sign-in links open (web handoff, B2)
const WEB_HANDOFF_PATH = '/auth/continue';

// The way out for a browser stuck with a session the app cannot use; it must answer whatever the cookies are.
// GET opens the page that ends the session; POST ends it here and goes to the sign-in page.
const LOGOUT_PATH = '/logout';

// Pages a signed-out visitor returns to, query string included, after signing in (the app's upgrade link
// opens /billing?tier=<KEY>, signed in or not)
const RETURN_PATHS = ['/billing'];

// Every super admin page lives under this prefix; only a request for it pays for the super admin check
const SUPER_ADMIN_PATH = '/super-admin';

// Whether a path is inside the super admin area, however it is spelled: the router decodes %2D and merges
// slashes before it picks a page, so the check does the same, and a path it cannot decode counts as inside
const isSuperAdminPath = (path: string) => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch (err) {
    return true;
  }
  const clean = decoded.replace(/\/+/g, '/').toLowerCase();
  return clean === SUPER_ADMIN_PATH || clean.startsWith(`${SUPER_ADMIN_PATH}/`);
};

// Whether the signed-in session belongs to a super admin; any failure answers no, so the page stays closed
const isSuperAdminSession = async () => {
  try {
    const response = await internalFetch('/user/super-admin');
    return response.ok && !!(await response.json())?.admin;
  } catch (err) {
    return false;
  }
};

// This function can be marked `async` if using `await` inside
export async function proxy(request: NextRequest) {
  const nextUrl = request.nextUrl;
  const authCookie =
    request.cookies.get('auth') ||
    request.headers.get('auth') ||
    nextUrl.searchParams.get('loggedAuth');
  const lng = request.cookies.has(cookieName)
    ? acceptLanguage.get(request.cookies.get(cookieName).value)
    : acceptLanguage.get(
        request.headers.get('Accept-Language') ||
          request.headers.get('accept-language')
      );

  const requestHeaders = new Headers(request.headers);
  // Only the proxy decides the workspace of a server render
  requestHeaders.delete('x-workspace-id');
  if (lng) {
    requestHeaders.set(headerName, lng);
  }

  const topResponse = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  if (lng) {
    topResponse.headers.set(cookieName, lng);
  }

  if (nextUrl.pathname.startsWith('/modal/') && !authCookie) {
    return NextResponse.redirect(new URL(`/auth/login-required`, nextUrl.href));
  }

  if (
    nextUrl.pathname.startsWith('/uploads/') ||
    nextUrl.pathname.startsWith('/p/') ||
    nextUrl.pathname.startsWith('/provider/') ||
    nextUrl.pathname.startsWith('/icons/')
  ) {
    return topResponse;
  }

  if (LEGAL_PATHS.includes(nextUrl.pathname)) {
    return topResponse;
  }

  // A one-time link from the app signs in the user it was made for, whether or not this browser is
  // already signed in (as that user or another), so it is never sent away like the other /auth pages
  if (nextUrl.pathname === WEB_HANDOFF_PATH) {
    return topResponse;
  }

  if (nextUrl.pathname === LOGOUT_PATH && request.method !== 'POST') {
    return topResponse;
  }

  if (
    nextUrl.pathname.startsWith('/integrations/social/') &&
    nextUrl.href.indexOf('state=login') === -1
  ) {
    return topResponse;
  }

  // If the URL is logout, delete the cookie and redirect to login (303, so a POST arrives at login as a GET)
  if (
    nextUrl.href.indexOf('/auth/logout') > -1 ||
    nextUrl.pathname === LOGOUT_PATH
  ) {
    const response = NextResponse.redirect(
      new URL('/auth/login', nextUrl.href),
      303
    );
    response.cookies.set('auth', '', {
      path: '/',
      ...(!process.env.NOT_SECURED
        ? {
            secure: true,
            httpOnly: true,
            sameSite: false,
          }
        : {}),
      maxAge: -1,
      domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
    });
    // A second auth cookie scoped to this host only (written while the site ran without TLS) is not the
    // one above, so it would survive, keep the browser "signed in" here and loop it back to the app.
    // Appended after cookies.set, which would otherwise rewrite the Set-Cookie headers by name.
    response.headers.append(
      'Set-Cookie',
      `auth=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${
        !process.env.NOT_SECURED ? '; Secure; HttpOnly' : ''
      }`
    );
    return response;
  }

  if (
    nextUrl.pathname.startsWith('/auth/register') &&
    process.env.DISABLE_REGISTRATION === 'true'
  ) {
    return NextResponse.redirect(new URL('/auth/login', nextUrl.href));
  }

  const org = nextUrl.searchParams.get('org');
  const url = new URL(nextUrl).search;
  if (!nextUrl.pathname.startsWith('/auth') && !authCookie) {
    const providers = ['google', 'settings'];
    const findIndex = providers.find((p) => nextUrl.href.indexOf(p) > -1);
    const additional = !findIndex
      ? ''
      : (url.indexOf('?') > -1 ? '&' : '?') +
        `provider=${(findIndex === 'settings'
          ? process.env.POSTIZ_GENERIC_OAUTH
            ? 'generic'
            : 'github'
          : findIndex
        ).toUpperCase()}`;
    // the sign-in page keeps this address (`returnUrl`) and the person lands on it after signing in; it is
    // built on the site's public address, because the origin of this request is the server's own
    const returnTo = RETURN_PATHS.includes(nextUrl.pathname)
      ? `${(url + additional).indexOf('?') > -1 ? '&' : '?'}returnUrl=${encodeURIComponent(
          `${(process.env.FRONTEND_URL || nextUrl.origin).replace(/\/+$/, '')}${nextUrl.pathname}${nextUrl.search}`
        )}`
      : '';
    return NextResponse.redirect(
      new URL(`/auth${url}${additional}${returnTo}`, nextUrl.href)
    );
  }

  // If the url is /auth and the cookie exists, redirect to /
  if (nextUrl.pathname.startsWith('/auth') && authCookie) {
    return NextResponse.redirect(new URL(`/${url}`, nextUrl.href));
  }
  if (nextUrl.pathname.startsWith('/auth') && !authCookie) {
    if (org) {
      const redirect = NextResponse.redirect(new URL(`/`, nextUrl.href));
      redirect.cookies.set('org', org, {
        ...(!process.env.NOT_SECURED
          ? {
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: false,
              domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
            }
          : {}),
        expires: new Date(Date.now() + 15 * 60 * 1000),
      });
      return redirect;
    }
    return topResponse;
  }
  try {
    if (org) {
      const { id } = await (
        await internalFetch('/user/join-org', {
          body: JSON.stringify({
            org,
          }),
          method: 'POST',
        })
      ).json();
      const redirect = NextResponse.redirect(
        new URL(`/?added=true`, nextUrl.href)
      );
      if (id) {
        redirect.cookies.set('showorg', id, {
          ...(!process.env.NOT_SECURED
            ? {
                path: '/',
                secure: true,
                httpOnly: true,
                sameSite: false,
                domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
              }
            : {}),
          expires: new Date(Date.now() + 15 * 60 * 1000),
        });
      }
      return redirect;
    }
    // /w/<workspace>/<page> renders <page> for that workspace. The browser
    // keeps the prefixed URL; server fetches send the workspace header.
    const { workspaceId, path } = splitWorkspacePath(nextUrl.pathname);
    // Checked on the path without /w/<id>, because the rewrite below does not run the proxy again
    if (
      isSuperAdminPath(path) &&
      !(await isSuperAdminSession())
    ) {
      // Shown as a 404, so the page does not look like it exists
      return NextResponse.rewrite(new URL('/404', nextUrl.href));
    }
    if (workspaceId) {
      if (path === '/') {
        return NextResponse.redirect(
          new URL(
            `/w/${workspaceId}${!!process.env.IS_GENERAL ? '/launches' : '/analytics'}`,
            nextUrl.href
          )
        );
      }
      requestHeaders.set('x-workspace-id', workspaceId);
      const rewrite = NextResponse.rewrite(
        new URL(path + nextUrl.search, nextUrl.href),
        { request: { headers: requestHeaders } }
      );
      if (lng) {
        rewrite.headers.set(cookieName, lng);
      }
      return rewrite;
    }

    if (nextUrl.pathname === '/') {
      return NextResponse.redirect(
        new URL(
          !!process.env.IS_GENERAL ? '/launches' : `/analytics`,
          nextUrl.href
        )
      );
    }

    return topResponse;
  } catch (err) {
    console.log('err', err);
    return NextResponse.redirect(new URL('/auth/logout', nextUrl.href));
  }
}

// See "Matching Paths" below to learn more
export const config = {
  matcher: '/((?!api/|_next/|_static/|_vercel|[\\w-]+\\.\\w+).*)',
};