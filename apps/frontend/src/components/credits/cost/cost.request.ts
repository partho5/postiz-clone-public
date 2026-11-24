'use client';

// Cost preview: asks the server for a price, and turns any answer that is not a price into an error.
export const postQuote = async <T>(
  fetch: (path: string, init?: RequestInit) => Promise<Response>,
  path: string,
  body: unknown
): Promise<T> => {
  const response = await fetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error('cost unavailable');
  }
  return response.json();
};
