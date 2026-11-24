/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// Scoped API keys, the Settings card: a member who cannot manage keys sees a message, never a
// crash, and a refused revoke never reports success. Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' \
//     --transform '{"^.+\\.tsx?$":["ts-jest",{"isolatedModules":true,"tsconfig":{"jsx":"react-jsx","esModuleInterop":true}}]}' \
//     api.keys.component
import { createElement } from 'react';
import { SWRConfig } from 'swr';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// What the card asks the backend, answered per test by `answers`.
const calls: Array<{ path: string; method: string }> = [];
let answers: (path: string, method: string) => Response;
const toasts: Array<[string, string]> = [];

jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  // A fetch that records each call and answers it from `answers`.
  useFetch: () => async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ path, method });
    return answers(path, method);
  },
}));
jest.mock('copy-to-clipboard', () => ({ __esModule: true, default: jest.fn() }));
jest.mock(
  '@gitroom/react/form/button',
  () => ({
    // A plain button standing in for the design-system one.
    Button: (props: any) =>
      createElement(
        'button',
        { onClick: props.onClick, disabled: props.disabled },
        props.children
      ),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/form/checkbox',
  () => ({
    // A plain checkbox standing in for the design-system one.
    Checkbox: (props: any) =>
      createElement('input', {
        type: 'checkbox',
        checked: props.checked,
        onChange: props.onChange,
      }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/form/input',
  () => ({
    // A plain input standing in for the design-system one.
    Input: (props: any) =>
      createElement('input', {
        value: props.value,
        onChange: props.onChange,
      }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/toaster/toaster',
  () => ({
    // The toaster the card shows its messages through.
    useToaster: () => ({
      // Records what the user would be told.
      show: (message: string, kind: string) => toasts.push([message, kind]),
    }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/helpers/delete.dialog',
  () => ({
    // The user confirms every dialog.
    deleteDialog: async () => true,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/translation/get.transation.service.client',
  () => ({
    // Answers the English fallback of every key.
    useT: () => (_key: string, fallback: string) => fallback,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/helpers/variable.context',
  () => ({
    // Names the frontend URL the MCP link is built from.
    useVariables: () => ({ frontEndUrl: 'http://frontend' }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/use.idempotency.key',
  () => ({
    // A fixed idempotency key; renewing it does nothing.
    useIdempotencyKey: () => ({
      // The key sent with the create request.
      key: () => 'key-1',
      // Renews the key after a successful create; a no-op here.
      reset: () => {},
    }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/settings/api-keys/use.api.keys',
  () => jest.requireActual('./use.api.keys'),
  { virtual: true }
);

import { ApiKeysComponent } from './api.keys.component';

const aKey = {
  id: 'k1',
  name: 'Zapier',
  prefix: 'abcd1234',
  scopes: ['posts:read'],
  createdAt: '2026-10-07T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
};

// The answer the backend gives, in the shape of the `Response` parts the card reads (jsdom has none).
const reply = (status: number, body?: unknown) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    // Reads the body the test gave.
    json: async () => body,
  }) as unknown as Response;

// Mounts the card with a fresh SWR cache so no test sees another's list.
const mount = () =>
  render(
    createElement(
      SWRConfig,
      {
        value: {
          // A new, empty cache per mount.
          provider: () => new Map(),
          dedupingInterval: 0,
        },
      },
      createElement(ApiKeysComponent, {
        createdKey: '',
        // Ignores the created key; no test reads it.
        onCreated: () => {},
      })
    )
  );

describe('ApiKeysComponent', () => {
  beforeEach(() => {
    calls.length = 0;
    toasts.length = 0;
  });

  it('tells a member who is refused the list that only admins manage keys, without crashing', async () => {
    answers = () => reply(403, { statusCode: 403, code: 'ADMIN_REQUIRED' });
    mount();
    await screen.findByText('Only workspace admins can manage API keys.');
    expect(screen.queryByText('Create key')).toBeNull();
  });

  it('says the list failed when the backend errors, not that the member is not an admin', async () => {
    answers = () => reply(500, { message: 'boom' });
    mount();
    await screen.findByText('Failed to load the API keys');
  });

  it('lists the keys an admin is given', async () => {
    answers = () => reply(200, [aKey]);
    mount();
    await screen.findByText('Zapier');
    expect(screen.getByText('Create key')).toBeTruthy();
  });

  it('does not report a revoke the backend refused as done', async () => {
    answers = (_path, method) =>
      method === 'DELETE'
        ? reply(403, { statusCode: 403, code: 'ADMIN_REQUIRED' })
        : reply(200, [aKey]);
    mount();
    fireEvent.click(await screen.findByText('Revoke'));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true)
    );
    await waitFor(() =>
      expect(toasts).toContainEqual(['Failed to revoke the API key', 'warning'])
    );
    expect(toasts.map(([message]) => message)).not.toContain('API key revoked');
  });

  it('reports a revoke the backend accepted', async () => {
    answers = (_path, method) =>
      method === 'DELETE' ? reply(204) : reply(200, [aKey]);
    mount();
    fireEvent.click(await screen.findByText('Revoke'));
    await waitFor(() =>
      expect(toasts).toContainEqual(['API key revoked', 'success'])
    );
  });
});
