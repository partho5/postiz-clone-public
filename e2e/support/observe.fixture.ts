// E2E fixtures: what a tab sends to the backend, what it renders, and what it keeps in the
// browser — the observable facts the tenancy tests assert on.
import { Page, Request } from '@playwright/test';

export interface BackendRequest {
  method: string;
  path: string;
  workspace?: string;
  sessionUser?: string;
  pageUrl: string;
  // whether the page had already been told who its user is (its /user/self answer)
  userKnown: boolean;
}

// Collects every request the tab makes to the backend, except CORS preflights (the browser
// sends those itself and they never carry request headers)
export const recordBackendRequests = (page: Page, backendUrl: string) => {
  const requests: BackendRequest[] = [];
  let userKnown = false;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      userKnown = false;
    }
    if (
      !request.url().startsWith(backendUrl) ||
      request.method() === 'OPTIONS'
    ) {
      return;
    }
    const headers = request.headers();
    requests.push({
      method: request.method(),
      path: request.url().slice(backendUrl.length),
      workspace: headers['x-workspace-id'],
      sessionUser: headers['x-session-user'],
      pageUrl: page.url(),
      userKnown,
    });
  });
  page.on('response', (response) => {
    if (response.url().startsWith(`${backendUrl}/user/self`) && response.ok()) {
      userKnown = true;
    }
  });
  return requests;
};

export interface BackendAnswer {
  method: string;
  path: string;
  status: number;
  body: string;
}

// Keeps the backend's answer to each matching request of the tab, read before the tab can act
// on it (a tab that reloads on an answer takes the answer's body with it)
export const captureBackendAnswers = async (
  page: Page,
  backendUrl: string,
  matches: (request: Request) => boolean
) => {
  const answers: BackendAnswer[] = [];
  await page.route(`${backendUrl}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS' || !matches(request)) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    answers.push({
      method: request.method(),
      path: request.url().slice(backendUrl.length),
      status: response.status(),
      body: await response.text(),
    });
    await route.fulfill({ response });
  });
  return answers;
};

export interface Sighting {
  document: string;
  path: string;
  markers: string[];
}

// Reports, for every document the tab loads, each change in which of the markers are rendered,
// so a test can tell what a screen showed at any moment, including between reloads
export const watchForMarkers = async (page: Page, markers: string[]) => {
  const sightings: Sighting[] = [];
  await page.exposeBinding('__e2eSighting', (_source, sighting: Sighting) => {
    sightings.push(sighting);
  });
  await page.addInitScript((watched: string[]) => {
    const document_ = Math.random().toString(36).slice(2);
    let last = '';
    // Reports the markers now rendered when they differ from the last report
    const check = () => {
      const text = document.documentElement?.innerText || '';
      const found = watched.filter((marker) => text.includes(marker));
      if (found.join('|') !== last) {
        last = found.join('|');
        (window as any).__e2eSighting({
          document: document_,
          path: window.location.pathname,
          markers: found,
        });
      }
    };
    new MutationObserver(check).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, markers);
  return sightings;
};

// Everything the tab's origin keeps in localStorage, sessionStorage and Cache Storage, as text
export const browserStores = (page: Page) =>
  page.evaluate(async () => {
    // Every key and value of a Web Storage area
    const entries = (storage: Storage) =>
      Object.keys(storage).map((key) => `${key}=${storage.getItem(key)}`);
    const cached: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        cached.push(`${name} ${request.url} ${await response?.text()}`);
      }
    }
    return {
      localStorage: entries(localStorage),
      sessionStorage: entries(sessionStorage),
      cacheStorage: cached,
    };
  });

// The same-origin paths of every link on the page
export const appLinks = (page: Page) =>
  page.$$eval('a[href]', (anchors) =>
    anchors
      .map((anchor) => anchor.getAttribute('href') || '')
      .filter((href) => href.startsWith('/') && !href.startsWith('//'))
  );

// Pages that belong to no workspace, as the tenancy.workspace-routing contract lists them
export const UNSCOPED = [
  '/auth',
  '/p/',
  '/provider/',
  '/integrations/social/',
  '/oauth',
  '/modal/',
  '/uploads/',
  '/api/',
];
