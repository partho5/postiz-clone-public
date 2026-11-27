/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// api.entitlements (E4), the return address the sign-in page saves (the upgrade link's /billing?tier=<KEY> for a
// signed-out visitor): only a web address of this site is saved and used after signing in, so the page cannot
// be made to send a person to another site, or to run a script. Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' \
//     --transform '{"^.+\\.tsx?$":["ts-jest",{"isolatedModules":true,"tsconfig":{"jsx":"react-jsx","esModuleInterop":true}}]}' \
//     return.url.component
import { createElement } from 'react';
import { render, renderHook } from '@testing-library/react';

// The query of the sign-in page.
let search = new URLSearchParams('');

jest.mock('next/navigation', () => ({
  // The query of the page, as the real hook gives it.
  useSearchParams: () => search,
}));

import ReturnUrlComponent, { useReturnUrl } from './return.url.component';

// The host the specs run on (jsdom's default address).
const HOME = `http://${window.location.host}`;

// Opens the sign-in page on a return address, which saves it when it is one to keep.
const openWith = (returnUrl: string) => {
  search = new URLSearchParams({ returnUrl });
  render(createElement(ReturnUrlComponent));
};

// What the sign-in uses to leave: the saved address, once.
const taken = () => renderHook(() => useReturnUrl()).result.current.getAndClear();

beforeEach(() => {
  window.localStorage.clear();
  search = new URLSearchParams('');
});

describe('the return address of the sign-in page', () => {
  it('saves an address of this site, query string and all, and hands it out once', () => {
    openWith(`${HOME}/billing?tier=PRO`);

    expect(window.localStorage.getItem('returnUrl')).toBe(`${HOME}/billing?tier=PRO`);
    expect(taken()).toBe(`${HOME}/billing?tier=PRO`);
    expect(window.localStorage.getItem('returnUrl')).toBeNull();
    expect(taken()).toBeNull();
  });

  it('does not save the address of another site or a script, and has none to hand out', () => {
    for (const returnUrl of [
      'https://evil.example/billing?tier=PRO',
      'http://evil.example',
      `https://${window.location.hostname}.evil.example/x`,
      '//evil.example/x',
      'javascript:alert(1)//http',
      '/billing?tier=PRO',
      'http',
    ]) {
      window.localStorage.clear();
      openWith(returnUrl);

      expect(window.localStorage.getItem('returnUrl')).toBeNull();
      expect(taken()).toBeNull();
    }
  });

  it('does not use an address of another site that was saved before, and forgets it', () => {
    window.localStorage.setItem('returnUrl', 'https://evil.example/billing?tier=PRO');

    expect(taken()).toBeNull();
    expect(window.localStorage.getItem('returnUrl')).toBeNull();
  });

  it('saves nothing when the page has no return address', () => {
    render(createElement(ReturnUrlComponent));

    expect(window.localStorage.getItem('returnUrl')).toBeNull();
  });
});
