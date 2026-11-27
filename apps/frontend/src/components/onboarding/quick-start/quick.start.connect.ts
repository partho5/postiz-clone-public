// Quick start: remembers, across the channel connect's round trip to the provider, that the
// connect began on quick start, so its return lands there instead of on the calendar.
const KEY = 'quick-start:connect';

// A connect that takes longer than this is not the one quick start began.
const MAX_AGE_MS = 30 * 60 * 1000;

// Records that a channel connect is starting from quick start.
export const markQuickStartConnect = () => {
  window.sessionStorage.setItem(KEY, String(Date.now()));
};

// Forgets the record: the person left quick start without finishing the connect.
export const clearQuickStartConnect = () => {
  window.sessionStorage.removeItem(KEY);
};

// True when the connect that just came back began on quick start; the record is cleared either way.
export const takeQuickStartConnect = () => {
  if (typeof window === 'undefined') {
    return false;
  }
  const startedAt = Number(window.sessionStorage.getItem(KEY));
  clearQuickStartConnect();
  return startedAt > 0 && Date.now() - startedAt <= MAX_AGE_MS;
};
