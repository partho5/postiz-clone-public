// api.entitlements (E4): the app's upgrade link, /billing?tier=<KEY>, also works for a visitor who is not
// signed in: the proxy sends them to the sign-in page with this address as the return address, and the
// sign-in sends them back to it. Every other page is sent to the sign-in page exactly as before. Run from the
// repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs proxy.spec --roots '<rootDir>/apps/frontend/src'
import { NextRequest } from 'next/server';

// The proxy reads its language settings from a package the spec runner does not map.
jest.mock(
  '@gitroom/react/translation/i18n.config',
  () => ({ cookieName: 'i18next', headerName: 'x-i18next', languages: ['en'] }),
  { virtual: true }
);

// The proxy asks the backend whether the session is a super admin; each test sets the answer.
const mockInternalFetch = jest.fn();
jest.mock('@gitroom/helpers/utils/internal.fetch', () => ({
  internalFetch: (...args: unknown[]) => mockInternalFetch(...args),
}));

import { proxy } from './proxy';

const ORIGIN = 'http://localhost:4200';
const WORKSPACE = '123e4567-e89b-12d3-a456-426614174000';
// The site's public address; the server only knows its own (ORIGIN) behind a reverse proxy.
const PUBLIC_URL = 'https://app.example.com';
const publicUrl = process.env.FRONTEND_URL;

// Each test starts with no public address set, as on a bare dev run; a test sets it when it needs one.
beforeEach(() => {
  delete process.env.FRONTEND_URL;
  mockInternalFetch.mockReset();
});

afterAll(() => {
  if (publicUrl === undefined) {
    delete process.env.FRONTEND_URL;
  } else {
    process.env.FRONTEND_URL = publicUrl;
  }
});

// Sends one request through the frontend proxy and returns its response.
const visit = (path: string, signedIn: boolean) =>
  proxy(
    new NextRequest(`${ORIGIN}${path}`, {
      headers: signedIn ? { cookie: 'auth=token' } : {},
    })
  );

// Where a response sends the browser, as a URL; null when it does not redirect.
const sentTo = (response: Awaited<ReturnType<typeof proxy>>) => {
  const location = response.headers.get('location');
  return location ? new URL(location) : null;
};

describe('api.entitlements: the upgrade link for a signed-out visitor', () => {
  it('sends /billing?tier=<KEY> to the sign-in page with the whole address as the return address', async () => {
    const to = sentTo(await visit('/billing?tier=PRO', false))!;

    expect(to.origin).toBe(ORIGIN);
    expect(to.pathname).toBe('/auth');
    expect(to.searchParams.get('returnUrl')).toBe(`${ORIGIN}/billing?tier=PRO`);
  });

  it('keeps the query string whatever it holds, so the tier is still there after signing in', async () => {
    const to = sentTo(await visit('/billing?tier=starter&x=1%202', false))!;

    expect(to.searchParams.get('returnUrl')).toBe(`${ORIGIN}/billing?tier=starter&x=1%202`);
  });

  it('gives a return address the sign-in page saves (it holds a full URL), and keeps the query string as before', async () => {
    const to = sentTo(await visit('/billing?tier=AGENCY', false))!;

    expect(to.searchParams.get('returnUrl')).toContain('http');
    expect(to.searchParams.get('tier')).toBe('AGENCY');
  });

  it('builds the return address on the public address of the site, never on the server\'s own', async () => {
    process.env.FRONTEND_URL = PUBLIC_URL;
    const to = sentTo(await visit('/billing?tier=PRO', false))!;

    expect(to.origin).toBe(ORIGIN);
    expect(to.searchParams.get('returnUrl')).toBe(`${PUBLIC_URL}/billing?tier=PRO`);
  });

  it('does not double the slash when the public address ends with one', async () => {
    process.env.FRONTEND_URL = `${PUBLIC_URL}/`;
    const to = sentTo(await visit('/billing', false))!;

    expect(to.searchParams.get('returnUrl')).toBe(`${PUBLIC_URL}/billing`);
  });

  it('works with no query string', async () => {
    const to = sentTo(await visit('/billing', false))!;

    expect(to.pathname).toBe('/auth');
    expect(to.searchParams.get('returnUrl')).toBe(`${ORIGIN}/billing`);
  });

  it('lets a signed-in visitor through to the page, with no sign-in step', async () => {
    const response = await visit('/billing?tier=PRO', true);

    expect(sentTo(response)).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('api.entitlements: the other pages for a signed-out visitor', () => {
  it('go to the sign-in page with their query string and no return address, as before', async () => {
    for (const path of ['/launches', '/launches?connect=x', '/analytics', '/']) {
      const to = sentTo(await visit(path, false))!;

      expect(to.pathname).toBe('/auth');
      expect(to.searchParams.has('returnUrl')).toBe(false);
      expect(to.search).toBe(path.includes('?') ? path.slice(path.indexOf('?')) : '');
    }
  });

  it('keep the provider sign-in flow of the settings page unchanged', async () => {
    const to = sentTo(await visit('/settings?code=abc&state=xyz', false))!;

    expect(to.pathname).toBe('/auth');
    expect(to.searchParams.get('code')).toBe('abc');
    expect(to.searchParams.get('provider')).toBe('GITHUB');
    expect(to.searchParams.has('returnUrl')).toBe(false);
  });

  it('leave a workspace-prefixed billing address as before (it names a workspace the next user may not be in)', async () => {
    const to = sentTo(await visit(`/w/${WORKSPACE}/billing?tier=PRO`, false))!;

    expect(to.pathname).toBe('/auth');
    expect(to.searchParams.has('returnUrl')).toBe(false);
  });

  it('keep the sign-in pages themselves open to a signed-out visitor', async () => {
    const response = await visit('/auth?returnUrl=' + encodeURIComponent(`${ORIGIN}/billing?tier=PRO`), false);

    expect(sentTo(response)).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('super admin area: one gate on the /super-admin URL', () => {
  const answer = (admin: boolean, ok = true) =>
    mockInternalFetch.mockResolvedValue({ ok, json: async () => ({ admin }) });
  // True when the response shows the site's 404 instead of the page.
  const isHidden = (response: Awaited<ReturnType<typeof proxy>>) =>
    new URL(response.headers.get('x-middleware-rewrite')!).pathname === '/404';

  it('lets a super admin through to every page of the area', async () => {
    answer(true);
    for (const path of ['/super-admin', '/super-admin/stats', '/super-admin/errors']) {
      const response = await visit(path, true);

      expect(response.headers.get('x-middleware-next')).toBe('1');
    }
  });

  it('shows the 404 to a signed-in user who is not a super admin', async () => {
    answer(false);

    expect(isHidden(await visit('/super-admin/stats', true))).toBe(true);
  });

  it('shows the 404 when the check fails, so the area stays closed', async () => {
    mockInternalFetch.mockRejectedValue(new Error('backend down'));
    expect(isHidden(await visit('/super-admin', true))).toBe(true);

    answer(true, false);
    expect(isHidden(await visit('/super-admin', true))).toBe(true);
  });

  it('closes the workspace-prefixed address too, which would otherwise skip the check', async () => {
    answer(false);

    expect(isHidden(await visit(`/w/${WORKSPACE}/super-admin/prompts`, true))).toBe(true);
  });

  it('closes every other spelling of the address the router would serve as the area', async () => {
    answer(false);
    for (const path of ['/super%2Dadmin', '//super-admin', '/super-admin/', '/%73uper-admin/stats', '/SUPER-ADMIN', '/super-admin%2Fstats', '/super-admin/%E0%A4%A']) {
      expect(isHidden(await visit(path, true))).toBe(true);
    }
  });

  it('lets a super admin through the workspace-prefixed address', async () => {
    answer(true);
    const response = await visit(`/w/${WORKSPACE}/super-admin`, true);

    expect(response.headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/super-admin`);
  });

  it('sends a signed-out visitor to the sign-in page, as for every page', async () => {
    const to = sentTo(await visit('/super-admin', false))!;

    expect(to.pathname).toBe('/auth');
    expect(mockInternalFetch).not.toHaveBeenCalled();
  });

  it('asks the backend nothing for any other page', async () => {
    for (const path of ['/launches', '/settings', '/super-administrator', `/w/${WORKSPACE}/billing`]) {
      await visit(path, true);
    }

    expect(mockInternalFetch).not.toHaveBeenCalled();
  });
});

describe('logout: the way out for a browser stuck with a bad session', () => {
  it('opens for a visitor with any auth cookie, without asking the backend', async () => {
    const response = await visit('/logout', true);

    expect(sentTo(response)).toBeNull();
    expect(mockInternalFetch).not.toHaveBeenCalled();
  });

  it('opens for a signed-out visitor too, instead of sending them to the sign-in page', async () => {
    expect(sentTo(await visit('/logout', false))).toBeNull();
  });

  it('/auth/logout clears the auth cookie and lands on the sign-in page', async () => {
    const response = await visit('/auth/logout', true);

    expect(sentTo(response)!.pathname).toBe('/auth/login');
    expect(response.headers.get('set-cookie')).toContain('auth=;');
  });
});

describe('logout: GET and POST both work', () => {
  const post = (cookie: string) =>
    proxy(new NextRequest(`${ORIGIN}/logout`, { method: 'POST', headers: cookie ? { cookie } : {} }));

  it('POST clears the auth cookie and answers 303 to the sign-in page', async () => {
    const response = await post('auth=token');

    expect(response.status).toBe(303);
    expect(sentTo(response)!.pathname).toBe('/auth/login');
    expect(response.headers.get('set-cookie')).toContain('auth=;');
  });

  it('POST works with no cookie too', async () => {
    expect(sentTo(await post(''))!.pathname).toBe('/auth/login');
  });
});
