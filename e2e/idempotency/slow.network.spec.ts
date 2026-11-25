// Retried mutations on a bad network: in a browser on Slow 3G, a mutation whose response is
// lost is sent again with the same Idempotency-Key and gets the first answer back, so the retry never
// duplicates a brand, a post or a charge. The response is dropped after the backend has processed the
// request, which is what a lost response is.
import { CDPSession, Page, Route } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { test, expect } from '../support/test.fixture';
import { signUp, uniqueMarker } from '../support/tenants.fixture';
import { logIn } from '../support/session.fixture';

// DevTools' "Slow 3G" preset: about 500 kbit/s each way and 400 ms of latency
const SLOW_3G = {
  offline: false,
  latency: 400,
  downloadThroughput: (500 * 1024) / 8,
  uploadThroughput: (500 * 1024) / 8,
};

// Credits an account holds for the test, so a post can reserve its price
const GRANTED_CREDITS = 10_000;

// Puts the page's network on Slow 3G (or back to normal) through the browser's own throttling
const throttle = async (cdp: CDPSession, on: boolean) => {
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: on ? SLOW_3G.latency : 0,
    downloadThroughput: on ? SLOW_3G.downloadThroughput : -1,
    uploadThroughput: on ? SLOW_3G.uploadThroughput : -1,
  });
};

// Makes the backend process the first `count` POSTs to `path` and then cuts the connection before
// the browser reads the answer; later requests go through untouched. Returns the dropped count.
const dropResponses = async (page: Page, path: string, count: number) => {
  const backend = new URL(process.env.NEXT_PUBLIC_BACKEND_URL!);
  const state = { dropped: 0 };
  await page.route(
    (url) => url.origin === backend.origin && url.pathname.endsWith(path),
    async (route: Route) => {
      if (route.request().method() === 'POST' && state.dropped < count) {
        state.dropped++;
        await route.fetch();
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    }
  );
  return state;
};

// Whether the response is the stored answer to a request the backend had already processed
const wasReplayed = (headers: Record<string, string>) =>
  headers['idempotent-replayed'] === 'true';

// The credits an account holds, from the worker connection (the API role sees money tables only
// inside a transaction of its own account)
const withWorkerDatabase = async <T>(run: (db: PrismaClient) => Promise<T>) => {
  const url = process.env.DATABASE_WORKER_URL;
  if (!url) {
    throw new Error("DATABASE_WORKER_URL must be set to the running app's worker database");
  }
  const worker = new PrismaClient({ datasources: { db: { url } } });
  try {
    return await run(worker);
  } finally {
    await worker.$disconnect();
  }
};

test.describe('a retried mutation on Slow 3G with a dropped response', () => {
  test('creating a brand twice with one key makes one brand', async ({
    page,
    request,
    db,
    backendUrl,
  }) => {
    const owner = await signUp(request, db, backendUrl, 'idem-brand');
    await logIn(page, owner.person);
    await page.goto(`/w/${owner.workspace.id}/launches`);
    // the calendar has loaded, so the shortcut's listener is attached
    await expect(page.getByText(owner.workspace.post)).toBeVisible();

    const cdp = await page.context().newCDPSession(page);
    await page.keyboard.press('Control+K');
    await page.getByTestId('brand-new').click();
    const brand = uniqueMarker('brand');
    await page.locator('input[name="newBrandName"]').fill(brand);

    const dropped = await dropResponses(page, '/brands', 1);
    await throttle(cdp, true);

    // The first answer is lost: the dialog stays and the person presses Create again
    const create = page.getByTestId('brand-create');
    await create.click();
    await expect.poll(() => dropped.dropped, { timeout: 120_000 }).toBe(1);
    const replay = page.waitForResponse(
      (response) =>
        response.url().endsWith('/brands') &&
        response.request().method() === 'POST',
      { timeout: 120_000 }
    );
    await expect(create).toBeEnabled({ timeout: 120_000 });
    await create.click();
    const answer = await replay;
    expect(answer.status()).toBe(201);
    expect(wasReplayed(await answer.allHeaders())).toBe(true);
    await throttle(cdp, false);

    const brands = await db.organization.findMany({
      where: { name: brand },
    });
    expect(brands).toHaveLength(1);
    const first = await db.userOrganization.findFirstOrThrow({
      where: { userId: owner.person.id, organizationId: owner.workspace.id },
      include: { organization: true },
    });
    const owned = await db.organization.count({
      where: { accountId: first.organization.accountId },
    });
    expect(owned).toBe(2);
  });

  test('scheduling a post twice with one key makes one post and one charge', async ({
    page,
    request,
    db,
    backendUrl,
  }) => {
    const owner = await signUp(request, db, backendUrl, 'idem-post');
    const member = await db.userOrganization.findFirstOrThrow({
      where: { userId: owner.person.id, organizationId: owner.workspace.id },
      include: { organization: true },
    });
    const accountId = member.organization.accountId!;
    const channel = await db.integration.findFirstOrThrow({
      where: { organizationId: owner.workspace.id },
    });
    await withWorkerDatabase((worker) =>
      worker.creditBucket.create({
        data: {
          accountId,
          type: 'GRANT',
          initial: GRANTED_CREDITS,
          remaining: GRANTED_CREDITS,
          grantKey: `e2e:${randomUUID()}`,
        },
      })
    );
    const spent = () =>
      withWorkerDatabase((worker) =>
        worker.creditLedger.count({
          where: { accountId, actionKey: 'post.publish' },
        })
      );
    const before = await spent();

    await logIn(page, owner.person);
    await page.goto(`/w/${owner.workspace.id}/launches`);
    const cdp = await page.context().newCDPSession(page);
    const dropped = await dropResponses(page, '/posts', 2);
    await throttle(cdp, true);

    // One intent, one key: the browser sends it again after each lost answer, as a client does
    const key = randomUUID();
    const content = `<p>${uniqueMarker('post')}</p>`;
    const sent = await page.evaluate(
      async ({ backend, workspaceId, integrationId, key, content }) => {
        const body = JSON.stringify({
          type: 'schedule',
          date: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
          shortLink: false,
          tags: [],
          posts: [
            {
              integration: { id: integrationId },
              settings: { __type: 'bluesky' },
              value: [{ content, image: [] }],
            },
          ],
        });
        const attempts: { status?: number; replayed?: boolean; error?: string }[] = [];
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            const response = await fetch(`${backend}/posts`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                'x-workspace-id': workspaceId,
                'Idempotency-Key': key,
              },
              body,
            });
            attempts.push({
              status: response.status,
              replayed: response.headers.get('idempotent-replayed') === 'true',
            });
            if (response.ok) {
              break;
            }
          } catch (error) {
            attempts.push({ error: String(error) });
          }
        }
        return attempts;
      },
      {
        backend: backendUrl,
        workspaceId: owner.workspace.id,
        integrationId: channel.id,
        key,
        content,
      }
    );
    await throttle(cdp, false);

    expect(dropped.dropped).toBe(2);
    // two answers lost, then the stored answer of the first request
    expect(sent.slice(0, 2).every((attempt) => attempt.error)).toBe(true);
    const last = sent[sent.length - 1];
    expect(last.status).toBe(201);
    expect(last.replayed).toBe(true);

    const posts = await db.post.findMany({
      where: {
        organizationId: owner.workspace.id,
        content: { contains: content.replace(/<\/?p>/g, '') },
        deletedAt: null,
      },
    });
    expect(posts).toHaveLength(1);
    expect((await spent()) - before).toBe(1);
  });
});
