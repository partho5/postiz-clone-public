// Legal pages: /terms, /privacy and /data-deletion answer 200 with no session, show the
// operator and contact address, and are linked from the sign-in page and the footer of an app page.
import { test, expect } from '../support/test.fixture';
import { signUp } from '../support/tenants.fixture';
import { logIn, WORKSPACE_PAGE } from '../support/session.fixture';
import {
  PRODUCT_CONTACT_EMAIL,
  PRODUCT_OPERATOR,
} from '../../libraries/helpers/src/brand/brand.identity';

const PATHS = ['/terms', '/privacy', '/data-deletion'];

for (const path of PATHS) {
  test(`${path} answers a visitor with no session`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(page.getByText(PRODUCT_OPERATOR, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(PRODUCT_CONTACT_EMAIL).first()).toBeVisible();
  });
}

test('the Terms state no cash refunds and the credit expiry rules', async ({ page }) => {
  await page.goto('/terms');
  await expect(page.getByText(/no cash refunds/i)).toBeVisible();
  await expect(page.getByText(/never expire/i)).toBeVisible();
  await expect(page.getByText(/reset at each billing period/i)).toBeVisible();
  await expect(page.getByText(/free credits reset every month/i)).toBeVisible();
});

test('the sign-in page links to the three pages', async ({ page }) => {
  await page.goto('/auth');
  for (const path of PATHS) {
    await expect(page.locator(`a[href="${path}"]`)).toBeVisible();
  }
});

test('a signed-in person sees the pages unscoped and the footer links in the app', async ({
  page,
  request,
  db,
  backendUrl,
}) => {
  const a = await signUp(request, db, backendUrl, 'legal');
  await logIn(page, a.person);
  await expect(page).toHaveURL(WORKSPACE_PAGE);
  for (const path of PATHS) {
    await expect(page.locator(`a[href="${path}"]`)).toBeVisible();
  }
  for (const path of PATHS) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(page.getByText(PRODUCT_CONTACT_EMAIL).first()).toBeVisible();
  }
});
