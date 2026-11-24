// Tenancy leak test 2: two tabs of one person on two workspaces each show only their
// own posts and channels — after reloads and in-app navigation too — and keep their /w/<id>.
import { Page } from '@playwright/test';
import { test, expect } from '../support/test.fixture';
import { addWorkspace, signUp, Workspace } from '../support/tenants.fixture';
import { logIn } from '../support/session.fixture';
import {
  appLinks,
  BackendRequest,
  recordBackendRequests,
  UNSCOPED,
} from '../support/observe.fixture';

interface Tab {
  page: Page;
  own: Workspace;
  other: Workspace;
  requests: BackendRequest[];
  checked: number;
}

// The tab is on its workspace, shows its data and not the other's, sent only its own workspace
// to the backend since the last check, and links only inside a workspace or to unscoped pages
const expectOnlyOwn = async (tab: Tab) => {
  const { page, own, other } = tab;
  await expect(page).toHaveURL(new RegExp(`/w/${own.id}/`));
  await expect(page.getByText(own.post)).toBeVisible();
  await expect(page.getByText(own.channel).first()).toBeVisible();
  const dom = await page.content();
  expect(dom).not.toContain(other.post);
  expect(dom).not.toContain(other.channel);
  const sent = tab.requests.splice(0);
  tab.checked += sent.length;
  expect(sent.filter((request) => request.workspace !== own.id)).toEqual([]);
  const unprefixed = (await appLinks(page)).filter(
    (href) =>
      !/^\/w\/[0-9a-f-]{36}(\/|$)/.test(href) &&
      !UNSCOPED.some((prefix) => href.startsWith(prefix))
  );
  expect(unprefixed).toEqual([]);
};

// Follows the tab's menu link to another page of its workspace
const followMenu = async (tab: Tab, page: string) => {
  await tab.page.locator(`a[href="/w/${tab.own.id}${page}"]`).first().click();
  await expect(tab.page).toHaveURL(new RegExp(`/w/${tab.own.id}${page}`));
};

test('two tabs on two workspaces each show only their own data', async ({
  context,
  request,
  db,
  backendUrl,
}) => {
  const x = await signUp(request, db, backendUrl, 'x');
  const y = await addWorkspace(db, x.person, 'y');
  const login = await context.newPage();
  await logIn(login, x.person);
  await login.close();

  // Opens a tab on one workspace, recording what it sends to the backend
  const open = async (own: Workspace, other: Workspace): Promise<Tab> => {
    const page = await context.newPage();
    const requests = recordBackendRequests(page, backendUrl);
    await page.goto(`/w/${own.id}/launches`);
    return { page, own, other, requests, checked: 0 };
  };
  const tabX = await open(x.workspace, y);
  const tabY = await open(y, x.workspace);
  await expectOnlyOwn(tabX);
  await expectOnlyOwn(tabY);

  for (const tab of [tabX, tabY]) {
    await tab.page.reload();
    await expectOnlyOwn(tab);
  }

  for (const tab of [tabX, tabY]) {
    await followMenu(tab, '/media');
    await followMenu(tab, '/launches');
    await expectOnlyOwn(tab);
  }

  // Activity in one tab never moves the other
  await tabX.page.reload();
  await expectOnlyOwn(tabX);
  await expectOnlyOwn(tabY);
  expect(tabX.checked).toBeGreaterThan(0);
  expect(tabY.checked).toBeGreaterThan(0);
});
