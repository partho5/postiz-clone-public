/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// Quick start: the three steps from sign-up to a first scheduled post, resumed from server
// state, with the connect's return landing back on it. Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' \
//     --transform '{"^.+\\.tsx?$":["ts-jest",{"isolatedModules":true,"tsconfig":{"jsx":"react-jsx","esModuleInterop":true}}]}' \
//     quick.start
import { createElement } from 'react';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { SWRConfig } from 'swr';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

dayjs.extend(utc);
dayjs.extend(timezone);

// What the screens ask the backend, answered per test by `answers`.
const calls: Array<{
  path: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
}> = [];
let answers: (path: string, method: string) => Response;
// Where the flow sent the person through the workspace router, in order.
const pushed: string[] = [];
// The modals the flow opened.
const modals: any[] = [];
// What the connect picker saw in the connect record when it opened.
const pickerOpened: Array<string | null> = [];

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
      require('react').createElement(
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
    // A plain input, labelled, standing in for the design-system one.
    Input: (props: any) =>
      require('react').createElement('input', {
        'aria-label': props.label,
        value: props.value,
        onChange: props.onChange,
      }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/toaster/toaster',
  () => ({
    // The toaster the screens show their messages through.
    useToaster: () => ({ show: () => {} }),
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
    // The public values the connect landing reads.
    useVariables: () => ({ extensionId: '', backendUrl: '' }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/use.idempotency.key',
  () => ({
    // A fixed idempotency key; renewing it does nothing.
    useIdempotencyKey: () => ({ key: () => 'key-1', reset: () => {} }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/workspace.navigation',
  () => {
    // A router that records where the flow sends the person; the same object every render, as the real one.
    const router = { push: (path: string) => pushed.push(path) };
    return { useWorkspaceRouter: () => router };
  },
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/new-modal',
  () => ({
    // A modal manager that records what is opened.
    useModals: () => ({ openModal: (options: any) => modals.push(options) }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/new-launch/add.edit.modal',
  () => ({
    // The post editor; the test reads the props the flow gave it.
    AddEditModal: () => null,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/launches/add.provider.component',
  () => ({
    // The channel picker; records the connect record it finds when it opens.
    useAddProvider: () => async () => {
      pickerOpened.push(window.sessionStorage.getItem('quick-start:connect'));
    },
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/launches/helpers/use.integration',
  () => ({
    // The connect landing's context; nothing in it is read here.
    IntegrationContext: require('react').createContext({}),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/new-launch/providers/continue-provider/list',
  () => ({
    // No provider-specific continue screens.
    continueProviderList: {},
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/set.timezone',
  () => ({
    // The browser's own clock.
    newDayjs: (...args: any[]) => require('dayjs')(...args),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/redirect',
  () => ({
    // A redirect the landing never reaches in these cases.
    Redirect: () => null,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/brand/profile/use.current.brand',
  () => jest.requireActual('../../brand/profile/use.current.brand'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/launches/helpers/use.integration.list',
  () => jest.requireActual('../../launches/helpers/use.integration.list'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/onboarding/quick-start/brand.step',
  () => jest.requireActual('./brand.step'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/onboarding/quick-start/channel.step',
  () => jest.requireActual('./channel.step'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/onboarding/quick-start/post.step',
  () => jest.requireActual('./post.step'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/onboarding/quick-start/use.post.total',
  () => jest.requireActual('./use.post.total'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/onboarding/quick-start/quick.start.connect',
  () => jest.requireActual('./quick.start.connect'),
  { virtual: true }
);

import { QuickStart } from './quick.start';
import {
  clearQuickStartConnect,
  markQuickStartConnect,
  takeQuickStartConnect,
} from './quick.start.connect';
import { ContinueIntegration } from '../../launches/continue.integration';

const unsetBrand = {
  id: 'b1',
  name: 'Acme',
  slug: 'acme',
  color: '#612bd3',
  avatarUrl: null,
  timezone: 'UTC',
  locale: 'en',
  profile: { schemaVersion: 1 },
};
const channel = {
  id: 'c1',
  name: 'Acme page',
  identifier: 'x',
  disabled: false,
  inBetweenSteps: false,
  picture: '',
  type: 'social',
};
const slot = '2026-10-12T09:00:00.000Z';

// The answer the backend gives, in the shape of the `Response` parts the screens read (jsdom has none).
const reply = (status: number, body?: unknown) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    // Reads the body the test gave.
    json: async () => body,
  }) as unknown as Response;

// A backend whose workspace has the given brand, channels and post counts; a save answers with `save`.
const server =
  (state: {
    brand?: object;
    channels?: object[];
    scheduled?: number;
    published?: number;
    save?: Response;
  }) =>
  (path: string, method: string) => {
    if (path === '/brands/current') {
      return method === 'PUT'
        ? state.save ?? reply(200, { ...unsetBrand, ...state.brand })
        : reply(200, { ...unsetBrand, ...state.brand });
    }
    if (path === '/integrations/list') {
      return reply(200, { integrations: state.channels ?? [] });
    }
    if (path === '/posts/list?state=scheduled&limit=1') {
      return reply(200, { t: state.scheduled ?? 0, p: [] });
    }
    if (path === '/posts/list?state=published&limit=1') {
      return reply(200, { t: state.published ?? 0, p: [] });
    }
    if (path === '/posts/find-slot') {
      return reply(200, { date: slot });
    }
    return reply(404);
  };

// Mounts a screen with a fresh SWR cache so no test sees another's data.
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

beforeEach(() => {
  calls.length = 0;
  pushed.length = 0;
  modals.length = 0;
  pickerOpened.length = 0;
  window.sessionStorage.clear();
});

describe('QuickStart', () => {
  it('starts at the brand step for a new workspace and saves name, color and the detected time zone', async () => {
    answers = server({});
    mount(QuickStart);

    await screen.findByText('Name your brand');
    fireEvent.click(screen.getByText('Continue'));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PUT')).toBe(true)
    );
    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.path).toBe('/brands/current');
    expect(put.headers).toMatchObject({ 'Idempotency-Key': 'key-1' });
    expect(JSON.parse(put.body!)).toEqual({
      name: 'Acme',
      color: '#612bd3',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });
    await screen.findByText(
      'Pick the social account you want to post to. Your free monthly credits are added when your first channel connects.'
    );
  });

  it('resumes at the channel step when the brand holds values and no channel exists', async () => {
    answers = server({ brand: { timezone: 'Europe/Berlin' } });
    mount(QuickStart);

    await screen.findByText('Connect a channel', { selector: 'h2' });
    expect(screen.queryByText('Name your brand')).toBeNull();
  });

  it('resumes at the post step when a channel exists and no post does', async () => {
    answers = server({ channels: [channel] });
    mount(QuickStart);

    await screen.findByText('Schedule your first post');
    expect(screen.queryByText('Name your brand')).toBeNull();
  });

  it('opens the existing editor on the connected channel at the next free slot', async () => {
    answers = server({ channels: [channel] });
    mount(QuickStart);

    fireEvent.click(await screen.findByText('Write a post'));

    await waitFor(() => expect(modals).toHaveLength(1));
    const editor = modals[0].children.props;
    expect(editor.selectedChannels).toEqual(['c1']);
    expect(editor.integrations).toEqual([expect.objectContaining({ id: 'c1' })]);
    expect(dayjs(editor.date).toISOString()).toBe(slot);
  });

  it('leaves for the calendar once a post is scheduled', async () => {
    answers = server({ channels: [channel], scheduled: 0 });
    mount(QuickStart);
    fireEvent.click(await screen.findByText('Write a post'));
    await waitFor(() => expect(modals).toHaveLength(1));

    answers = server({ channels: [channel], scheduled: 1 });
    await modals[0].children.props.mutate();

    await waitFor(() => expect(pushed).toEqual(['/launches']));
  });

  it('sends a workspace that already has a post to the calendar', async () => {
    answers = server({ channels: [channel], published: 1 });
    mount(QuickStart);

    await waitFor(() => expect(pushed).toEqual(['/launches']));
  });

  it('records that the connect began on quick start before the channel picker opens', async () => {
    answers = server({ brand: { color: '#112233' } });
    mount(QuickStart);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Connect a channel' })
    );

    await waitFor(() => expect(pickerOpened).toHaveLength(1));
    expect(pickerOpened[0]).not.toBeNull();
  });

  it('names the field of a refused save and stays on the brand step', async () => {
    answers = server({
      save: reply(400, {
        code: 'INVALID_BRAND',
        fields: [{ path: 'timezone', message: 'Unknown time zone' }],
      }),
    });
    mount(QuickStart);

    fireEvent.click(await screen.findByText('Continue'));

    await screen.findByText('Unknown time zone');
    expect(screen.getByText('Name your brand')).toBeTruthy();
  });

  it('tells a member without the right that only an admin can change the brand', async () => {
    answers = server({ save: reply(403, { code: 'ADMIN_REQUIRED' }) });
    mount(QuickStart);

    fireEvent.click(await screen.findByText('Continue'));

    await screen.findByText('Only an admin of this brand can change it.');
  });
});

describe('the quick start connect record', () => {
  it('is true once for a connect that came back, then gone', () => {
    markQuickStartConnect();

    expect(takeQuickStartConnect()).toBe(true);
    expect(takeQuickStartConnect()).toBe(false);
  });

  it('is false when no connect began on quick start', () => {
    expect(takeQuickStartConnect()).toBe(false);
  });

  it('is false for a connect that began more than half an hour ago', () => {
    window.sessionStorage.setItem(
      'quick-start:connect',
      String(Date.now() - 31 * 60 * 1000)
    );

    expect(takeQuickStartConnect()).toBe(false);
  });

  it('is gone once cleared', () => {
    markQuickStartConnect();
    clearQuickStartConnect();

    expect(takeQuickStartConnect()).toBe(false);
  });
});

describe('a connect coming back', () => {
  // Mounts the connect landing for a signed-in or anonymous person; the backend accepts the connect.
  const comeBack = (logged: boolean) => {
    answers = () =>
      reply(200, { id: 'int-1', inBetweenSteps: false, organizationId: 'org-1' });
    mount(ContinueIntegration, { provider: 'x', searchParams: {}, logged });
  };

  it('lands on quick start when the connect began there', async () => {
    markQuickStartConnect();
    comeBack(true);

    await waitFor(() => expect(pushed).toEqual(['/w/org-1/quick-start']));
  });

  it('lands on the calendar, as before, when the connect began anywhere else', async () => {
    comeBack(true);

    await waitFor(() =>
      expect(pushed).toEqual(['/w/org-1/launches?added=x&msg=Channel Updated'])
    );
  });

  it('never lands an anonymous connect on quick start', async () => {
    markQuickStartConnect();
    comeBack(false);

    // The inline success the landing shows an anonymous connect, with the message it was given
    await screen.findByText('Channel Updated');
    expect(pushed).toEqual([]);
    expect(takeQuickStartConnect()).toBe(true);
  });
});
