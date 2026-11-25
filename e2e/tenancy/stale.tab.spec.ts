// Tenancy leak test 3: when B signs in in another tab, A's open tab reloads to / — by
// the auth broadcast, or by 409 SESSION_CHANGED when the broadcast never reaches it — and never
// shows B's data on A's screen or acts as B.
import { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../support/test.fixture';
import { signUp, Tenant } from '../support/tenants.fixture';
import { logIn } from '../support/session.fixture';
import {
  captureBackendAnswers,
  Sighting,
  watchForMarkers,
} from '../support/observe.fixture';

// A's tab asks for / (the tab's exit when its user changed)
const reloadToRoot = (tab: Page) =>
  tab.waitForRequest(
    (request) =>
      request.isNavigationRequest() &&
      request.frame() === tab.mainFrame() &&
      new URL(request.url()).pathname === '/'
  );

// B signs in in a new tab of the same browser after A's sign-in has ended there
const signInElsewhere = async (context: BrowserContext, b: Tenant) => {
  await context.clearCookies();
  const tabB = await context.newPage();
  await logIn(tabB, b.person);
  await expect(tabB.getByText(b.workspace.post)).toBeVisible();
};

// No page A's tab rendered ever showed B's data next to A's, or under A's workspace address
const expectNeverMixed = (sightings: Sighting[], a: Tenant, b: Tenant) => {
  const ofA = [a.workspace.post, a.workspace.channel];
  const ofB = [b.workspace.post, b.workspace.channel];
  const pagesOfA = new Set(
    sightings
      .filter((s) => s.markers.some((m) => ofA.includes(m)))
      .map((s) => s.document)
  );
  const showingB = sightings.filter((s) =>
    s.markers.some((m) => ofB.includes(m))
  );
  expect(showingB.filter((s) => pagesOfA.has(s.document))).toEqual([]);
  expect(
    showingB.filter((s) => s.path.startsWith(`/w/${a.workspace.id}`))
  ).toEqual([]);
};

// A's tab, signed in and showing A's workspace, with everything it renders watched
const openTabOfA = async (context: BrowserContext, a: Tenant, b: Tenant) => {
  const tabA = await context.newPage();
  const sightings = await watchForMarkers(tabA, [
    a.workspace.post,
    a.workspace.channel,
    b.workspace.post,
    b.workspace.channel,
  ]);
  await logIn(tabA, a.person);
  await expect(tabA.getByText(a.workspace.post)).toBeVisible();
  return { tabA, sightings };
};

test('A tab reloads when B signs in in another tab (broadcast)', async ({
  context,
  request,
  db,
  backendUrl,
}) => {
  const a = await signUp(request, db, backendUrl, 'a');
  const b = await signUp(request, db, backendUrl, 'b');
  const { tabA, sightings } = await openTabOfA(context, a, b);

  const reloaded = reloadToRoot(tabA);
  await signInElsewhere(context, b);
  await reloaded;

  await expect(tabA).not.toHaveURL(new RegExp(`/w/${a.workspace.id}`));
  expectNeverMixed(sightings, a, b);
});

test('A tab that missed the broadcast is refused with 409 and reloads instead of acting as B', async ({
  context,
  request,
  db,
  backendUrl,
}) => {
  const a = await signUp(request, db, backendUrl, 'a');
  const b = await signUp(request, db, backendUrl, 'b');
  // A tab that was asleep (or frozen) when the broadcast went out
  await context.addInitScript(() => {
    delete (window as any).BroadcastChannel;
  });
  const { tabA, sightings } = await openTabOfA(context, a, b);

  // Every request A's tab still sends as A once B has signed in
  let bSignedIn = false;
  const answersToA = await captureBackendAnswers(
    tabA,
    backendUrl,
    (request) =>
      bSignedIn && request.headers()['x-session-user'] === a.person.id
  );
  await signInElsewhere(context, b);
  bSignedIn = true;
  await expect(tabA).toHaveURL(new RegExp(`/w/${a.workspace.id}/`));

  // A acts on A's screen: delete A's post
  const reloaded = reloadToRoot(tabA);
  await tabA.getByText(a.workspace.post).first().hover();
  await tabA.getByTestId('delete-post').first().click();
  await tabA.getByTestId('confirm-approve').click();
  await reloaded;

  expect(answersToA.map((answer) => answer.method)).toContain('DELETE');
  for (const answer of answersToA) {
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toMatchObject({ code: 'SESSION_CHANGED' });
  }
  const post = await db.post.findFirstOrThrow({
    where: { organizationId: a.workspace.id },
  });
  expect(post.deletedAt).toBeNull();
  expectNeverMixed(sightings, a, b);
});
