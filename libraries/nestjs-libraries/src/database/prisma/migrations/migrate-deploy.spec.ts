// Schema migrations: `prisma-migrate-deploy` brings fresh, db-push-era
// and already migrated databases to the current schema without losing data,
// and refuses a database that drifted from its migrations before applying anything.
import { PrismaClient } from '@prisma/client';
import { execFileSync, spawnSync } from 'child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// Runs against a real Postgres whose user may create databases.
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const MIGRATIONS = __dirname;
const SCHEMA = join(__dirname, '..', 'schema.prisma');
const BASELINE_SQL = join(MIGRATIONS, '0_baseline', 'migration.sql');
const PRISMA = ['dlx', 'prisma@6.5.0'];
const REPLAY_SCHEMA = '_migrate_deploy_replay';
const TEST_DATABASE = url ? new URL(url).pathname.slice(1) : '';

describeDb('prisma-migrate-deploy (Postgres)', () => {
  const created: string[] = [];
  const tempDirs: string[] = [];

  // Connection string for another database on the test server.
  const urlFor = (database: string) => {
    const target = new URL(url!);
    target.pathname = '/' + database;
    return target.toString();
  };

  // Runs SQL on a database through the Prisma CLI.
  const execute = (database: string, sql: string) =>
    execFileSync('pnpm', [...PRISMA, 'db', 'execute', '--url', urlFor(database), '--stdin'], {
      input: sql,
      stdio: 'pipe',
    });

  // Runs a SQL file on a database through the Prisma CLI.
  const executeFile = (database: string, file: string) =>
    execFileSync('pnpm', [...PRISMA, 'db', 'execute', '--url', urlFor(database), '--file', file], {
      stdio: 'pipe',
    });

  // Creates an empty database and remembers it for cleanup.
  const createDatabase = () => {
    const name = 'mig_' + randomUUID().replace(/-/g, '');
    execute(TEST_DATABASE, `CREATE DATABASE "${name}";`);
    created.push(name);
    return name;
  };

  // Runs the deploy script against a database; returns exit code and output.
  const deploy = (database: string, script = join(MIGRATIONS, 'migrate-deploy.sh')) => {
    const result = spawnSync('sh', [script], {
      env: { ...process.env, DATABASE_URL: urlFor(database) },
      encoding: 'utf8',
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };

  // Opens a Prisma client on a database.
  const clientFor = (database: string) =>
    new PrismaClient({ datasources: { db: { url: urlFor(database) } } });

  // True when `prisma migrate diff` with these sides finds no difference.
  const noDiff = (...sides: string[]) =>
    spawnSync('pnpm', [...PRISMA, 'migrate', 'diff', ...sides, '--exit-code'], { stdio: 'pipe' })
      .status === 0;

  // True when the database has exactly the schema in schema.prisma.
  const matchesSchema = (database: string) =>
    noDiff('--from-url', urlFor(database), '--to-schema-datamodel', SCHEMA);

  // Prisma's view of a database's migration history against a schema's migrations.
  const migrationStatus = (database: string, schema = SCHEMA) => {
    const result = spawnSync(
      'pnpm',
      [...PRISMA, 'migrate', 'status', '--schema', schema],
      { env: { ...process.env, DATABASE_URL: urlFor(database) }, encoding: 'utf8' }
    );
    return { upToDate: result.status === 0, output: result.stdout + result.stderr };
  };

  // A scratch copy of schema.prisma (plus extra models) and the migrations (plus extra ones); returns its root.
  const copyWith = (extra: Record<string, string>, models = '') => {
    const root = mkdtempSync(join(tmpdir(), 'migrations-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'schema.prisma'), readFileSync(SCHEMA, 'utf8') + models);
    cpSync(MIGRATIONS, join(root, 'migrations'), { recursive: true });
    for (const [name, sql] of Object.entries(extra)) {
      mkdirSync(join(root, 'migrations', name));
      writeFileSync(join(root, 'migrations', name, 'migration.sql'), sql);
    }
    return root;
  };

  // True when the deploy left nothing in its scratch schema.
  const scratchSchemaEmpty = (database: string) => {
    const target = new URL(urlFor(database));
    target.searchParams.set('schema', REPLAY_SCHEMA);
    return noDiff('--from-empty', '--to-url', target.toString());
  };

  // Adds a user row so data loss would be visible.
  const seedUser = async (database: string) => {
    const client = clientFor(database);
    try {
      return await client.user.create({
        data: { email: randomUUID() + '@test.local', providerName: 'LOCAL', timezone: 0 },
      });
    } finally {
      await client.$disconnect();
    }
  };

  // Reads a user back by id.
  const findUser = async (database: string, id: string) => {
    const client = clientFor(database);
    try {
      return await client.user.findUnique({ where: { id } });
    } finally {
      await client.$disconnect();
    }
  };

  afterAll(() => {
    for (const name of created) {
      execute(TEST_DATABASE, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('brings a fresh database to the current schema', () => {
    const db = createDatabase();
    const { status } = deploy(db);
    expect(status).toBe(0);
    expect(matchesSchema(db)).toBe(true);
  });

  it('baselines a db-push-era database without changing its data', async () => {
    const db = createDatabase();
    executeFile(db, BASELINE_SQL); // same schema, no migration history
    const user = await seedUser(db);

    const { status } = deploy(db);

    expect(status).toBe(0);
    expect(migrationStatus(db).upToDate).toBe(true);
    expect(matchesSchema(db)).toBe(true);
    expect(await findUser(db, user.id)).toEqual(user);
  });

  it('changes nothing when run a second time', async () => {
    const db = createDatabase();
    expect(deploy(db).status).toBe(0);
    const user = await seedUser(db);

    const { status, output } = deploy(db);

    expect(status).toBe(0);
    expect(output).toContain('No pending migrations to apply');
    expect(migrationStatus(db).upToDate).toBe(true);
    expect(await findUser(db, user.id)).toEqual(user);
  });

  it('refuses a database without history that differs from the baseline, leaving it as it was', async () => {
    const db = createDatabase();
    executeFile(db, BASELINE_SQL);
    execute(db, 'ALTER TABLE "User" ADD COLUMN "legacyNote" TEXT;');
    const user = await seedUser(db);

    const { status } = deploy(db);

    expect(status).not.toBe(0);
    const history = migrationStatus(db);
    expect(history.upToDate).toBe(false);
    expect(history.output).toMatch(/not yet been applied:\s+0_baseline/); // not baselined
    expect(await findUser(db, user.id)).toMatchObject({ id: user.id, email: user.email });
  });

  it('refuses a migrated database that drifted from its history, leaving it as it was', async () => {
    const db = createDatabase();
    expect(deploy(db).status).toBe(0);
    // an added column and a dropped unique index, both outside any migration
    execute(db, 'ALTER TABLE "User" ADD COLUMN "legacyNote" TEXT;\nDROP INDEX "User_email_providerName_key";');
    const user = await seedUser(db);

    const { status } = deploy(db);

    expect(status).not.toBe(0);
    expect(migrationStatus(db).upToDate).toBe(true); // history untouched
    expect(matchesSchema(db)).toBe(false); // the out-of-band change is still there
    expect(await findUser(db, user.id)).toMatchObject({ id: user.id, email: user.email });
  });

  it('refuses a drifted database with a pending migration without applying it', async () => {
    const root = copyWith(
      { '99999999999999_add': 'CREATE TABLE "ProbeAdd" (\n    "id" TEXT NOT NULL,\n\n    CONSTRAINT "ProbeAdd_pkey" PRIMARY KEY ("id")\n);\n' },
      '\nmodel ProbeAdd {\n  id String @id\n}\n'
    );
    const db = createDatabase();
    expect(deploy(db).status).toBe(0);
    execute(db, 'ALTER TABLE "User" ADD COLUMN "legacyNote" TEXT;');
    const user = await seedUser(db);

    const { status, output } = deploy(db, join(root, 'migrations', 'migrate-deploy.sh'));

    expect(status).not.toBe(0);
    const history = migrationStatus(db, join(root, 'schema.prisma'));
    expect(history.upToDate).toBe(false);
    expect(history.output).toMatch(/not yet been applied:\s+99999999999999_add/); // not recorded
    expect(output).toContain('changed outside a migration'); // refused as drift
    expect(migrationStatus(db).upToDate).toBe(true); // history as it was
    expect(matchesSchema(db)).toBe(false); // the out-of-band column is still there…
    execute(db, 'ALTER TABLE "User" DROP COLUMN "legacyNote";');
    expect(matchesSchema(db)).toBe(true); // …and "ProbeAdd" was never created
    expect(await findUser(db, user.id)).toMatchObject({ id: user.id, email: user.email });
    expect(scratchSchemaEmpty(db)).toBe(true);
  });

  it('applies a pending migration to a database that has not drifted', async () => {
    const root = copyWith({ '99999999999999_add': 'UPDATE "User" SET "name" = \'migrated\';\n' });
    const db = createDatabase();
    expect(deploy(db).status).toBe(0);
    const user = await seedUser(db);

    const { status } = deploy(db, join(root, 'migrations', 'migrate-deploy.sh'));

    expect(status).toBe(0);
    expect(migrationStatus(db, join(root, 'schema.prisma')).upToDate).toBe(true);
    expect(matchesSchema(db)).toBe(true);
    expect(await findUser(db, user.id)).toEqual({ ...user, name: 'migrated' });
    expect(scratchSchemaEmpty(db)).toBe(true);
  });

  it('refuses schema changes that no migration makes, leaving the database as it was', async () => {
    const root = copyWith(
      { '99999999999999_add': 'UPDATE "User" SET "name" = \'migrated\';\n' },
      '\nmodel ProbeUnmigrated {\n  id String @id\n}\n'
    );
    const db = createDatabase();
    expect(deploy(db).status).toBe(0);
    const user = await seedUser(db);

    const { status } = deploy(db, join(root, 'migrations', 'migrate-deploy.sh'));

    expect(status).not.toBe(0);
    expect(migrationStatus(db).upToDate).toBe(true); // 99999999999999_add not recorded
    expect(matchesSchema(db)).toBe(true);
    expect(await findUser(db, user.id)).toEqual(user);
  });

  it('exits non-zero on a migration that cannot run, leaving the database as it was', async () => {
    const root = copyWith(
      { '1_broken': 'CREATE TABLE "BrokenProbe" ("id" TEXT PRIMARY KEY);\nSELECT 1 / 0;\n' },
      '\nmodel BrokenProbe {\n  id String @id\n}\n'
    );
    const db = createDatabase();
    expect(deploy(db).status).toBe(0);
    const user = await seedUser(db);

    const { status } = deploy(db, join(root, 'migrations', 'migrate-deploy.sh'));

    expect(status).not.toBe(0);
    const history = migrationStatus(db, join(root, 'schema.prisma'));
    expect(history.upToDate).toBe(false);
    expect(history.output).toContain('1_broken');
    expect(matchesSchema(db)).toBe(true); // "BrokenProbe" was not left behind
    expect(await findUser(db, user.id)).toEqual(user);
  });

  it('exits non-zero when a migration fails on existing rows, and rolls that migration back', async () => {
    // Runs on an empty replay, fails once "User" has a row
    const root = copyWith({
      '1_data': 'UPDATE "User" SET "name" = \'changed\';\n' +
        'SELECT 1 / (1 - LEAST((SELECT COUNT(*) FROM "User"), 1));\n',
    });
    const db = createDatabase();
    expect(deploy(db).status).toBe(0);
    const user = await seedUser(db);

    const { status } = deploy(db, join(root, 'migrations', 'migrate-deploy.sh'));

    expect(status).not.toBe(0);
    expect(migrationStatus(db, join(root, 'schema.prisma')).output).toContain('1_data');
    expect(matchesSchema(db)).toBe(true);
    expect(await findUser(db, user.id)).toEqual(user); // the UPDATE was rolled back
  });
});
