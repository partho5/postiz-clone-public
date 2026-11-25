// Timed first post: a new person goes from the sign-in form to a scheduled post in under two
// minutes — email code, brand, one channel, post — through the screens, with nothing to skip.
// Connecting a channel is a round trip to another company's login page, which no test can make, so
// the channel (and the free credits a first connect grants) is put in the database at the step where
// the person would return from it; the clock keeps running through the page reload that follows.
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { test, expect } from '../support/test.fixture';
import { uniqueMarker } from '../support/tenants.fixture';
import { logSize, mailedCode } from '../support/session.fixture';

// The budget the goal sets for the whole run
const BUDGET_MS = 120_000;

// Credits an account holds for the test, so the post can reserve its price
const GRANTED_CREDITS = 10_000;

test('a new person schedules a first post within two minutes of signing in', async ({
  page,
  db,
}) => {
  const workerUrl = process.env.DATABASE_WORKER_URL;
  if (!workerUrl) {
    throw new Error("DATABASE_WORKER_URL must be set to the running app's worker database");
  }
  const worker = new PrismaClient({ datasources: { db: { url: workerUrl } } });
  const email = `${uniqueMarker('first-post')}@e2e.test`;
  const content = uniqueMarker('first-post-text');
  const steps: Record<string, number> = {};

  try {
    const started = Date.now();
    const lap = (name: string) => {
      steps[name] = Date.now() - started;
    };

    // Email code: ask for it on the sign-in form and type what was mailed; the sixth digit signs in
    await page.goto('/auth/login');
    await page.locator('input[name="email"]').fill(email);
    const from = logSize();
    await page.getByTestId('otp-submit').click();
    await page.locator('input[name="code"]').fill(await mailedCode(email, from));
    await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}\/quick-start/);
    const workspaceId = page.url().match(/\/w\/([0-9a-f-]{36})\//)![1];
    lap('signed in');

    // Brand: the name is prefilled, the colour and time zone are detected
    await page.getByTestId('quick-start-continue').click();
    await expect(page.getByTestId('quick-start-channel-title')).toBeVisible();
    lap('brand');

    // Channel: the connect's result, then the page the person lands back on
    const { accountId } = await db.organization.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { accountId: true },
    });
    await db.integration.create({
      data: {
        organizationId: workspaceId,
        internalId: `first-post-${randomUUID()}`,
        name: 'First channel',
        picture: '/no-picture.jpg',
        providerIdentifier: 'bluesky',
        type: 'social',
        token: 'first-post-token',
      },
    });
    await worker.creditBucket.create({
      data: {
        accountId: accountId!,
        type: 'GRANT',
        initial: GRANTED_CREDITS,
        remaining: GRANTED_CREDITS,
        grantKey: `e2e:${randomUUID()}`,
      },
    });
    await page.reload();
    lap('channel');

    // Post: the editor opens on that channel at the next free slot
    await page.getByTestId('quick-start-write-post').click();
    const editor = page.locator('.tiptap, .ProseMirror').first();
    await editor.click();
    await page.keyboard.type(content);
    await page
      .locator('button.btnSub:not([disabled])')
      .filter({ hasText: /add to calendar|publish to/i })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/launches`), {
      timeout: 60_000,
    });
    lap('post');

    const posts = await db.post.findMany({
      where: { organizationId: workspaceId, deletedAt: null },
    });
    expect(posts.map((post) => post.content).join('')).toContain(content);
    console.log(`first post timed run: ${JSON.stringify(steps)} ms`);
    expect(steps.post).toBeLessThan(BUDGET_MS);
  } finally {
    await worker.$disconnect();
  }
});
