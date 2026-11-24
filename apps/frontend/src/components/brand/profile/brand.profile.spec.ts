/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// Brand profile, the Settings "Brand" tab and the "New brand" dialog: an admin saves the
// typed fields and the profile, another member sees it read-only, a refused save names its fields,
// and the dialog holds its Create control until the cost has loaded. Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' \
//     --transform '{"^.+\\.tsx?$":["ts-jest",{"isolatedModules":true,"tsconfig":{"jsx":"react-jsx","esModuleInterop":true}}]}' \
//     brand.profile
import { createElement } from 'react';
import { SWRConfig } from 'swr';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// What the screens ask the backend, answered per test by `answers`.
const calls: Array<{
  path: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
}> = [];
let answers: (path: string, method: string) => Response;
const toasts: Array<[string, string]> = [];
let role = 'ADMIN';
let cost: { amount: number } | undefined;

jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  // A fetch that records each call and answers it from `answers`.
  useFetch:
    () =>
    async (
      path: string,
      init?: { method?: string; body?: string; headers?: Record<string, string> }
    ) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method, body: init?.body, headers: init?.headers });
      return answers(path, method);
    },
}));
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
  '@gitroom/react/form/input',
  () => ({
    // A plain input, labelled, with its error beneath, standing in for the design-system one.
    Input: (props: any) =>
      createElement(
        'div',
        null,
        createElement('input', {
          'aria-label': props.label,
          value: props.value,
          disabled: props.disabled,
          onChange: props.onChange,
        }),
        props.error ? createElement('span', null, props.error) : null
      ),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/form/textarea',
  () => ({
    // A plain textarea, labelled, with its error beneath, standing in for the design-system one.
    Textarea: (props: any) =>
      createElement(
        'div',
        null,
        createElement('textarea', {
          'aria-label': props.label,
          value: props.value,
          disabled: props.disabled,
          onChange: props.onChange,
        }),
        props.error ? createElement('span', null, props.error) : null
      ),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/toaster/toaster',
  () => ({
    // The toaster the screens show their messages through.
    useToaster: () => ({
      // Records what the user would be told.
      show: (message: string, kind: string) => toasts.push([message, kind]),
    }),
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
  '@gitroom/frontend/components/media/media.component',
  () => ({
    // The media library; the avatar choice is not exercised here.
    showMediaBox: jest.fn(),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/user.context',
  () => ({
    // The signed-in user, with the role the test sets.
    useUser: () => ({ role }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/use.idempotency.key',
  () => ({
    // A fixed idempotency key; renewing it does nothing.
    useIdempotencyKey: () => ({
      // The key sent with the request.
      key: () => 'key-1',
      // Renews the key after an answer; a no-op here.
      reset: () => {},
    }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/cost/use.action.cost',
  () => ({
    // The price of `brand.create` as the test has it loaded, or still loading.
    useActionCost: () => ({ data: cost }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/cost/action.cost.note',
  () => ({
    // Names the action whose cost the dialog shows.
    ActionCostNote: (props: any) =>
      createElement('div', null, `cost note: ${props.actionKey}`),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/brand/profile/use.current.brand',
  () => jest.requireActual('./use.current.brand'),
  { virtual: true }
);

import { BrandSettings } from './brand.settings';
import { NewBrandDialog } from './new.brand.dialog';

const aBrand = {
  id: 'b1',
  name: 'Acme',
  slug: 'acme',
  color: '#612bd3',
  avatarUrl: null,
  timezone: 'UTC',
  locale: 'en',
  profile: { schemaVersion: 1, tagline: 'Make it count' },
};

// The answer the backend gives, in the shape of the `Response` parts the screens read (jsdom has none).
const reply = (status: number, body?: unknown) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    // Reads the body the test gave.
    json: async () => body,
  }) as unknown as Response;

// Mounts a screen with a fresh SWR cache so no test sees another's brand.
const mount = (component: any, props: object = {}) =>
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
      createElement(component, props)
    )
  );

describe('BrandSettings', () => {
  beforeEach(() => {
    calls.length = 0;
    toasts.length = 0;
    role = 'ADMIN';
  });

  it('lets an admin change the name and saves the typed fields and the versioned profile', async () => {
    answers = (_path, method) =>
      method === 'PUT'
        ? reply(200, { ...aBrand, name: 'Acme Two' })
        : reply(200, aBrand);
    mount(BrandSettings);
    const name = await screen.findByLabelText('Name');

    fireEvent.change(name, { target: { value: 'Acme Two' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PUT')).toBe(true)
    );
    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.path).toBe('/brands/current');
    expect(put.headers).toMatchObject({ 'Idempotency-Key': 'key-1' });
    expect(JSON.parse(put.body!)).toEqual({
      name: 'Acme Two',
      color: '#612bd3',
      timezone: 'UTC',
      locale: 'en',
      profile: { schemaVersion: 1, tagline: 'Make it count' },
    });
    await waitFor(() => expect(toasts).toContainEqual(['Brand saved', 'success']));
  });

  it('shows another member the brand read-only, with no Save', async () => {
    role = 'USER';
    answers = () => reply(200, aBrand);

    mount(BrandSettings);

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(screen.queryByText('Save')).toBeNull();
  });

  it('puts the message of each refused field under it and does not report a save', async () => {
    answers = (_path, method) =>
      method === 'PUT'
        ? reply(400, {
            statusCode: 400,
            code: 'INVALID_BRAND',
            fields: [{ path: 'profile.tagline', message: 'Too long' }],
          })
        : reply(200, aBrand);
    mount(BrandSettings);
    await screen.findByLabelText('Name');

    fireEvent.click(screen.getByText('Save'));

    await screen.findByText('Too long');
    expect(toasts).toContainEqual([
      'Some brand fields are not valid',
      'warning',
    ]);
    expect(toasts.map(([message]) => message)).not.toContain('Brand saved');
  });
});

describe('NewBrandDialog', () => {
  beforeEach(() => {
    calls.length = 0;
    toasts.length = 0;
    cost = undefined;
  });

  it('shows the brand.create cost note and holds Create until the cost has loaded', async () => {
    answers = () => reply(201, { id: 'new' });
    mount(NewBrandDialog, { onClose: () => {} });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Fresh' },
    });

    expect(screen.getByText('cost note: brand.create')).toBeTruthy();
    expect((screen.getByText('Create brand') as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('sends the name, colour and the browser time zone, and says so when the credits are short', async () => {
    cost = { amount: 3 };
    answers = () => reply(402, { statusCode: 402, code: 'INSUFFICIENT_CREDITS' });
    mount(NewBrandDialog, { onClose: () => {} });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Fresh' },
    });

    fireEvent.click(screen.getByText('Create brand'));

    await screen.findByText('You do not have enough credits to create a brand.');
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.path).toBe('/brands');
    expect(JSON.parse(post.body!)).toEqual({
      name: 'Fresh',
      color: '#612bd3',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });
  });
});
