/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// Balance header: the header shows the server's "Available X · Reserved Y", never a number it
// computed, links Reserved to the reserved posts, warns when the server says the balance is low and offers
// the owner a top-up; a credits refusal shows the server's numbers; the reserved page lists and opens posts.
// Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' \
//     --transform '{"^.+\\.tsx?$":["ts-jest",{"isolatedModules":true,"tsconfig":{"jsx":"react-jsx","esModuleInterop":true}}]}' \
//     balance.header
import { readFileSync } from 'fs';
import { join } from 'path';
import { createElement } from 'react';
import useSWR, { mutate, SWRConfig } from 'swr';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

// What the screens ask the backend, answered per test by `answers`.
const calls: Array<{ path: string; method: string }> = [];
let answers: (path: string, method: string) => Response | Promise<Response>;
const toasts: Array<[string, string]> = [];
const opened: any[] = [];

jest.mock('swr', () => {
  const actual = jest.requireActual('swr');
  return {
    __esModule: true,
    ...actual,
    // The real hook, with its calls recorded so a test can read the options it was given.
    default: jest.fn((...args: any[]) => actual.default(...args)),
  };
});
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  // A fetch that records each call and answers it from `answers`.
  useFetch: () => async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ path, method });
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
  '@gitroom/react/translation/get.transation.service.client',
  () => ({
    // Answers the English fallback of every key.
    useT: () => (_key: string, fallback: string) => fallback,
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
    // A plain anchor keeping the href the link was given.
    WorkspaceLink: (props: any) =>
      require('react').createElement(
        'a',
        { href: props.href, onClick: props.onClick },
        props.children
      ),
  }),
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
  '@gitroom/frontend/components/layout/loading',
  () => ({
    // A marker for the loading state.
    LoadingComponent: () =>
      require('react').createElement('div', null, 'loading'),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/set.timezone',
  () => ({
    // A fixed date text whatever the instant.
    newDayjs: () => ({ local: () => ({ format: () => 'DATE' }) }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/launches/helpers/isuscitizen.utils',
  () => ({
    // The non-US date format.
    isUSCitizen: () => false,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/launches/helpers/use.integration.list',
  () => ({
    // The workspace's channels.
    useIntegrationList: () => ({
      data: [
        { id: 'i1', name: 'My Channel' },
        { id: 'i2', name: 'Other Channel' },
      ],
    }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/new-launch/add.edit.modal',
  () => ({
    // A marker for the post editor.
    AddEditModal: () => require('react').createElement('div', null, 'editor'),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/launches/helpers/use.existing.data',
  () => ({
    // Passes its children through.
    ExistingDataContextProvider: (props: any) => props.children,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/balance/use.credit.balance',
  () => jest.requireActual('./use.credit.balance'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/balance/use.reservations',
  () => jest.requireActual('./use.reservations'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/balance/use.open.reserved.post',
  () => jest.requireActual('./use.open.reserved.post'),
  { virtual: true }
);

import { BalanceHeader } from './balance.header';
import { CreditRefusal, isCreditRefusal } from './credit.refusal';
import { ReservedList } from './reserved.list';
import {
  mutateCreditBalance,
  refreshCreditBalanceAfterRun,
} from './use.credit.balance';

// The answer the backend gives, in the shape of the `Response` parts the screens read (jsdom has none).
const reply = (status: number, body?: unknown) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    // Reads the body the test gave.
    json: async () => body,
  }) as unknown as Response;

// A balance answer from the server, with the fields a test changes.
const balance = (over: Record<string, unknown> = {}) => ({
  available: 120,
  reserved: 30,
  plan: 'PRO',
  allotment: 1200,
  low: false,
  canTopUp: true,
  ...over,
});

// Mounts a screen with no deduping and no focus throttle (SWR ignores focus for a while after a mount),
// so a revalidation is never answered from an earlier request or held back.
const mount = (element: ReturnType<typeof createElement>) =>
  render(
    createElement(
      SWRConfig,
      { value: { dedupingInterval: 0, focusThrottleInterval: 0 } },
      element
    )
  );

describe('balance header', () => {
  beforeEach(async () => {
    calls.length = 0;
    toasts.length = 0;
    opened.length = 0;
    // SWR skips the first fetch of a mount while a request for its key is still tracked, and it drops
    // that request one timer after the answer; the previous test may have ended right after its fetch
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mutate(() => true, undefined, { revalidate: false });
  });

  describe('BalanceHeader', () => {
    it('shows Available and Reserved exactly as the server states them', async () => {
      answers = () => reply(200, balance({ available: 120, reserved: 30 }));
      mount(createElement(BalanceHeader));

      await screen.findByText('120');
      expect(screen.getByText('30')).toBeTruthy();
      expect(screen.getByText(/Available/)).toBeTruthy();
      expect(screen.getByText(/Reserved/)).toBeTruthy();
      expect(calls).toContainEqual({ path: '/credits/balance', method: 'GET' });
    });

    it('links Reserved to the reserved credits page', async () => {
      answers = () => reply(200, balance());
      mount(createElement(BalanceHeader));

      await screen.findByText('120');
      const link = screen.getByText(/Reserved/).closest('a');
      expect(link?.getAttribute('href')).toBe('/credits/reserved');
    });

    it('shows a pending mark, not a number, until the server has answered', async () => {
      let release: (r: Response) => void = () => {};
      answers = () => new Promise<Response>((resolve) => (release = resolve));
      mount(createElement(BalanceHeader));

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(screen.getAllByText('…')).toHaveLength(2);
      expect(screen.queryByText('120')).toBeNull();

      await act(async () => release(reply(200, balance())));
      await screen.findByText('120');
    });

    it('asks the server again after a change and shows its new number, never one of its own', async () => {
      answers = () => reply(200, balance({ available: 100, reserved: 10 }));
      mount(createElement(BalanceHeader));
      await screen.findByText('100');

      let release: (r: Response) => void = () => {};
      answers = () => new Promise<Response>((resolve) => (release = resolve));
      await act(async () => {
        mutateCreditBalance();
      });
      await waitFor(() => expect(screen.getAllByText('…')).toHaveLength(2));
      expect(screen.queryByText('100')).toBeNull();
      expect(screen.queryByText('90')).toBeNull();

      await act(async () =>
        release(reply(200, balance({ available: 100, reserved: 15 })))
      );
      await screen.findByText('15');
    });

    it('shows no warning when the server says the balance is not low', async () => {
      answers = () => reply(200, balance({ low: false }));
      mount(createElement(BalanceHeader));

      await screen.findByText('120');
      expect(screen.queryByText('Low credits')).toBeNull();
      expect(screen.queryByText('Top up')).toBeNull();
    });

    it('warns when the server says low and offers the owner a top-up that opens the pack dialog', async () => {
      answers = () => reply(200, balance({ available: 3, low: true }));
      mount(createElement(BalanceHeader));

      await screen.findByText('Low credits');
      fireEvent.click(screen.getByText('Top up'));

      expect(opened).toHaveLength(1);
      expect(opened[0].title).toBe('Buy credits');
      expect(typeof opened[0].children).toBe('function');
    });

    it('warns a member who does not own the account but offers no top-up', async () => {
      answers = () =>
        reply(200, balance({ available: 3, low: true, canTopUp: false }));
      mount(createElement(BalanceHeader));

      await screen.findByText('Low credits');
      expect(screen.queryByText('Top up')).toBeNull();
    });

    it('shows nothing when the server cannot state the balance', async () => {
      answers = () => reply(500, { message: 'boom' });
      const view = mount(createElement(BalanceHeader));

      await waitFor(() => expect(calls.length).toBeGreaterThan(0));
      await waitFor(() => expect(view.container.textContent).toBe(''));
    });
  });

  describe('revalidation', () => {
    // How many times the balance has been asked for.
    const balanceCalls = () =>
      calls.filter((c) => c.path === '/credits/balance').length;

    it('asks the server again when the window gains focus', async () => {
      answers = () => reply(200, balance());
      mount(createElement(BalanceHeader));
      await screen.findByText('120');
      const before = balanceCalls();

      await act(async () => {
        fireEvent.focus(window);
      });

      await waitFor(() => expect(balanceCalls()).toBe(before + 1));
    });

    it('is set to refresh every 60 seconds, and only while the page is visible', async () => {
      answers = () => reply(200, balance());
      mount(createElement(BalanceHeader));
      await screen.findByText('120');

      expect(useSWR).toHaveBeenCalledWith(
        '/credits/balance',
        expect.any(Function),
        expect.objectContaining({
          refreshInterval: 60000,
          refreshWhenHidden: false,
          revalidateOnFocus: true,
        })
      );
    });

    it('asks the server once an agent run has ended, not while it runs', async () => {
      answers = () => reply(200, balance());
      mount(createElement(BalanceHeader));
      await screen.findByText('120');
      const before = balanceCalls();

      await act(async () => {
        refreshCreditBalanceAfterRun(true);
      });
      expect(balanceCalls()).toBe(before);

      await act(async () => {
        refreshCreditBalanceAfterRun(false);
      });
      await waitFor(() => expect(balanceCalls()).toBe(before + 1));
    });

    it('the agent chat hands that callback to the chat as onInProgress', () => {
      const source = readFileSync(
        join(__dirname, '../../agents/agent.chat.tsx'),
        'utf8'
      );

      expect(source).toContain('onInProgress={refreshCreditBalanceAfterRun}');
    });
  });

  describe('credits refusal', () => {
    it('recognises only the two credits codes of a 402', () => {
      expect(isCreditRefusal({ code: 'INSUFFICIENT_CREDITS' })).toBe(true);
      expect(isCreditRefusal({ code: 'AI_CAP_REACHED' })).toBe(true);
      expect(isCreditRefusal({ code: 'OTHER' })).toBe(false);
      expect(isCreditRefusal(null)).toBe(false);
    });

    it('INSUFFICIENT_CREDITS states what was needed and what is available', async () => {
      answers = () => reply(200, balance({ canTopUp: false }));
      mount(
        createElement(CreditRefusal, {
          refusal: { code: 'INSUFFICIENT_CREDITS', required: 12, available: 3 },
          onClose: () => {},
        })
      );

      await screen.findByText('This needs 12 credits and you have 3.');
    });

    it('AI_CAP_REACHED states the cap and what is used', async () => {
      answers = () => reply(200, balance({ canTopUp: false }));
      mount(
        createElement(CreditRefusal, {
          refusal: { code: 'AI_CAP_REACHED', cap: 25, used: 25 },
          onClose: () => {},
        })
      );

      await screen.findByText(
        'The free plan includes 25 AI credits a month and 25 are used.'
      );
    });

    it('offers the owner a top-up that shows the pack dialog', async () => {
      answers = () => reply(200, balance({ canTopUp: true }));
      mount(
        createElement(CreditRefusal, {
          refusal: { code: 'INSUFFICIENT_CREDITS', required: 5, available: 1 },
          onClose: () => {},
        })
      );

      fireEvent.click(await screen.findByText('Top up'));
      await screen.findByText('topup dialog');
    });

    it('offers a member who does not own the account no top-up', async () => {
      answers = () => reply(200, balance({ canTopUp: false }));
      mount(
        createElement(CreditRefusal, {
          refusal: { code: 'INSUFFICIENT_CREDITS', required: 5, available: 1 },
          onClose: () => {},
        })
      );

      await waitFor(() => expect(calls.length).toBeGreaterThan(0));
      // lets the balance answer reach the component before looking for the absent button
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await screen.findByText('Close');
      expect(screen.queryByText('Top up')).toBeNull();
    });
  });

  describe('ReservedList', () => {
    // A publish reservation of n credits for a post of channel i1, with the fields a test changes.
    const item = (n: number, over: Record<string, unknown> = {}) => ({
      ledgerId: `l${n}`,
      actionKey: 'post.publish',
      amount: n,
      createdAt: '2026-10-01T00:00:00.000Z',
      postId: `p${n}`,
      integrationId: 'i1',
      group: `g${n}`,
      occurrence: 1,
      publishDate: '2026-10-02T09:00:00.000Z',
      ...over,
    });

    it('lists each reservation with its channel, date and cost', async () => {
      answers = () =>
        reply(200, {
          items: [item(2), item(1, { integrationId: 'i2' })],
          nextCursor: null,
          otherWorkspacesReserved: 0,
        });
      mount(createElement(ReservedList));

      await screen.findByText('My Channel');
      expect(screen.getByText('Other Channel')).toBeTruthy();
      expect(screen.getByText('2 credits')).toBeTruthy();
      expect(screen.getByText('1 credits')).toBeTruthy();
      expect(screen.getAllByText('DATE')).toHaveLength(2);
    });

    it('says what other workspaces of the account hold, without listing them', async () => {
      answers = () =>
        reply(200, {
          items: [item(1)],
          nextCursor: null,
          otherWorkspacesReserved: 7,
        });
      mount(createElement(ReservedList));

      await screen.findByText(/more credits are reserved by your other workspaces/);
      expect(screen.getByText(/^7/)).toBeTruthy();
    });

    it('says nothing is reserved when the list is empty', async () => {
      answers = () =>
        reply(200, { items: [], nextCursor: null, otherWorkspacesReserved: 0 });
      mount(createElement(ReservedList));

      await screen.findByText('Nothing is reserved in this workspace.');
    });

    it('loads the next page with the cursor the server gave and appends it', async () => {
      answers = (path) =>
        path.includes('cursor=c1')
          ? reply(200, {
              items: [item(2, { integrationId: 'i2' })],
              nextCursor: null,
              otherWorkspacesReserved: 0,
            })
          : reply(200, {
              items: [item(1)],
              nextCursor: 'c1',
              otherWorkspacesReserved: 0,
            });
      mount(createElement(ReservedList));

      fireEvent.click(await screen.findByText('Load more'));

      await screen.findByText('Other Channel');
      expect(screen.getByText('My Channel')).toBeTruthy();
      expect(
        calls.some((c) => c.path === '/credits/reservations?cursor=c1')
      ).toBe(true);
      expect(screen.queryByText('Load more')).toBeNull();
    });

    it('shows a message, not an empty list, when the server cannot answer', async () => {
      answers = () => reply(500, { message: 'boom' });
      mount(createElement(ReservedList));

      await screen.findByText('Reserved credits could not be loaded.');
    });

    it('opens the post of an item by its group', async () => {
      answers = (path) =>
        path.startsWith('/posts/group/')
          ? reply(200, {
              posts: [{ publishDate: '2026-10-02T09:00:00.000Z' }],
              integration: 'i1',
              integrationPicture: '/p.png',
            })
          : reply(200, {
              items: [item(1)],
              nextCursor: null,
              otherWorkspacesReserved: 0,
            });
      mount(createElement(ReservedList));

      fireEvent.click(await screen.findByText('Open'));

      await waitFor(() => expect(opened).toHaveLength(1));
      expect(calls).toContainEqual({ path: '/posts/group/g1', method: 'GET' });
    });

    it('tells the user the post is gone, and opens nothing, when its group has no posts', async () => {
      answers = (path) =>
        path.startsWith('/posts/group/')
          ? reply(200, { posts: [] })
          : reply(200, {
              items: [item(1)],
              nextCursor: null,
              otherWorkspacesReserved: 0,
            });
      mount(createElement(ReservedList));

      fireEvent.click(await screen.findByText('Open'));

      await waitFor(() =>
        expect(toasts).toContainEqual(['Post not found', 'warning'])
      );
      expect(opened).toHaveLength(0);
    });

    it('a reservation that is not for a post has no Open button', async () => {
      answers = () =>
        reply(200, {
          items: [
            {
              ledgerId: 'l9',
              actionKey: 'ai.image',
              amount: 10,
              createdAt: '2026-10-01T00:00:00.000Z',
            },
          ],
          nextCursor: null,
          otherWorkspacesReserved: 0,
        });
      mount(createElement(ReservedList));

      await screen.findByText('ai.image');
      expect(screen.queryByText('Open')).toBeNull();
    });
  });
});
