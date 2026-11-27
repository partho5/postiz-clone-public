// Tenancy leak test 1: after A logs out and B logs in, nothing of A's is left in the
// DOM, the SWR cache, localStorage, sessionStorage or Cache Storage.
import { test, expect } from '../support/test.fixture';
import { markersOf, signUp } from '../support/tenants.fixture';
import { logIn, logOut } from '../support/session.fixture';
import { browserStores } from '../support/observe.fixture';

test('after A logs out and B logs in, no A data remains in the browser', async ({
  page,
  request,
  db,
  backendUrl,
}) => {
  const a = await signUp(request, db, backendUrl, 'a');
  const b = await signUp(request, db, backendUrl, 'b');
  const aData = markersOf(a.person, a.workspace);

  await logIn(page, a.person);
  await expect(page.getByText(a.workspace.post)).toBeVisible();
  // A's session keeps data in every browser store, and its SWR cache lives in this page's memory
  await page.evaluate(async (data) => {
    localStorage.setItem('e2e-kept-by-a', data);
    sessionStorage.setItem('e2e-kept-by-a', data);
    const cache = await caches.open('e2e-kept-by-a');
    await cache.put('/e2e-kept-by-a', new Response(data));
    (window as any).__e2ePageOfA = true;
  }, aData.join(' '));

  await logOut(page);
  await logIn(page, b.person);
  await expect(page.getByText(b.workspace.post)).toBeVisible();

  const dom = await page.content();
  const stores = await browserStores(page);
  for (const marker of aData) {
    expect(dom).not.toContain(marker);
    expect(stores.localStorage.join('\n')).not.toContain(marker);
    expect(stores.sessionStorage.join('\n')).not.toContain(marker);
    expect(stores.cacheStorage.join('\n')).not.toContain(marker);
  }
  // A new page memory means A's SWR cache is gone with the old one
  expect(
    await page.evaluate(() => (window as any).__e2ePageOfA)
  ).toBeUndefined();
});
