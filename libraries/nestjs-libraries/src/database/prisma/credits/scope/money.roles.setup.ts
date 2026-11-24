// Money-table row-level security: prepares the integration-test database
// the way a deploy does (migrations as the worker role, then the API role) and
// exposes the API role's connection string as TEST_DATABASE_API_URL.
import { execFileSync } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..', '..');
const API_ROLE = 'money_api_test';

// Jest global setup: a no-op when TEST_DATABASE_URL is not set.
export default async function prepareMoneyRoles() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    return;
  }
  execFileSync('pnpm', ['run', 'prisma-migrate-deploy'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  execFileSync('sh', [join(__dirname, 'money-roles.sh')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_WORKER_URL: url,
      APP_DB_USER: API_ROLE,
      APP_DB_PASSWORD: API_ROLE,
    },
    stdio: 'pipe',
  });
  const api = new URL(url);
  api.username = API_ROLE;
  api.password = API_ROLE;
  process.env.TEST_DATABASE_API_URL = api.toString();
}
