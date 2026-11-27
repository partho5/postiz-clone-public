import { cookies, headers } from 'next/headers';
import { customFetch } from '@gitroom/helpers/utils/custom.fetch.func';

// Server side: the proxy puts the workspace of the requested /w/<id>/ URL in
// x-workspace-id; the cookie is only the fallback for unscoped pages.
export const internalFetch = async (url: string, options: RequestInit = {}) => {
  const cookieStore = await cookies();
  const workspaceId = (await headers()).get('x-workspace-id');
  return customFetch(
    { baseUrl: process.env.BACKEND_INTERNAL_URL! },
    cookieStore?.get('auth')?.value!,
    cookieStore?.get('showorg')?.value!
  )(url, {
    ...options,
    headers: {
      ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
      ...options.headers,
    },
  });
};
