// App pages live under /w/<workspaceId>/<page>. A tab's workspace is the one
// in its address bar, so tabs never share it through a cookie and two tabs
// can show two workspaces side by side. Switching workspace is a full page
// load, which drops every in-memory cache of the old one.

const WORKSPACE_PATH = /^\/w\/([0-9a-fA-F-]{36})(\/.*)?$/;

// Pages that belong to no workspace
const UNSCOPED = [
  '/auth',
  '/p/',
  '/provider/',
  '/integrations/social/',
  '/oauth',
  '/modal/',
  '/uploads/',
  '/terms',
  '/privacy',
  '/data-deletion',
  '/logout',
  '/api/',
  '/w/',
];

export const splitWorkspacePath = (pathname: string) => {
  const match = pathname.match(WORKSPACE_PATH);
  return match
    ? { workspaceId: match[1], path: match[2] || '/' }
    : { workspaceId: undefined, path: pathname };
};

export const currentWorkspaceId = () =>
  typeof window === 'undefined'
    ? undefined
    : splitWorkspacePath(window.location.pathname).workspaceId;

// Prefixes an app path with the workspace of this tab. Absolute URLs,
// unscoped pages and already prefixed paths pass through untouched.
export const workspacePath = (
  path: string,
  workspaceId = currentWorkspaceId()
) => {
  if (
    !workspaceId ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    UNSCOPED.some((p) => path.startsWith(p))
  ) {
    return path;
  }
  return `/w/${workspaceId}${path === '/' ? '' : path}`;
};

// The user this tab was rendered for. Sent with every request; if another
// tab has since signed in as someone else the server answers 409 and this
// tab reloads instead of acting as the new user on the old user's screen.
let tabUserId: string | undefined;
export const setTabUser = (id?: string) => {
  tabUserId = id;
};
export const getTabUser = () => tabUserId;
