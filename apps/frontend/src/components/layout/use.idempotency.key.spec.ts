/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// Idempotency-Key, intent-holding UIs: useIdempotencyKey keeps one key per intent across
// retries and a fresh one after reset(). Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' use.idempotency.key
import { renderHook } from '@testing-library/react';
// relative: the jest config maps no @gitroom/frontend alias
import { useIdempotencyKey } from './use.idempotency.key';

jest.mock('@gitroom/helpers/utils/custom.fetch.func', () => {
  let n = 0;
  return { newIdempotencyKey: () => `key-${++n}` };
});

describe('useIdempotencyKey', () => {
  it('answers the same key for the same intent, across renders', () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey());
    const first = result.current.key('pay-10');
    rerender();
    expect(result.current.key('pay-10')).toBe(first);
    expect(result.current.key('pay-10')).toBe(first);
  });

  it('starts a new key when the intent changes', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const a = result.current.key('pay-10');
    const b = result.current.key('pay-20');
    expect(b).not.toBe(a);
    expect(result.current.key('pay-20')).toBe(b);
  });

  it('answers a fresh key after reset()', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const first = result.current.key('pay-10');
    result.current.reset();
    expect(result.current.key('pay-10')).not.toBe(first);
  });

  it('keeps separate keys for separate components', () => {
    const a = renderHook(() => useIdempotencyKey()).result.current.key('x');
    const b = renderHook(() => useIdempotencyKey()).result.current.key('x');
    expect(a).not.toBe(b);
  });

  it('returns stable functions, so a callback depending on them is not rebuilt', () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey());
    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });
});
