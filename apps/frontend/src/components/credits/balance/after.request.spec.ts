/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// Balance header, the app's `afterRequest`: a write the server accepted makes the balance ask the
// server again, and a 402 for credits shows the server's numbers while any other 402 keeps the old dialog.
// Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' \
//     --transform '{"^.+\\.tsx?$":["ts-jest",{"isolatedModules":true,"tsconfig":{"jsx":"react-jsx","esModuleInterop":true}}]}' \
//     after.request
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';

// The props the app's fetch wrapper was last given; `afterRequest` is read from them.
let wrapper: { afterRequest: (...args: any[]) => Promise<boolean> };
const opened: any[] = [];
const refreshes: number[] = [];
const dialogs: string[] = [];

jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  // Keeps the props it is given and renders its children.
  FetchWrapperComponent: (props: any) => {
    wrapper = props;
    return props.children;
  },
}));
jest.mock(
  '@gitroom/frontend/app/(app)/auth/return.url.component',
  () => ({
    // No stored return URL.
    useReturnUrl: () => ({ getAndClear: () => null }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/helpers/variable.context',
  () => ({
    // A secured, general deployment.
    useVariables: () => ({
      backendUrl: 'http://backend',
      isGeneral: true,
      isSecured: true,
    }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/helpers/delete.dialog',
  () => ({
    // Records the dialog and answers that the user declined it.
    deleteDialog: async (message: string) => {
      dialogs.push(message);
      return false;
    },
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/new-modal',
  () => ({
    // A modal host that records what was opened.
    useModals: () => ({
      // Keeps the modal's parameters for the test to read.
      openModal: (params: any) => opened.push(params),
    }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/workspace.navigation',
  () => ({
    // Plain anchor and no-op session helpers.
    WorkspaceLink: (props: any) =>
      require('react').createElement('a', { href: props.href }, props.children),
    broadcastAuth: () => {},
    wipeSessionData: async () => {},
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/balance/use.credit.balance',
  () => ({
    // Counts the asks for the balance; the owner may top up.
    mutateCreditBalance: () => refreshes.push(Date.now()),
    useCreditBalance: () => ({ data: { canTopUp: true } }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/balance/credit.refusal',
  () => jest.requireActual('./credit.refusal'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/billing/topups/topup.dialog',
  () => ({
    // A marker for the credit pack dialog.
    TopupDialog: () =>
      require('react').createElement('div', null, 'topup dialog'),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/form/button',
  () => ({
    // A plain button standing in for the design-system one.
    Button: (props: any) =>
      require('react').createElement(
        'button',
        { onClick: props.onClick },
        props.children
      ),
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
jest.mock('i18next', () => ({
  __esModule: true,
  default: {
    // Answers the English fallback of every key.
    t: (_key: string, fallback: string) => fallback,
  },
}));

import LayoutContext from '../../layout/layout.context';

// A response with the parts `afterRequest` reads; its body can be read once, as a real one.
const fake = (status: number, body: unknown = {}) => {
  let consumed = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    // A readable copy; reading it leaves the original body unread.
    clone: () => ({ json: async () => body }),
    // Reads the body once.
    json: async () => {
      if (consumed) {
        throw new TypeError('body used already');
      }
      consumed = true;
      return body;
    },
  } as unknown as Response;
};

describe('afterRequest and the balance', () => {
  beforeEach(() => {
    opened.length = 0;
    refreshes.length = 0;
    dialogs.length = 0;
    render(createElement(LayoutContext, null, createElement('div')));
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'a %s the server accepted makes the balance ask again, and the answer goes on to the caller',
    async (method) => {
      const response = fake(200);

      const proceed = await wrapper.afterRequest('/posts', { method }, response);

      expect(proceed).toBe(true);
      expect(refreshes).toHaveLength(1);
    }
  );

  it('a read does not make the balance ask again', async () => {
    await wrapper.afterRequest('/posts', { method: 'GET' }, fake(200));
    await wrapper.afterRequest('/posts', {}, fake(200));

    expect(refreshes).toHaveLength(0);
  });

  it('a write the server refused does not make the balance ask again', async () => {
    await wrapper.afterRequest('/posts', { method: 'POST' }, fake(500));

    expect(refreshes).toHaveLength(0);
  });

  it('INSUFFICIENT_CREDITS opens the refusal with the server numbers and leaves the body to the caller', async () => {
    const body = { code: 'INSUFFICIENT_CREDITS', required: 12, available: 3 };
    const response = fake(402, body);

    const proceed = await wrapper.afterRequest(
      '/posts',
      { method: 'POST' },
      response
    );

    expect(proceed).toBe(true);
    expect(dialogs).toHaveLength(0);
    expect(opened).toHaveLength(1);
    expect(opened[0].title).toBe('Not enough credits');
    expect(refreshes.length).toBeGreaterThan(0);
    expect(await response.json()).toEqual(body);

    render(opened[0].children(() => {}));
    await screen.findByText('This needs 12 credits and you have 3.');
    expect(screen.getByText('Top up')).toBeTruthy();
  });

  it('AI_CAP_REACHED opens the refusal with the cap and what is used', async () => {
    await wrapper.afterRequest(
      '/media/generate-image',
      { method: 'POST' },
      fake(402, { code: 'AI_CAP_REACHED', cap: 25, used: 25 })
    );

    expect(opened).toHaveLength(1);
    render(opened[0].children(() => {}));
    await screen.findByText(
      'The free plan includes 25 AI credits a month and 25 are used.'
    );
  });

  it('a 402 with another code keeps the old billing dialog and opens no refusal', async () => {
    const proceed = await wrapper.afterRequest(
      '/posts',
      { method: 'POST' },
      fake(402, { message: 'Upgrade your plan', code: 'PLAN_LIMIT' })
    );

    expect(opened).toHaveLength(0);
    expect(dialogs).toEqual(['Upgrade your plan']);
    expect(proceed).toBe(true);
  });
});
