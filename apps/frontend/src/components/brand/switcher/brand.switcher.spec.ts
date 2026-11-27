/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// Brand switcher: the header badge shows the brand's colour and avatar, Ctrl+K opens a palette of the
// user's brands that filters as typed and moves with a full page load, and the editor keeps its own Ctrl+K.
// The badge is a button that opens the palette, whose open state the layout holds (the tests use a small harness).
// Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' \
//     --transform '{"^.+\\.tsx?$":["ts-jest",{"isolatedModules":true,"tsconfig":{"jsx":"react-jsx","esModuleInterop":true}}]}' \
//     brand.switcher
import { createElement, useState } from 'react';
import { mutate, SWRConfig } from 'swr';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// What the screens ask the backend, answered per test by `answers`.
const calls: string[] = [];
let answers: (path: string) => Response;
// The modals the palette asked to open.
const opened: any[] = [];
// The props of each "New brand" dialog that was rendered, in order.
const dialogs: any[] = [];
// Where the palette sent the browser, in order.
const left: string[] = [];
// The workspace this tab is in, and the path, query and hash it shows.
let currentId = '';
let pathname = '/';
let search = '';
let hash = '';
// What the palette did, in order: `post <path> <body>` for each write it sent, `assign <url>` for each page load.
const steps: string[] = [];

jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  // A fetch that records each path and answers it from `answers`.
  useFetch: () => async (path: string, init?: RequestInit) => {
    calls.push(path);
    if (init?.method === 'POST') {
      steps.push(`post ${path} ${init.body}`);
    }
    return answers(path);
  },
}));
// The brand modules the screens import by the frontend alias, which this jest config does not map:
// each resolves to its real file.
jest.mock(
  '@gitroom/frontend/components/brand/profile/use.current.brand',
  () => jest.requireActual('../profile/use.current.brand'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/brand/switcher/brand.avatar',
  () => jest.requireActual('./brand.avatar'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/brand/switcher/use.switcher.brands',
  () => jest.requireActual('./use.switcher.brands'),
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
    // The workspace of the tab, set by the test.
    useWorkspaceId: () => currentId,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/brand/profile/new.brand.dialog',
  () => ({
    // A marker for the "New brand" dialog that keeps the props it was given.
    NewBrandDialog: (props: any) => {
      dialogs.push(props);
      return require('react').createElement('div', null, 'new brand dialog');
    },
  }),
  { virtual: true }
);

import { BrandBadge } from './brand.badge';
import { BrandSwitcher } from './brand.switcher';

const ACME = '11111111-1111-4111-8111-111111111111';
const BETA = '22222222-2222-4222-8222-222222222222';
const GAMMA = '33333333-3333-4333-8333-333333333333';

// The answer the backend gives, in the shape of the `Response` parts the hooks read (jsdom has none).
const reply = (status: number, body?: unknown) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    // Reads the body the test gave.
    json: async () => body,
  }) as unknown as Response;

// A brand summary with the fields a test changes.
const summary = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  slug: name.toLowerCase().replace(/\s+/g, '-'),
  color: '#112233',
  avatarUrl: null,
  ...over,
});

const BRANDS = [
  summary(ACME, 'Acme Studio'),
  summary(BETA, 'Beta Labs', { color: '#aa0000' }),
  summary(GAMMA, 'Gamma Shop', { avatarUrl: 'https://cdn.example/gamma.png' }),
];

// What the layout does for the palette: holds the open state and passes it down with the open and close calls.
const Harness = ({ startOpen = false }: { startOpen?: boolean }) => {
  const [isOpen, setIsOpen] = useState(startOpen);
  return createElement(BrandSwitcher, {
    isOpen,
    onOpen: () => setIsOpen(true),
    onClose: () => setIsOpen(false),
  });
};

// Mounts a component with no deduping, so an answer is never taken from an earlier test.
const mount = (element: ReturnType<typeof createElement>) =>
  render(
    createElement(SWRConfig, { value: { dedupingInterval: 0 } }, element)
  );

// Presses Ctrl+K (or Cmd+K) on an element, the way the browser delivers it to the window.
const shortcut = (
  target: Element = document.body,
  init: KeyboardEventInit = { ctrlKey: true }
) => fireEvent.keyDown(target, { key: 'k', ...init });

// Opens the palette over the three brands and waits until they are listed.
const openPalette = async () => {
  mount(createElement(Harness));
  shortcut();
  await screen.findByText('Acme Studio');
};

beforeEach(async () => {
  calls.length = 0;
  opened.length = 0;
  dialogs.length = 0;
  left.length = 0;
  steps.length = 0;
  currentId = ACME;
  pathname = '/';
  search = '';
  hash = '';
  answers = (path) =>
    path === '/brands' ? reply(200, BRANDS) : reply(404, undefined);
  document.head.querySelectorAll('link[rel="prefetch"]').forEach((l) => l.remove());
  // SWR skips the first fetch of a mount while a request for its key is still tracked, and it drops
  // that request one timer after the answer; the previous test may have ended right after its fetch
  await new Promise((resolve) => setTimeout(resolve, 20));
  await mutate(() => true, undefined, { revalidate: false });
  // Records where the palette sends the browser instead of navigating.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...window.location,
      // The path of the page the palette was opened on, set by the test.
      get pathname() {
        return pathname;
      },
      // The query and hash of the page, set by the test.
      get search() {
        return search;
      },
      get hash() {
        return hash;
      },
      // Notes the page load in `left` and in the order of `steps`.
      assign: (url: string) => {
        left.push(url);
        steps.push(`assign ${url}`);
      },
    },
  });
});

describe('BrandBadge', () => {
  it('shows the name and picture of the brand the server reports for this workspace', async () => {
    answers = () =>
      reply(200, { ...BRANDS[2], timezone: 'UTC', locale: 'en', profile: {} });
    mount(createElement(BrandBadge, { onClick: () => undefined }));

    expect(await screen.findByText('Gamma Shop')).toBeTruthy();
    expect(calls).toEqual(['/brands/current']);
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.example/gamma.png'
    );
  });

  it('shows the initials on the brand colour when the brand has no avatar', async () => {
    answers = () => reply(200, { ...BRANDS[1] });
    mount(createElement(BrandBadge, { onClick: () => undefined }));

    const initials = await screen.findByText('BL');
    expect((initials as HTMLElement).style.backgroundColor).toBe('rgb(170, 0, 0)');
    expect(document.querySelector('img')).toBeNull();
  });

  it('draws an accent in the brand colour', async () => {
    answers = () => reply(200, { ...BRANDS[1] });
    mount(createElement(BrandBadge, { onClick: () => undefined }));

    const name = await screen.findByText('Beta Labs');
    const badge = name.parentElement as HTMLElement;
    // jsdom keeps the colour as written or as rgb(), by version
    expect(badge.style.borderBottomColor).toMatch(
      /^(#aa0000|rgb(170, 0, 0))$/
    );
  });

  it('shows nothing when the server refuses the brand', async () => {
    answers = () => reply(403, undefined);
    const view = mount(createElement(BrandBadge, { onClick: () => undefined }));

    await waitFor(() => expect(calls).toEqual(['/brands/current']));
    expect(view.container.textContent).toBe('');
  });

  it('is a button labelled Switch brand that calls onClick when clicked', async () => {
    answers = () => reply(200, { ...BRANDS[1] });
    const onClick = jest.fn();
    mount(createElement(BrandBadge, { onClick }));

    const button = await screen.findByRole('button', { name: 'Switch brand' });
    expect(button.getAttribute('title')).toBe('Switch brand (Ctrl+K)');
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the avatar and the label but drops the name when compact', async () => {
    answers = () => reply(200, { ...BRANDS[1] });
    const onClick = jest.fn();
    mount(createElement(BrandBadge, { onClick, compact: true }));

    const button = await screen.findByRole('button', { name: 'Switch brand' });
    expect(screen.getByText('BL')).toBeTruthy();
    expect(screen.queryByText('Beta Labs')).toBeNull();
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('BrandSwitcher', () => {
  it('stays closed and asks for nothing until the shortcut is pressed', async () => {
    mount(createElement(Harness));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('opens on Ctrl+K and lists the brands the server returns, marking the current one', async () => {
    await openPalette();

    expect(calls).toEqual(['/brands']);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Beta Labs')).toBeTruthy();
    expect(screen.getByText('Gamma Shop')).toBeTruthy();
    expect(screen.getAllByText('Current')).toHaveLength(1);
    expect(screen.getByText('Acme Studio').parentElement?.textContent).toContain(
      'Current'
    );
  });

  it('is open while the layout says so, as when the badge was clicked, and lists the brands', async () => {
    mount(createElement(Harness, { startOpen: true }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(await screen.findByText('Beta Labs')).toBeTruthy();
    expect(calls).toEqual(['/brands']);
  });

  it('opens on Cmd+K as well', async () => {
    mount(createElement(Harness));
    shortcut(document.body, { metaKey: true });

    expect(await screen.findByText('Beta Labs')).toBeTruthy();
  });

  it('opens from a plain text field and keeps the browser from taking the key', async () => {
    mount(createElement(Harness));
    const field = document.body.appendChild(document.createElement('input'));

    const notPrevented = shortcut(field);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(notPrevented).toBe(false);
    field.remove();
  });

  it('does nothing while focus is in the editor, which uses Ctrl+K for its link', async () => {
    mount(createElement(Harness));
    const editor = document.body.appendChild(document.createElement('div'));
    editor.setAttribute('contenteditable', 'true');
    const inner = editor.appendChild(document.createElement('p'));

    shortcut(inner);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toEqual([]);
    editor.remove();
  });

  it('filters the brands as the user types, by name', async () => {
    await openPalette();

    fireEvent.change(screen.getByLabelText('Search brands…'), {
      target: { value: 'gam' },
    });

    expect(screen.queryByText('Acme Studio')).toBeNull();
    expect(screen.queryByText('Beta Labs')).toBeNull();
    expect(screen.getByText('Gamma Shop')).toBeTruthy();
  });

  it('moves to the highlighted brand with a full page load of its calendar on Enter', async () => {
    await openPalette();
    const input = screen.getByLabelText('Search brands…');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(left).toEqual([`/w/${BETA}/launches`]));
  });

  it('moves with the arrow keys in both directions and wraps around', async () => {
    await openPalette();
    const input = screen.getByLabelText('Search brands…');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(left).toEqual([`/w/${BETA}/launches`]));
  });

  it('moves to a brand that is clicked', async () => {
    await openPalette();

    fireEvent.click(screen.getByText('Gamma Shop'));

    await waitFor(() => expect(left).toEqual([`/w/${GAMMA}/launches`]));
  });

  it('saves the brand as the default before the page load', async () => {
    await openPalette();

    fireEvent.click(screen.getByText('Beta Labs'));

    await waitFor(() => expect(left).toHaveLength(1));
    expect(steps).toEqual([
      `post /user/change-org ${JSON.stringify({ id: BETA })}`,
      `assign /w/${BETA}/launches`,
    ]);
  });

  it('still moves when saving the default fails, by an error or by a refusal', async () => {
    answers = (path) => {
      if (path === '/brands') {
        return reply(200, BRANDS);
      }
      throw new Error('network down');
    };
    await openPalette();
    fireEvent.click(screen.getByText('Beta Labs'));
    await waitFor(() => expect(left).toEqual([`/w/${BETA}/launches`]));

    cleanup();
    left.length = 0;
    answers = (path) =>
      path === '/brands' ? reply(200, BRANDS) : reply(500, undefined);
    await openPalette();
    fireEvent.click(screen.getByText('Gamma Shop'));
    await waitFor(() => expect(left).toEqual([`/w/${GAMMA}/launches`]));
  });

  it('lands on the same section of the chosen brand', async () => {
    pathname = `/w/${ACME}/analytics`;
    await openPalette();

    fireEvent.click(screen.getByText('Beta Labs'));

    await waitFor(() => expect(left).toEqual([`/w/${BETA}/analytics`]));
  });

  it('lands on the root of the section when the page is an item of it', async () => {
    pathname = `/w/${ACME}/agents/44444444-4444-4444-8444-444444444444`;
    await openPalette();

    fireEvent.click(screen.getByText('Beta Labs'));

    await waitFor(() => expect(left).toEqual([`/w/${BETA}/agents`]));
  });

  it('drops the query string and anything after the section root', async () => {
    pathname = `/w/${ACME}/billing/topup-return`;
    search = '?token=x';
    hash = '#h';
    await openPalette();

    fireEvent.click(screen.getByText('Beta Labs'));

    await waitFor(() => expect(left).toEqual([`/w/${BETA}/billing`]));
  });

  it('lands on the calendar when the page is not a known section', async () => {
    pathname = `/w/${ACME}/something-else/1`;
    await openPalette();

    fireEvent.click(screen.getByText('Beta Labs'));

    await waitFor(() => expect(left).toEqual([`/w/${BETA}/launches`]));
  });

  it('does not take a section for a page that only starts with its name', async () => {
    pathname = `/w/${ACME}/analytics-old`;
    await openPalette();

    fireEvent.click(screen.getByText('Beta Labs'));

    await waitFor(() => expect(left).toEqual([`/w/${BETA}/launches`]));
  });

  it('shows Switching… on the chosen brand and ignores a second choice', async () => {
    await openPalette();
    const input = screen.getByLabelText('Search brands…');

    fireEvent.click(screen.getByText('Beta Labs'));
    fireEvent.click(screen.getByText('Gamma Shop'));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(left).toHaveLength(1));
    expect(screen.getByText('Beta Labs').parentElement?.textContent).toContain(
      'Switching…'
    );
    expect(screen.getAllByText('Switching…')).toHaveLength(1);
    expect(steps.filter((step) => step.startsWith('post'))).toHaveLength(1);
    expect(left).toEqual([`/w/${BETA}/launches`]);
  });

  it('does not open New brand once a brand is being switched to', async () => {
    await openPalette();

    fireEvent.click(screen.getByText('Beta Labs'));
    fireEvent.click(screen.getByText('New brand'));

    await waitFor(() => expect(left).toHaveLength(1));
    expect(opened).toEqual([]);
  });

  it('only closes when the current brand is chosen', async () => {
    await openPalette();

    fireEvent.keyDown(screen.getByLabelText('Search brands…'), { key: 'Enter' });

    expect(left).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape without moving', async () => {
    await openPalette();

    fireEvent.keyDown(screen.getByLabelText('Search brands…'), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(left).toEqual([]);
  });

  it('prefetches the page of a highlighted brand once, and never the current brand', async () => {
    await openPalette();

    fireEvent.mouseEnter(screen.getByText('Beta Labs'));
    fireEvent.mouseEnter(screen.getByText('Acme Studio'));
    fireEvent.mouseEnter(screen.getByText('Beta Labs'));

    const hrefs = Array.from(
      document.head.querySelectorAll('link[rel="prefetch"]')
    ).map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([`/w/${BETA}/launches`]);
  });

  it('prefetches the same page the switch lands on', async () => {
    pathname = `/w/${ACME}/analytics`;
    await openPalette();

    fireEvent.mouseEnter(screen.getByText('Beta Labs'));
    const hrefs = Array.from(
      document.head.querySelectorAll('link[rel="prefetch"]')
    ).map((link) => link.getAttribute('href'));
    fireEvent.click(screen.getByText('Beta Labs'));

    await waitFor(() => expect(left).toHaveLength(1));
    expect(hrefs).toEqual([left[0]]);
    expect(left).toEqual([`/w/${BETA}/analytics`]);
  });

  it('opens the New brand dialog from its entry and closes the palette', async () => {
    await openPalette();

    fireEvent.click(screen.getByText('New brand'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opened).toHaveLength(1);
    expect(opened[0].title).toBe('New brand');

    // The modal's content is the brand profile dialog, closed through the modal's own `done`.
    const done = jest.fn();
    render(opened[0].children(done));
    expect(screen.getByText('new brand dialog')).toBeTruthy();
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].onClose).toBe(done);
  });

  it('keeps New brand available when the brands could not be loaded', async () => {
    answers = () => reply(500, undefined);
    mount(createElement(Harness));
    shortcut();

    expect(await screen.findByText('Failed to load your brands')).toBeTruthy();
    expect(screen.getByText('New brand')).toBeTruthy();
  });

  it('closes on the shortcut when it is open', async () => {
    await openPalette();

    shortcut(screen.getByLabelText('Search brands…'));

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
