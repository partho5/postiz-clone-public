/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// Email one-time-code sign-in, the web screen: what the person types, what the two endpoints are
// asked, what the screen says to each answer, and that no password screen remains. Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' \
//     --transform '{"^.+\\.tsx?$":["ts-jest",{"isolatedModules":true,"tsconfig":{"jsx":"react-jsx","esModuleInterop":true}}]}' \
//     otp.sign.in
import { createElement } from 'react';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// What the screen asks the backend, answered per test by `answers`.
const calls: Array<{ path: string; method: string; body: any }> = [];
let answers: (path: string, body: any) => Response;
// The `afterRequest` the screen gave its own fetch wrapper.
let wrapperAfterRequest: (u: string, o: object, r: Response) => Promise<boolean>;
// Where the screen sent the browser, in order.
const left: string[] = [];
// The cookies the screen asked to set, as [name, value, days].
const cookies: Array<[string, string, number]> = [];
// Whether the instance runs over TLS (the access token then travels in a cookie the server sets).
let secured = true;
// The address saved for after sign-in, when a test has one.
let savedReturnUrl: string | null = null;

jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  // A fetch that records each call and answers it from `answers`.
  useFetch: () => async (path: string, init?: { method?: string; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init?.method ?? 'GET', body });
    return answers(path, body);
  },
  // Keeps the `afterRequest` the screen gives and renders what is inside.
  FetchWrapperComponent: (props: any) => {
    wrapperAfterRequest = props.afterRequest;
    return props.children;
  },
}));
jest.mock('next/navigation', () => ({
  // The query of the page; a provider sign-in coming back carries `provider` and `code`.
  useSearchParams: () => new URLSearchParams(''),
}));
jest.mock(
  '@gitroom/frontend/app/(app)/auth/return.url.component',
  () => ({
    // The return address saved before the sign-in page opened, read and cleared once.
    useReturnUrl: () => ({
      // Hands out the saved address, once.
      getAndClear: () => {
        const url = savedReturnUrl;
        savedReturnUrl = null;
        return url;
      },
    }),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/form/button',
  () => ({
    // A plain button standing in for the design-system one.
    Button: (props: any) =>
      createElement(
        'button',
        { type: props.type, onClick: props.onClick, disabled: props.disabled || props.loading },
        props.children
      ),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/form/input',
  () => ({
    // A plain input with its error line, standing in for the design-system one.
    Input: (props: any) =>
      createElement(
        'div',
        null,
        createElement('input', {
          'aria-label': props['aria-label'],
          type: props.type,
          inputMode: props.inputMode,
          autoComplete: props.autoComplete,
          maxLength: props.maxLength,
          value: props.value,
          onChange: props.onChange,
        }),
        createElement('div', { role: 'alert' }, props.error || '')
      ),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/translation/get.transation.service.client',
  () => ({
    // Answers the English fallback of every key, with its `{{name}}` filled in.
    useT: () => (_key: string, fallback: string, params?: Record<string, unknown>) =>
      fallback.replace(/{{(\w+)}}/g, (_m, name) => String(params?.[name])),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/helpers/variable.context',
  () => ({
    // A general instance with no provider configured, so only the form shows.
    useVariables: () => ({
      isGeneral: true,
      backendUrl: 'http://backend',
      neynarClientId: '',
      appleClientId: '',
      billingEnabled: false,
      genericOauth: false,
      isSecured: secured,
    }),
  }),
  { virtual: true }
);
// Every provider button renders nothing; provider sign-in is not under test.
for (const provider of ['google', 'github', 'oauth', 'apple', 'farcaster', 'wallet']) {
  jest.mock(
    `@gitroom/frontend/components/auth/providers/${provider}.provider`,
    () => {
      // A provider button that renders nothing.
      const button = () => null;
      return {
        GoogleProvider: button,
        GithubProvider: button,
        OauthProvider: button,
        AppleProvider: button,
        FarcasterProvider: button,
        default: button,
      };
    },
    { virtual: true }
  );
}
jest.mock(
  '@gitroom/frontend/components/layout/layout.context',
  () => ({
    // Records the cookies the screen asks the app's cookie writer to set.
    setCookie: (name: string, value: string, days: number) => cookies.push([name, value, days]),
  }),
  { virtual: true }
);
// Maps the app alias of the sign-in hook to its source for this spec.
jest.mock(
  '@gitroom/frontend/components/auth/otp/use.otp.sign.in',
  () => jest.requireActual('./use.otp.sign.in'),
  { virtual: true }
);

import { OtpSignIn } from './otp.sign.in';

// The answer the backend gives, in the shape of the `Response` parts the screen reads (jsdom has none).
const reply = (status: number, headers: Record<string, string> = {}, body?: unknown) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: {
      // Reads a header the test gave.
      get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
    // Reads the body the test gave.
    json: async () => body,
  }) as unknown as Response;

// The backend as it answers when all goes well: 204 for a code request, 200 for a right code.
const happy = (path: string) => (path === '/auth/otp/request' ? reply(204) : reply(200));

// Types into the field with the label.
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

// Presses the button with the text.
const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole('button', { name }));

// Lets the given number of seconds pass, one at a time as the clock would.
const tick = async (seconds: number) => {
  for (let i = 0; i < seconds; i++) {
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
  }
};

// Gets to the code step for an address, with the backend answering `answers`.
const toCodeStep = async (email = 'ana@example.com') => {
  render(createElement(OtpSignIn));
  type('Email', email);
  press('Send code');
  await screen.findByLabelText('Code');
};

beforeEach(() => {
  calls.length = 0;
  left.length = 0;
  cookies.length = 0;
  savedReturnUrl = null;
  secured = true;
  answers = happy;
  localStorage.clear();
  sessionStorage.clear();
  // Records where the screen sends the browser instead of navigating.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, replace: (url: string) => left.push(url), href: 'http://frontend/auth/login' },
  });
});

describe('the email step', () => {
  it('asks for a code for the typed address and moves to the code step', async () => {
    await toCodeStep('  Ana@Example.com ');

    expect(calls).toEqual([
      { path: '/auth/otp/request', method: 'POST', body: { email: 'Ana@Example.com' } },
    ]);
    expect(screen.getByText('ana@example.com', { exact: false })).toBeTruthy();
  });

  it('answers a malformed address with a field message and sends nothing', () => {
    render(createElement(OtpSignIn));
    type('Email', 'not-an-email');
    press('Send code');

    expect(screen.getByRole('alert').textContent).toBe('Enter a valid email address.');
    expect(calls).toEqual([]);
  });

  it('shows the send-failed line on a 503 and stays on the email step', async () => {
    answers = () => reply(503);
    render(createElement(OtpSignIn));
    type('Email', 'ana@example.com');
    press('Send code');

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe("We couldn't send the code. Try again.")
    );
    expect(screen.queryByLabelText('Code')).toBeNull();
  });

  it('reads the wait from Retry-After on a 429, counts it down and disables the controls until it ends', async () => {
    jest.useFakeTimers();
    try {
      answers = () => reply(429, { 'Retry-After': '3' });
      render(createElement(OtpSignIn));
      type('Email', 'ana@example.com');
      press('Send code');

      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('Too many attempts. Try again in 3 seconds.')
      );
      expect((screen.getByRole('button', { name: 'Send code' }) as HTMLButtonElement).disabled).toBe(true);

      // the line counts down with the clock, then goes when the wait ends
      await tick(1);
      expect(screen.getByRole('alert').textContent).toBe('Too many attempts. Try again in 2 seconds.');
      await tick(1);
      expect(screen.getByRole('alert').textContent).toBe('Too many attempts. Try again in 1 second.');
      expect((screen.getByRole('button', { name: 'Send code' }) as HTMLButtonElement).disabled).toBe(true);
      await tick(1);
      expect(screen.getByRole('alert').textContent).toBe('');
      expect((screen.getByRole('button', { name: 'Send code' }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the code step', () => {
  it('asks for a numeric keyboard and one-time-code autofill', async () => {
    await toCodeStep();

    const field = screen.getByLabelText('Code') as HTMLInputElement;
    expect(field.inputMode).toBe('numeric');
    expect(field.autocomplete).toBe('one-time-code');
  });

  it('puts no length cap on the field, so a browser keeps a pasted code with a space or separator whole', async () => {
    await toCodeStep();

    // a browser cuts a paste to `maxlength` before the screen can strip what is not a digit
    expect(screen.getByLabelText('Code').hasAttribute('maxlength')).toBe(false);
  });

  it('answers "Sign in" with fewer than six digits with a field message and asks for no sign-in', async () => {
    await toCodeStep();
    calls.length = 0;

    type('Code', '12345');
    press('Sign in');

    expect(screen.getByRole('alert').textContent).toBe('Enter the six-digit code.');
    expect(calls).toEqual([]);
    expect(left).toEqual([]);
  });

  it('signs in on the sixth digit without another click and leaves for the home page', async () => {
    await toCodeStep();
    calls.length = 0;

    type('Code', '12345');
    expect(calls).toEqual([]);
    type('Code', '123456');

    await waitFor(() => expect(left).toEqual(['/']));
    expect(calls).toEqual([
      {
        path: '/auth/token',
        method: 'POST',
        body: {
          grant_type: 'email_otp',
          email: 'ana@example.com',
          code: '123456',
          device_name: 'Web browser',
        },
      },
    ]);
  });

  it('fills the field from a pasted code and ignores what is not a digit', async () => {
    await toCodeStep();

    type('Code', ' 123-456 ');

    await waitFor(() => expect(left).toEqual(['/']));
    expect(calls[calls.length - 1].body.code).toBe('123456');
  });

  it('goes to the saved return address when there is one', async () => {
    await toCodeStep();
    savedReturnUrl = 'https://frontend/p/abc';

    type('Code', '123456');

    await waitFor(() => expect(left).toEqual(['https://frontend/p/abc']));
  });

  it('follows the onboarding header of a created account to the quick start', async () => {
    answers = (path) => (path === '/auth/otp/request' ? reply(204) : reply(200, { onboarding: 'true' }));
    await toCodeStep();

    type('Code', '123456');

    await waitFor(() => expect(left).toEqual(['/quick-start']));
  });

  it('answers a refused code with one generic line and stays on the code step with the email kept', async () => {
    answers = (path) => (path === '/auth/otp/request' ? reply(204) : reply(401, {}, { code: 'INVALID_GRANT' }));
    await toCodeStep();

    type('Code', '123456');

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        "That code didn't work. Check it or ask for a new one."
      )
    );
    expect(left).toEqual([]);
    expect(screen.getByText('ana@example.com', { exact: false })).toBeTruthy();
    expect(screen.getByLabelText('Code')).toBeTruthy();
  });

  it('reads the wait from Retry-After on a 429, counts it down and disables the controls until it ends', async () => {
    jest.useFakeTimers();
    try {
      answers = (path) => (path === '/auth/otp/request' ? reply(204) : reply(429, { 'Retry-After': '2' }));
      await toCodeStep();

      type('Code', '123456');

      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('Too many attempts. Try again in 2 seconds.')
      );
      expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: 'Send a new code' }) as HTMLButtonElement).disabled).toBe(true);

      await tick(1);
      expect(screen.getByRole('alert').textContent).toBe('Too many attempts. Try again in 1 second.');
      await tick(1);
      expect(screen.getByRole('alert').textContent).toBe('');
      expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByRole('button', { name: 'Send a new code' }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends a new code on "Send a new code", one request per click', async () => {
    await toCodeStep();
    calls.length = 0;

    press('Send a new code');

    await waitFor(() => expect(screen.getByText('We sent you a new code.')).toBeTruthy());
    expect(calls).toEqual([
      { path: '/auth/otp/request', method: 'POST', body: { email: 'ana@example.com' } },
    ]);
  });

  it('returns to the email step on "Use a different email", keeping the address to edit', async () => {
    await toCodeStep();

    press('Use a different email');

    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('ana@example.com');
    expect(screen.queryByLabelText('Code')).toBeNull();
  });
});

describe('what the screen keeps and says', () => {
  it('has no password input and sends no password', async () => {
    await toCodeStep();
    type('Code', '123456');
    await waitFor(() => expect(left).toEqual(['/']));

    expect(document.querySelector('input[type=password]')).toBeNull();
    expect(JSON.stringify(calls)).not.toMatch(/password/i);
  });

  it('writes neither the email nor the code to storage or the address bar', async () => {
    await toCodeStep();
    type('Code', '123456');
    await waitFor(() => expect(left).toEqual(['/']));

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).toBe('http://frontend/auth/login');
    expect(document.cookie).not.toMatch(/ana@example|123456/);
  });

  it('gives the same screen whether or not the address has an account', async () => {
    // the backend answers 204 either way; the screen has no other signal to show
    await toCodeStep('known@example.com');
    const known = document.body.innerHTML.replace('known@example.com', 'x');
    document.body.innerHTML = '';
    await toCodeStep('new@example.com');

    expect(document.body.innerHTML.replace('new@example.com', 'x')).toBe(known);
  });

  it('keeps the page on a 401 so a refused code is not a redirect', async () => {
    render(createElement(OtpSignIn));

    expect(await wrapperAfterRequest('/auth/token', {}, reply(401))).toBe(true);
    expect(left).toEqual([]);
  });

  it('stores the access token of the `auth` header as a cookie only without TLS', async () => {
    secured = false;
    render(createElement(OtpSignIn));
    await wrapperAfterRequest('/auth/token', {}, reply(200, { auth: 'token-1' }));
    expect(cookies).toEqual([['auth', 'token-1', 365]]);

    cookies.length = 0;
    secured = true;
    document.body.innerHTML = '';
    render(createElement(OtpSignIn));
    await wrapperAfterRequest('/auth/token', {}, reply(200, { auth: 'token-2' }));
    expect(cookies).toEqual([]);
  });
});

describe('the removed password screens', () => {
  const FRONTEND = join(__dirname, '../../../..');
  const REPO = join(FRONTEND, '../..');

  // Every source file under a folder, recursively.
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory()
        ? sourceFiles(path)
        : /\.(ts|tsx)$/.test(name)
          ? [path]
          : [];
    });

  it('has no register, forgot-password, reset-password or activation page or screen', () => {
    for (const gone of [
      'app/(app)/auth/forgot',
      'app/(app)/auth/activate',
      'components/auth/login.tsx',
      'components/auth/register.tsx',
      'components/auth/forgot.tsx',
      'components/auth/forgot-return.tsx',
      'components/auth/activate.tsx',
      'components/auth/after.activate.tsx',
    ]) {
      expect(existsSync(join(FRONTEND, 'src', gone))).toBe(false);
    }
  });

  it('has no password input anywhere in the web app', () => {
    const offenders = sourceFiles(join(FRONTEND, 'src')).filter(
      (file) =>
        !file.endsWith('.spec.ts') && /type=["'{`]+password/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  it('has no password request type left in the repo', () => {
    for (const gone of ['login.user', 'forgot.password', 'forgot-return.password']) {
      expect(existsSync(join(REPO, `libraries/nestjs-libraries/src/dtos/auth/${gone}.dto.ts`))).toBe(false);
    }
    const offenders = [
      ...sourceFiles(join(REPO, 'apps')),
      ...sourceFiles(join(REPO, 'libraries')),
    ].filter(
      (file) =>
        !file.includes('node_modules') &&
        !file.endsWith('.spec.ts') &&
        /\b(LoginUserDto|ForgotPasswordDto|ForgotReturnPasswordDto)\b/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
