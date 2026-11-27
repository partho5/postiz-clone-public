// E2E helpers: signing in through the backend's one-time-code endpoints, and out through the web
// app's own screens. The backend runs with the log mail provider, so the code is read from the
// log it writes (E2E_BACKEND_LOG).
import { APIRequestContext, expect, Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import type { Person } from './tenants.fixture';

// App pages, as the address bar shows them: /w/<workspace id>/<page>
export const WORKSPACE_PAGE = /\/w\/[0-9a-f-]{36}\/[a-z]/;

// The backend's log file, where the log mail provider writes each message
const backendLog = () => {
  const path = process.env.E2E_BACKEND_LOG;
  if (!path) {
    throw new Error("E2E_BACKEND_LOG must be set to the running backend's log file");
  }
  return path;
};

// How many bytes the backend's log holds now
export const logSize = () => (existsSync(backendLog()) ? statSync(backendLog()).size : 0);

// Waits for the backend to mail a code to an address after the log held `from` bytes, and returns it
export const mailedCode = async (email: string, from: number) => {
  for (let waited = 0; waited < 30_000; waited += 250) {
    const written = readFileSync(backendLog()).subarray(from).toString('utf8');
    const at = written.lastIndexOf(`to=${email} `);
    const code = at < 0 ? null : written.slice(at).match(/<strong>(\d{6})<\/strong>/);
    if (code) {
      return code[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No sign-in code was mailed to ${email}`);
};

// Signs an address in with a one-time code: asks the backend for a code, reads it from the log and
// exchanges it for a session. A new address gets an account and a workspace. The request context
// keeps the session cookies, and each call comes from a client address of its own so the backend's
// per-address request limit never counts one test against another.
export const signInWithCode = async (
  request: APIRequestContext,
  backendUrl: string,
  email: string
) => {
  const headers = {
    'x-forwarded-for': `10.${randomBytes(3).join('.')}`,
  };
  const from = logSize();
  const asked = await request.post(`${backendUrl}/auth/otp/request`, {
    data: { email },
    headers,
  });
  if (!asked.ok()) {
    throw new Error(`Code request failed: ${asked.status()} ${await asked.text()}`);
  }
  const response = await request.post(`${backendUrl}/auth/token`, {
    data: {
      grant_type: 'email_otp',
      email,
      code: await mailedCode(email, from),
      device_name: 'e2e',
    },
    headers,
  });
  if (!response.ok()) {
    throw new Error(`Sign-in failed: ${response.status()} ${await response.text()}`);
  }
  return response;
};

// Signs a person in through the backend, in the page's browser context, and waits for their
// workspace's first page
export const logIn = async (page: Page, person: Person) => {
  await signInWithCode(
    page.context().request,
    process.env.NEXT_PUBLIC_BACKEND_URL!,
    person.email
  );
  await page.goto('/');
  await expect(page).toHaveURL(WORKSPACE_PAGE);
};

// Signs out from the settings screen of the workspace the tab is on
export const logOut = async (page: Page) => {
  const { pathname } = new URL(page.url());
  await page.goto(pathname.replace(/^(\/w\/[^/]+)\/.*$/, '$1/settings'));
  await page
    .getByTestId('logout')
    .filter({ visible: true })
    .first()
    .click();
  await page.getByTestId('confirm-approve').click();
  await expect(page).toHaveURL(/\/auth/);
};
