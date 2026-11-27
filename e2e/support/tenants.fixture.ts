// E2E fixtures: people and workspaces that each hold their own identifiable data (a channel and
// a scheduled post), so a test can tell whose data a screen or a browser store holds.
import { APIRequestContext } from '@playwright/test';
import { PrismaClient, Provider, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { signInWithCode } from './session.fixture';

export interface Person {
  id: string;
  email: string;
}

export interface Workspace {
  id: string;
  name: string;
  channel: string;
  post: string;
}

export interface Tenant {
  person: Person;
  workspace: Workspace;
}

// A marker no other test or run can produce
export const uniqueMarker = (label: string) =>
  `e2e-${label}-${randomBytes(5).toString('hex')}`;

// Every string that identifies a person or one of their workspaces
export const markersOf = (person: Person, ...workspaces: Workspace[]) => [
  person.id,
  person.email,
  ...workspaces.flatMap((w) => [w.id, w.name, w.channel, w.post]),
];

// A publish time on today's date, so the default calendar view shows the post
const todayPublishDate = () => {
  const now = Date.now();
  const later = new Date(now + 10 * 60 * 1000);
  return later.getUTCDate() === new Date(now).getUTCDate()
    ? later
    : new Date(now - 10 * 60 * 1000);
};

// Gives a workspace one channel and one scheduled post, both named after the workspace
export const seedWorkspaceData = async (
  db: PrismaClient,
  workspaceId: string,
  name: string
): Promise<Workspace> => {
  const channel = await db.integration.create({
    data: {
      organizationId: workspaceId,
      internalId: `${name}-channel`,
      name: `${name}-channel`,
      picture: '/no-picture.jpg',
      providerIdentifier: 'bluesky',
      type: 'social',
      token: `${name}-token`,
    },
  });
  const post = await db.post.create({
    data: {
      organizationId: workspaceId,
      integrationId: channel.id,
      group: `${name}-group`,
      content: `<p>${name}-post</p>`,
      publishDate: todayPublishDate(),
    },
  });
  return {
    id: workspaceId,
    name,
    channel: channel.name,
    post: post.content.replace(/<\/?p>/g, ''),
  };
};

// Signs a new person up through the backend's one-time-code sign-in; the sign-up creates their first
// workspace, which is then given its own channel and post
export const signUp = async (
  request: APIRequestContext,
  db: PrismaClient,
  backendUrl: string,
  label: string
): Promise<Tenant> => {
  const name = uniqueMarker(label);
  const person = { email: `${name}@e2e.test` };
  await signInWithCode(request, backendUrl, person.email);
  const user = await db.user.findUniqueOrThrow({
    where: {
      email_providerName: { email: person.email, providerName: Provider.LOCAL },
    },
    include: { organizations: true },
  });
  return {
    person: { id: user.id, ...person },
    workspace: await seedWorkspaceData(
      db,
      user.organizations[0].organizationId,
      name
    ),
  };
};

// Creates another workspace owned by the person, attached to their account as the create path
// does, and gives it its own channel and post
export const addWorkspace = async (
  db: PrismaClient,
  person: Person,
  label: string
): Promise<Workspace> => {
  const name = uniqueMarker(label);
  const first = await db.userOrganization.findFirstOrThrow({
    where: { userId: person.id },
    include: { organization: true },
    orderBy: { createdAt: 'asc' },
  });
  const workspace = await db.organization.create({
    data: {
      name,
      accountId: first.organization.accountId,
      users: { create: { userId: person.id, role: Role.SUPERADMIN } },
    },
  });
  return seedWorkspaceData(db, workspace.id, name);
};
