'use client';

import React, { ComponentProps, forwardRef, useEffect, useMemo } from 'react';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import {
  setTabUser,
  splitWorkspacePath,
  workspacePath,
} from '@gitroom/helpers/utils/workspace.path';

// The workspace this tab renders. The server resolves it from the URL (or,
// on an unscoped URL, picks the default) and returns it as user.orgId.
export const useWorkspaceId = () => useUser()?.orgId;

// Current page without the /w/<id> prefix, for menus and titles
export const useWorkspacePathname = () =>
  splitWorkspacePath(usePathname() || '/').path;

export const useWorkspaceRouter = () => {
  const router = useRouter();
  const workspaceId = useWorkspaceId();
  return useMemo(
    () => ({
      ...router,
      push: (href: string, options?: Parameters<typeof router.push>[1]) =>
        router.push(workspacePath(href, workspaceId), options),
      replace: (href: string, options?: Parameters<typeof router.replace>[1]) =>
        router.replace(workspacePath(href, workspaceId), options),
      prefetch: (href: string) =>
        router.prefetch(workspacePath(href, workspaceId)),
    }),
    [router, workspaceId]
  );
};

export const WorkspaceLink = forwardRef<
  HTMLAnchorElement,
  ComponentProps<typeof NextLink>
>(({ href, ...props }, ref) => {
  const workspaceId = useWorkspaceId();
  return (
    <NextLink
      ref={ref}
      href={typeof href === 'string' ? workspacePath(href, workspaceId) : href}
      {...props}
    />
  );
});
WorkspaceLink.displayName = 'WorkspaceLink';

// Keys that describe the device, not the person: they survive a user change
const DEVICE_KEYS = [
  'mode',
  'timezone',
  'isUS',
  'landingUrl',
  'referrer',
  'returnUrl',
  'session-user',
];

// Drops everything the previous user may have left in this browser
export const wipeSessionData = async () => {
  try {
    Object.keys(localStorage)
      .filter((key) => !DEVICE_KEYS.includes(key))
      .forEach((key) => localStorage.removeItem(key));
    sessionStorage.clear();
  } catch (e) {}
  try {
    if ('caches' in window) {
      for (const key of await caches.keys()) {
        await caches.delete(key);
      }
    }
  } catch (e) {}
};

type AuthMessage = { type: 'session'; userId: string } | { type: 'logout' };

export const broadcastAuth = (message: AuthMessage) => {
  try {
    const channel = new BroadcastChannel('auth');
    channel.postMessage(message);
    channel.close();
  } catch (e) {}
};

// Once the signed-in user is known:
// - every request of this tab carries x-session-user
// - data left behind by another user is wiped
// - other tabs of another user reload, and this tab reloads on logout or
//   when another user signs in elsewhere
// - an unscoped URL is rewritten in place to /w/<workspace>/...
export const useWorkspaceSession = (user?: { id: string; orgId: string }) => {
  useEffect(() => {
    if (!user?.id) {
      return;
    }
    setTabUser(user.id);

    let previous: string | null = null;
    try {
      previous = localStorage.getItem('session-user');
    } catch (e) {}
    if (previous !== user.id) {
      wipeSessionData();
      try {
        localStorage.setItem('session-user', user.id);
      } catch (e) {}
    }

    const { workspaceId, path } = splitWorkspacePath(window.location.pathname);
    if (!workspaceId && user.orgId) {
      window.history.replaceState(
        window.history.state,
        '',
        workspacePath(path, user.orgId) +
          window.location.search +
          window.location.hash
      );
    }

    broadcastAuth({ type: 'session', userId: user.id });

    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel('auth');
    } catch (e) {
      return;
    }
    channel.onmessage = (event: MessageEvent<AuthMessage>) => {
      if (
        event.data?.type === 'logout' ||
        (event.data?.type === 'session' && event.data.userId !== user.id)
      ) {
        window.location.href = '/';
      }
    };
    return () => channel.close();
  }, [user?.id, user?.orgId]);
};
