import {
  currentWorkspaceId,
  getTabUser,
} from '@gitroom/helpers/utils/workspace.path';

export interface Params {
  baseUrl: string;
  beforeRequest?: (url: string, options: RequestInit) => Promise<RequestInit>;
  afterRequest?: (
    url: string,
    options: RequestInit,
    response: Response
  ) => Promise<boolean>;
  // Called when the session can no longer be refreshed: the tab signs out and goes to login.
  onSessionLost?: () => Promise<void>;
}

// The methods whose requests carry an Idempotency-Key.
const MUTATIONS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// A fresh Idempotency-Key: a random UUID, or 128 random bits in hex where randomUUID needs a secure context.
export const newIdempotencyKey = () => {
  if (globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, '0')
  ).join('');
};

// Whether the caller already chose an Idempotency-Key in the request headers.
const hasIdempotencyKey = (headers: RequestInit['headers']) =>
  Object.keys(headers || {}).some((h) => h.toLowerCase() === 'idempotency-key');

// Whether a response is the server saying the access token has expired.
const isTokenExpired = async (response: Response) => {
  if (response.status !== 401) {
    return false;
  }
  const { code } = await response
    .clone()
    .json()
    .catch(() => ({} as { code?: string }));
  return code === 'TOKEN_EXPIRED';
};

// The refresh call every request of this tab that found its token expired waits on, so a burst of
// expired requests makes one call.
let refreshInFlight: Promise<{ ok: boolean; response: Response }> | undefined;

// Asks the server for a new token pair with the refresh cookie; the server sets the new cookies.
const refreshSession = (params: Params) => {
  refreshInFlight ??= fetch(params.baseUrl + '/auth/token', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token' }),
    cache: 'no-store',
  })
    .then((response) => ({ ok: response.ok, response }))
    .finally(() => {
      refreshInFlight = undefined;
    });
  return refreshInFlight;
};

// Builds the app's fetch: adds the auth, workspace and idempotency headers and refreshes the session when the token expires.
export const customFetch = (
  params: Params,
  auth?: string,
  showorg?: string,
  secured: boolean = true
) => {
  // Sends one request with the workspace and idempotency headers, refreshes an expired access token once and retries.
  return async function newFetch(url: string, options: RequestInit = {}) {
    const loggedAuth =
      typeof window === 'undefined'
        ? undefined
        : new URL(window.location.href).searchParams.get('loggedAuth');
    const newRequestObject = await params?.beforeRequest?.(url, options);
    const workspaceId = currentWorkspaceId();
    const tabUser = getTabUser();
    // one key for the request and its retry after a token refresh
    const idempotencyKey =
      MUTATIONS.includes((options.method || 'GET').toUpperCase()) &&
      !hasIdempotencyKey(options.headers)
        ? newIdempotencyKey()
        : undefined;

    // Sends the request with the cookies as they are now, so a retry carries the refreshed token.
    // Over https the session cookies are httpOnly and travel by themselves; one the page can read is a
    // leftover from a run without TLS, and sent as a header it would override the real session.
    const send = () => {
      const authNonSecuredCookie =
        typeof document === 'undefined' || secured
          ? null
          : document.cookie
              .split(';')
              .find((p) => p.includes('auth='))
              ?.split('=')[1];

      const authNonSecuredOrg =
        typeof document === 'undefined' || secured
          ? null
          : document.cookie
              .split(';')
              .find((p) => p.includes('showorg='))
              ?.split('=')[1];

      const authNonSecuredImpersonate =
        typeof document === 'undefined' || secured
          ? null
          : document.cookie
              .split(';')
              .find((p) => p.includes('impersonate='))
              ?.split('=')[1];

      return fetch(params.baseUrl + url, {
        ...(secured ? { credentials: 'include' } : {}),
        ...(newRequestObject || options),
        headers: {
          ...(showorg
            ? { showorg }
            : authNonSecuredOrg
            ? { showorg: authNonSecuredOrg }
            : {}),
          ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
          ...(tabUser ? { 'x-session-user': tabUser } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          ...(options.body instanceof FormData
            ? {}
            : { 'Content-Type': 'application/json' }),
          Accept: 'application/json',
          ...(loggedAuth ? { auth: loggedAuth } : {}),
          ...options?.headers,
          ...(auth
            ? { auth }
            : authNonSecuredCookie
            ? { auth: authNonSecuredCookie }
            : {}),
          ...(authNonSecuredImpersonate
            ? { impersonate: authNonSecuredImpersonate }
            : {}),
        },
        // @ts-ignore
        ...(!options.next && options.cache !== 'force-cache'
          ? { cache: options.cache || 'no-store' }
          : {}),
      });
    };

    let fetchRequest = await send();

    // A browser tab with an expired access token refreshes once and retries the request once; a
    // server render or an explicit token has no refresh cookie to use.
    if (
      typeof document !== 'undefined' &&
      !auth &&
      !loggedAuth &&
      (await isTokenExpired(fetchRequest))
    ) {
      const refreshed = await refreshSession(params);
      if (!refreshed.ok) {
        if (params.onSessionLost) {
          await params.onSessionLost();
          // @ts-ignore
          return new Promise((res) => {}) as Response;
        }
        return fetchRequest;
      }
      // lets the app store a token the server also returned in a header
      await params?.afterRequest?.(
        '/auth/token',
        { method: 'POST' },
        refreshed.response
      );
      fetchRequest = await send();
    }

    if (
      !params?.afterRequest ||
      (await params?.afterRequest?.(url, options, fetchRequest))
    ) {
      return fetchRequest;
    }

    // @ts-ignore
    return new Promise((res) => {}) as Response;
  };
};

export const fetchBackend = customFetch({
  get baseUrl() {
    return process.env.BACKEND_URL!;
  },
});
