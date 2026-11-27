'use client';

// Idempotency-Key: one key per user intent, kept across retries until the intent is done.
import { useCallback, useMemo, useRef } from 'react';
import { newIdempotencyKey } from '@gitroom/helpers/utils/custom.fetch.func';

// `key(intent)` is the key for the intent described by the string (the same string answers the
// same key, another string starts a new intent); `reset()` ends the intent so the next attempt is new.
export const useIdempotencyKey = () => {
  const held = useRef<{ intent: string; key: string } | undefined>(undefined);

  const key = useCallback((intent: string = '') => {
    if (held.current?.intent !== intent) {
      held.current = { intent, key: newIdempotencyKey() };
    }
    return held.current.key;
  }, []);

  const reset = useCallback(() => {
    held.current = undefined;
  }, []);

  return useMemo(() => ({ key, reset }), [key, reset]);
};
