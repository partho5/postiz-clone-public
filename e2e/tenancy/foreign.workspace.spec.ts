// Tenancy leak test 4: a request naming a workspace the user is not in is refused with
// 403 WORKSPACE_FORBIDDEN, and a tab opened on such a workspace goes to / without showing it.
import { test, expect } from '../support/test.fixture';
import { signUp } from '../support/tenants.fixture';
import { logIn } from '../support/session.fixture';
import {
  captureBackendAnswers,
  watchForMarkers,
} from '../support/observe.fixture';

test('a workspace the user is not in is refused and the tab goes to /', async ({
  page,
  request,
  db,
  backendUrl,
}) => {
  const a = await signUp(request, db, backendUrl, 'a');
  const b = await signUp(request, db, backendUrl, 'b');
  const ofB = [b.workspace.post, b.workspace.channel, b.workspace.name];
  const sightings = await watchForMarkers(page, ofB);
  await logIn(page, a.person);

  const refused = await captureBackendAnswers(
    page,
    backendUrl,
    (request) => request.headers()['x-workspace-id'] === b.workspace.id
  );
  const toRoot = page.waitForRequest(
    (request) =>
      request.isNavigationRequest() && new URL(request.url()).pathname === '/'
  );
  await page.goto(`/w/${b.workspace.id}/launches`);
  await toRoot;
  expect(refused.length).toBeGreaterThan(0);
  for (const answer of refused) {
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toMatchObject({
      code: 'WORKSPACE_FORBIDDEN',
    });
  }
  await expect(page).toHaveURL(new RegExp(`/w/${a.workspace.id}/`));
  await expect(page.getByText(a.workspace.post)).toBeVisible();
  expect(sightings.filter((s) => s.markers.length > 0)).toEqual([]);

  // Reads and writes naming B's workspace are refused the same way, and write nothing
  for (const [method, path, data] of [
    ['GET', '/integrations/list', undefined],
    ['POST', '/posts/tags', { name: 'e2e-foreign-tag', color: '#000000' }],
  ] as const) {
    const direct = await page.request.fetch(`${backendUrl}${path}`, {
      method,
      data,
      headers: { 'x-workspace-id': b.workspace.id },
    });
    expect(direct.status()).toBe(403);
    const body = await direct.text();
    expect(JSON.parse(body)).toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
    for (const marker of ofB) {
      expect(body).not.toContain(marker);
    }
  }
  expect(await db.tags.count({ where: { orgId: b.workspace.id } })).toBe(0);
});
