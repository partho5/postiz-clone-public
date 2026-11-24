// E2E fixtures: the Playwright `test` every e2e suite imports. It adds the app's database (to
// seed data no screen can create yet, such as a connected channel) and the backend's address.
import { test as base } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

// Reads an environment variable the running app is configured with
const appSetting = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set to the running app's value`);
  }
  return value;
};

export const test = base.extend<{ backendUrl: string }, { db: PrismaClient }>({
  // The backend the web app talks to
  backendUrl: async ({}, use) => {
    await use(appSetting('NEXT_PUBLIC_BACKEND_URL'));
  },
  // The app's database, one connection per worker
  db: [
    async ({}, use) => {
      const db = new PrismaClient({
        datasources: { db: { url: appSetting('DATABASE_URL') } },
      });
      await use(db);
      await db.$disconnect();
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
