// Tenancy leak test 5: on /w/<id>/…, every request the web app makes to
// the backend carries x-workspace-id: <id> and, once the tab knows its user, x-session-user — including CopilotKit's
// /copilot/* calls and the local media upload, which do not go through customFetch.
import { writeFileSync } from 'fs';
import { basename } from 'path';
import { test, expect } from '../support/test.fixture';
import { addWorkspace, signUp, uniqueMarker } from '../support/tenants.fixture';
import { logIn } from '../support/session.fixture';
import { recordBackendRequests } from '../support/observe.fixture';

// A one-pixel PNG
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test('every request of a workspace tab carries its workspace and user', async ({
  page,
  request,
  db,
  backendUrl,
}, testInfo) => {
  const x = await signUp(request, db, backendUrl, 'x');
  // The tab works on a workspace that is not the person's first one
  const y = await addWorkspace(db, x.person, 'y');
  await logIn(page, x.person);
  const sent = recordBackendRequests(page, backendUrl);
  // Waits until the tab has sent a request to this backend path
  const sentTo = (path: string) =>
    expect.poll(() => sent.some((request) => request.path.startsWith(path)));

  await page.goto(`/w/${y.id}/launches`);
  await expect(page.getByText(y.post)).toBeVisible();
  await sentTo('/copilot/chat').toBe(true);

  await page.goto(`/w/${y.id}/media`);
  const file = testInfo.outputPath(`${uniqueMarker('upload')}.png`);
  writeFileSync(file, PIXEL);
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().startsWith(`${backendUrl}/media/upload-server`) &&
      response.request().method() === 'POST'
  );
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await uploaded;

  await page.goto(`/w/${y.id}/agents`);
  await expect(page).toHaveURL(new RegExp(`/w/${y.id}/agents/new`));
  await sentTo('/copilot/agent').toBe(true);

  const fromWorkspacePages = sent.filter((request) =>
    /\/w\/[0-9a-f-]{36}\//.test(new URL(request.pageUrl).pathname)
  );
  expect(fromWorkspacePages.length).toBeGreaterThan(0);
  const wrong = fromWorkspacePages.filter((request) => {
    const tabWorkspace = new URL(request.pageUrl).pathname.split('/')[2];
    return (
      request.workspace !== tabWorkspace ||
      // the request that asks the page's user cannot name it yet
      (request.userKnown && request.sessionUser !== x.person.id)
    );
  });
  expect(wrong).toEqual([]);
  for (const path of [
    '/copilot/chat',
    '/copilot/agent',
    '/media/upload-server',
  ]) {
    expect(
      fromWorkspacePages.some((request) => request.path.startsWith(path))
    ).toBe(true);
  }

  // The upload belongs to the tab's workspace
  const media = await db.media.findMany({
    where: { originalName: basename(file) },
  });
  expect(media.map((row) => row.organizationId)).toEqual([y.id]);
});
