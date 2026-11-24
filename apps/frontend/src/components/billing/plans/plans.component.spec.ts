/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// api.entitlements (E4), the plans page the mobile app's upgrade link opens (/billing?tier=<KEY>): the card the
// link names is highlighted and scrolled to, each card lists its app features, and once the plan is confirmed
// the page says the person may go back to the app (with a button on Android). Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' \
//     --transform '{"^.+\\.tsx?$":["ts-jest",{"isolatedModules":true,"tsconfig":{"jsx":"react-jsx","esModuleInterop":true}}]}' \
//     plans.component
import { createElement } from 'react';
import { SWRConfig } from 'swr';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// What the screen asks the backend, answered per test by `answers` (a promise lets a test hold an answer back).
const calls: Array<{ path: string; method: string; body?: any }> = [];
let answers: (path: string, method: string) => Response | Promise<Response>;
// The address the page was opened on.
let search = new URLSearchParams('');
// Where the screen sent the browser (PayPal's approval, the app), and where it sent the router.
const left: string[] = [];
const replaced: string[] = [];
// The cards scrolled into view, in order.
const scrolled: Element[] = [];

// One fetch for every render, as the real hook gives.
const fetchData = async (
  path: string,
  init?: { method?: string; body?: string }
) => {
  const method = init?.method ?? 'GET';
  calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
  return answers(path, method);
};
const t = (_key: string, fallback: string) => fallback;
const router = { replace: (path: string) => replaced.push(path) };
const idempotency = { key: () => 'key-1', reset: () => {} };

jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  // A fetch that records each call and answers it from `answers`.
  useFetch: () => fetchData,
}));
jest.mock('next/navigation', () => ({
  // The query of the page, the same object every render, as the real one.
  useSearchParams: () => search,
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
  '@gitroom/react/toaster/toaster',
  () => ({
    // The toaster the screen shows its messages through.
    useToaster: () => ({ show: () => {} }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/helpers/delete.dialog',
  () => ({
    // The cancel question, always answered yes.
    deleteDialog: async () => true,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/translation/get.transation.service.client',
  () => ({
    // Answers the English fallback of every key.
    useT: () => t,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/loading',
  () => ({
    // The loading mark.
    LoadingComponent: () => require('react').createElement('div', null, 'loading'),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/workspace.navigation',
  () => ({
    // A router that records where the screen sends the person; the same object every render, as the real one.
    useWorkspaceRouter: () => router,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/new-modal',
  () => ({
    // A modal manager; the credit pack dialog is not under test.
    useModals: () => ({ openModal: () => {} }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/layout/use.idempotency.key',
  () => ({
    // A fixed idempotency key; renewing it does nothing.
    useIdempotencyKey: () => idempotency,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/billing/topups/topup.dialog',
  () => ({
    // The credit pack dialog.
    TopupDialog: () => null,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/billing/plans/use.plans',
  () => jest.requireActual('./use.plans'),
  { virtual: true }
);

import { PlansComponent } from './plans.component';

const DONE = 'Done. You can go back to the app.';
const BACK = 'Back to the app';
const INTENT =
  'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.jovoc.facecampresentationrecorder;end';
const MARKER = 'billing:upgrade';

const FREE_FEATURES = ['crop_9_16', 'floating_cam', 'drawing_board', 'slide_ink', 'auto_publish'];
const STARTER_FEATURES = [...FREE_FEATURES, 'crop_4_5', 'crop_1_1', 'ai_captions'];
const PRO_FEATURES = [...STARTER_FEATURES, 'bg_replace', 'bg_custom'];

const tiers = [
  { key: 'STARTER', name: 'Starter', monthlyPriceCents: 900, currency: 'USD', monthlyCredits: 300, features: STARTER_FEATURES },
  { key: 'PRO', name: 'Pro', monthlyPriceCents: 2900, currency: 'USD', monthlyCredits: 1200, features: PRO_FEATURES },
  { key: 'AGENCY', name: 'Agency', monthlyPriceCents: 7900, currency: 'USD', monthlyCredits: 4000, features: PRO_FEATURES },
];

// The answer the backend gives, in the shape of the `Response` parts the screen reads (jsdom has none).
const reply = (status: number, body?: unknown) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    // Reads the body the test gave.
    json: async () => body,
  }) as unknown as Response;

const subscription = (status: string) => ({
  accountId: 'a1',
  provider: 'paypal',
  tierKey: 'PRO',
  status,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
});

// A backend with the given tiers; the confirm, subscribe and change answers are the test's.
const server =
  (state: {
    tiers?: object[];
    confirm?: Response | Promise<Response>;
    subscribe?: Response;
  }) =>
  (path: string, method: string) => {
    if (path === '/billing/plans' && method === 'GET') {
      return reply(200, { tiers: state.tiers ?? tiers, current: null });
    }
    if (path === '/billing/plans/confirm') {
      return state.confirm ?? reply(200, subscription('ACTIVE'));
    }
    if (path === '/billing/plans/subscribe') {
      return (
        state.subscribe ??
        reply(200, { approveUrl: 'https://paypal.test/approve', subscriptionId: 'I-1' })
      );
    }
    return reply(404);
  };

// Opens the page on an address, with a fresh SWR cache so no test sees another's data.
const open = (query: string) => {
  search = new URLSearchParams(query);
  return render(
    createElement(
      SWRConfig,
      {
        value: {
          // A new, empty cache per mount.
          provider: () => new Map(),
          dedupingInterval: 0,
        },
      },
      createElement(PlansComponent)
    )
  );
};

// The card of a tier, found by its name.
const card = (name: string) => screen.getByText(name).parentElement as HTMLElement;

// The text of the lines in a card's feature list.
const listed = (name: string) =>
  within(card(name))
    .queryAllByRole('listitem')
    .map((item) => item.textContent);

beforeEach(() => {
  calls.length = 0;
  left.length = 0;
  replaced.length = 0;
  scrolled.length = 0;
  answers = server({});
  window.sessionStorage.clear();
  // jsdom has no layout, so no scrolling; this records which card was brought into view.
  (window.HTMLElement.prototype as any).scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  // Records where the screen sends the browser instead of navigating.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...window.location,
      assign: (url: string) => left.push(url),
    },
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the card the link names', () => {
  it('is highlighted and brought into view, and no other card is', async () => {
    open('tier=PRO');

    await screen.findByText('Pro');

    expect(card('Pro').className).toContain('ring-btnPrimary');
    expect(card('Starter').className).not.toContain('ring-btnPrimary');
    expect(card('Agency').className).not.toContain('ring-btnPrimary');
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toBe(card('Pro'));
  });

  it('is found whatever the letter case of the tier in the address', async () => {
    open('tier=agency');

    await screen.findByText('Agency');

    expect(card('Agency').className).toContain('ring-btnPrimary');
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toBe(card('Agency'));
  });

  it('is none, and nothing scrolls, when the address names no tier or an unknown one', async () => {
    for (const query of ['', 'tier=', 'tier=platinum', 'tier=FREE']) {
      const view = open(query);
      await screen.findByText('Pro');

      for (const name of ['Starter', 'Pro', 'Agency']) {
        expect(card(name).className).not.toContain('ring-btnPrimary');
      }
      expect(scrolled).toEqual([]);
      view.unmount();
    }
  });
});

describe('the features on a card', () => {
  it('lists the features of the tier by name, in the order the server gives them', async () => {
    open('');
    await screen.findByText('Pro');

    expect(listed('Starter')).toEqual([
      'Vertical 9:16 crop',
      'Floating camera',
      'Drawing board',
      'Ink on slides',
      'Auto publish',
      '4:5 crop',
      'Square 1:1 crop',
      'AI captions',
    ]);
    expect(listed('Pro')).toEqual([...listed('Starter'), 'Background replace', 'Custom backgrounds']);
  });

  it('keeps a paid feature off the cards below the plan that unlocks it', async () => {
    open('');
    await screen.findByText('Pro');

    expect(within(card('Starter')).queryByText('Background replace')).toBeNull();
    expect(within(card('Pro')).getByText('Background replace')).toBeTruthy();
    expect(within(card('Agency')).getByText('Background replace')).toBeTruthy();
  });

  it('skips a feature the page has no name for, and shows no list for a tier with none', async () => {
    answers = server({
      tiers: [
        { ...tiers[0], features: ['crop_9_16', 'a_future_feature'] },
        { ...tiers[1], features: [] },
        { ...tiers[2], features: undefined },
      ],
    });
    open('');
    await screen.findByText('Pro');

    expect(listed('Starter')).toEqual(['Vertical 9:16 crop']);
    expect(listed('Pro')).toEqual([]);
    expect(listed('Agency')).toEqual([]);
  });
});

describe('the note that the person may go back to the app', () => {
  const confirmCalls = () => calls.filter((c) => c.path === '/billing/plans/confirm');

  it('shows after the plan is confirmed when the address carries ?tier=, and only then', async () => {
    let release!: (response: Response) => void;
    answers = server({ confirm: new Promise<Response>((resolve) => (release = resolve)) });
    open('subscription_id=I-1&tier=PRO');

    await screen.findByText('Pro');
    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(screen.queryByText(DONE)).toBeNull();

    release(reply(200, subscription('ACTIVE')));

    await screen.findByText(DONE);
    expect(confirmCalls()[0].body).toEqual({ subscriptionId: 'I-1' });
    expect(replaced).toEqual(['/billing']);
  });

  it('shows after the plan is confirmed when the page was left for PayPal from the app\'s link', async () => {
    window.sessionStorage.setItem(MARKER, String(Date.now() - 60 * 1000));
    open('subscription_id=I-1');

    await screen.findByText(DONE);
    expect(window.sessionStorage.getItem(MARKER)).toBeNull();
  });

  it('does not show for a trip that took longer than half an hour, and forgets it', async () => {
    window.sessionStorage.setItem(MARKER, String(Date.now() - 31 * 60 * 1000));
    open('subscription_id=I-1');

    await waitFor(() => expect(replaced).toEqual(['/billing']));
    expect(screen.queryByText(DONE)).toBeNull();
    expect(window.sessionStorage.getItem(MARKER)).toBeNull();
  });

  it('does not show for an ordinary return from PayPal, with no link and no marker', async () => {
    open('subscription_id=I-1');

    await waitFor(() => expect(replaced).toEqual(['/billing']));
    expect(screen.queryByText(DONE)).toBeNull();
  });

  it('does not show on the page itself, whatever the link or the marker: no confirm has happened', async () => {
    window.sessionStorage.setItem(MARKER, String(Date.now()));
    open('tier=PRO');

    await screen.findByText('Pro');
    expect(screen.queryByText(DONE)).toBeNull();
    expect(confirmCalls()).toHaveLength(0);
  });

  it('does not show when the confirm was refused, whatever the link or the marker', async () => {
    answers = server({
      confirm: reply(403, { code: 'NOT_ACCOUNT_OWNER', message: 'Only the account owner can manage the plan' }),
    });
    window.sessionStorage.setItem(MARKER, String(Date.now()));
    open('subscription_id=I-1&tier=PRO');

    await screen.findByText(
      'Only the account owner can manage the plan. Ask the owner to do it.'
    );
    await waitFor(() => expect(replaced).toEqual(['/billing']));
    expect(screen.queryByText(DONE)).toBeNull();
  });

  it('does not show when the confirm answered but the plan is not active yet', async () => {
    answers = server({ confirm: reply(200, subscription('APPROVAL_PENDING')) });
    open('subscription_id=I-1&tier=PRO');

    await waitFor(() => expect(replaced).toEqual(['/billing']));
    expect(screen.queryByText(DONE)).toBeNull();
  });

  it('never says pay or buy', async () => {
    open('subscription_id=I-1&tier=PRO');

    const note = (await screen.findByText(DONE)).parentElement!;

    expect(note.textContent).not.toMatch(/\b(pay|paid|payment|buy|bought|purchase)/i);
  });
});

describe('the record that the person left for PayPal from the app\'s link', () => {
  it('is written when the person subscribes from a page opened on ?tier=', async () => {
    open('tier=PRO');
    await screen.findByText('Pro');

    fireEvent.click(within(card('Pro')).getByText('Subscribe'));

    await waitFor(() => expect(left).toEqual(['https://paypal.test/approve']));
    expect(calls.find((c) => c.path === '/billing/plans/subscribe')!.body).toEqual({ tierKey: 'PRO' });
    expect(Date.now() - Number(window.sessionStorage.getItem(MARKER))).toBeLessThan(60 * 1000);
  });

  it('is not written when the page was opened without ?tier=', async () => {
    open('');
    await screen.findByText('Pro');

    fireEvent.click(within(card('Pro')).getByText('Subscribe'));

    await waitFor(() => expect(left).toEqual(['https://paypal.test/approve']));
    expect(window.sessionStorage.getItem(MARKER)).toBeNull();
  });

  it('is not written when the subscribe was refused', async () => {
    answers = server({ subscribe: reply(409, { code: 'ALREADY_SUBSCRIBED', message: 'Already subscribed' }) });
    open('tier=PRO');
    await screen.findByText('Pro');

    fireEvent.click(within(card('Pro')).getByText('Subscribe'));

    await screen.findByText('Already subscribed');
    expect(left).toEqual([]);
    expect(window.sessionStorage.getItem(MARKER)).toBeNull();
  });
});

describe('the button back to the app', () => {
  const android =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
  const desktop =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  it('is on the note on Android, and opens the app\'s launcher by its package, with no data', async () => {
    jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(android);
    open('subscription_id=I-1&tier=PRO');

    fireEvent.click(await screen.findByText(BACK));

    expect(left).toEqual([INTENT]);
    expect(INTENT).toContain('package=com.jovoc.facecampresentationrecorder');
    expect(INTENT).toContain('action=android.intent.action.MAIN');
    expect(INTENT).toContain('category=android.intent.category.LAUNCHER');
    expect(INTENT.startsWith('intent:#Intent;')).toBe(true);
  });

  it('is not shown on other platforms; the note is', async () => {
    jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(desktop);
    open('subscription_id=I-1&tier=PRO');

    await screen.findByText(DONE);

    expect(screen.queryByText(BACK)).toBeNull();
  });

  it('is not shown before the plan is confirmed, even on Android', async () => {
    jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(android);
    open('tier=PRO');

    await screen.findByText('Pro');

    expect(screen.queryByText(BACK)).toBeNull();
  });
});
