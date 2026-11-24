#!/usr/bin/env node
// Phone sign-in check against a running instance: request code, exchange, authed calls, refresh, revoke.
// Usage: node deploy/scripts/e2e-auth.mjs <base-url> <email> [code]
//   <base-url> is the API root the phone app uses, e.g. https://app.example.com/api or http://localhost:3000
//   [code] is the six-digit code from the mailbox; without it the script asks for it on the terminal.
import { createInterface } from 'node:readline/promises';

const [base, email, givenCode] = process.argv.slice(2);
if (!base || !email) {
  console.error('usage: node deploy/scripts/e2e-auth.mjs <base-url> <email> [code]');
  process.exit(2);
}
const root = base.replace(/\/+$/, '');
let failed = 0;

// Prints one PASS/FAIL line for a check and counts failures.
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
  return ok;
};

// Sends a JSON request to the API and returns the status and parsed body.
const call = async (method, path, { body, token, headers } = {}) => {
  const res = await fetch(`${root}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
};

const requested = await call('POST', '/auth/otp/request', { body: { email } });
if (!check('POST /auth/otp/request answers 204', requested.status === 204, requested.status)) {
  process.exit(1);
}

const code =
  givenCode ||
  (await createInterface({ input: process.stdin, output: process.stdout })
    .question('Six-digit code from the mailbox: ')
    .then((value) => value.trim()));

const wrong = await call('POST', '/auth/token', {
  body: { grant_type: 'email_otp', email, code: code === '000000' ? '000001' : '000000' },
});
check('a wrong code is refused with 401 INVALID_GRANT', wrong.status === 401 && wrong.json?.code === 'INVALID_GRANT', wrong.status);

const signedIn = await call('POST', '/auth/token', {
  body: { grant_type: 'email_otp', email, code, device_name: 'e2e-auth' },
});
if (!check('POST /auth/token (email_otp) answers 200 with a token pair', signedIn.status === 200 && !!signedIn.json?.access_token && !!signedIn.json?.refresh_token, signedIn.status)) {
  process.exit(1);
}
const { access_token: access, refresh_token: refresh } = signedIn.json;

const reused = await call('POST', '/auth/token', { body: { grant_type: 'email_otp', email, code } });
check('the same code cannot be used twice', reused.status === 401, reused.status);

const self = await call('GET', '/user/self', { token: access });
check('GET /user/self with the Bearer token', self.status === 200 && !!self.json?.orgId, self.status);

const orgs = await call('GET', '/user/organizations', { token: access });
check('GET /user/organizations lists a workspace', orgs.status === 200 && Array.isArray(orgs.json) && orgs.json.length > 0, orgs.status);
const workspace = self.json?.orgId;

const credits = await call('GET', '/copilot/credits', { token: access, headers: { 'x-workspace-id': workspace } });
check('GET /copilot/credits answers the balance', credits.status === 200 && typeof credits.json?.credits === 'number', credits.status);

const channels = await call('GET', '/public/v1/integrations', { token: access, headers: { 'x-workspace-id': workspace } });
check('GET /public/v1/integrations with the Bearer token', channels.status === 200, channels.status);

const preview = await call('POST', '/posts/charge-preview', {
  token: access,
  headers: { 'x-workspace-id': workspace },
  body: { integrationIds: [] },
});
check('POST /posts/charge-preview with Bearer and x-workspace-id', preview.status === 200, preview.status);

const sessions = await call('GET', '/auth/sessions', { token: access });
check('GET /auth/sessions lists this device', sessions.status === 200 && JSON.stringify(sessions.json).includes('e2e-auth'), sessions.status);

const refreshed = await call('POST', '/auth/token', { body: { grant_type: 'refresh_token', refresh_token: refresh } });
check('refresh_token grant returns a new pair', refreshed.status === 200 && refreshed.json?.refresh_token !== refresh, refreshed.status);
const next = refreshed.json?.refresh_token;

const revoked = await call('POST', '/auth/token/revoke', { body: { refresh_token: next } });
check('POST /auth/token/revoke answers 204', revoked.status === 204, revoked.status);

const afterAccess = await call('GET', '/user/self', { token: refreshed.json?.access_token });
check('the access token stops working after revoke', afterAccess.status === 401 || afterAccess.status === 403, afterAccess.status);

const afterRefresh = await call('POST', '/auth/token', { body: { grant_type: 'refresh_token', refresh_token: next } });
check('the refresh token stops working after revoke', afterRefresh.status === 401, afterRefresh.status);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
