// Scoped API keys: the scopes a key can hold, shared by the server and the API keys screen.
export const API_SCOPES = [
  'posts:read',
  'posts:write',
  'media:write',
  'channels:read',
  'channels:write',
  'ai:use',
  'account:read',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
