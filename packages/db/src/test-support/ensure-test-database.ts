/**
 * Brings this checkout's test database up to the branch's schema, on demand.
 *
 * Called from the vitest `globalSetup` of apps/api, apps/worker and any other
 * package that needs the core schema, so nobody has to remember a setup step and
 * nobody can forget one. Three outcomes, and the third is the point of the file:
 *
 *  1. database missing → create it, apply every migration;
 *  2. database behind the branch → `prisma migrate deploy`;
 *  3. database AHEAD of the branch → STOP, and say so.
 *
 * (3) is the ~92 `P2022 column owner_overridden does not exist` incident. A
 * worktree that has run a newer branch leaves a schema the current branch's
 * client cannot read, and the resulting failures are spread over dozens of files
 * and read as catastrophic product breakage. Detected here it is one sentence.
 *
 * Two hard rules, both learned the expensive way:
 *
 *  - **Only a database this checkout OWNS is ever created or migrated.** Applying
 *    a branch's migrations to a database other sessions share is the mechanism
 *    that caused the incident above — "repairing it forward" IS the damage. An
 *    unowned database is verified and reported on, never written to. That rule
 *    rests on one boolean, so the three write paths it guards
 *    (`CREATE DATABASE` and both `migrate deploy` call sites) are reachable
 *    through injected dependencies and asserted unreachable in tests.
 *  - **There is NO drop and no teardown anywhere in this file.** An over-eager
 *    teardown that removed somebody else's database would be worse than the
 *    problem it solves. Dropping is a separate, explicit, single-database command
 *    (`../scripts/reset-test-database.ts`).
 *
 * Uses neither `__dirname` nor `import.meta`: the package root arrives as an
 * argument, so this module behaves identically compiled to CJS or transformed by
 * vite-node.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compareMigrations, type MigrationRecord } from './test-database.js';
import { createPrismaClient } from "../client.js";

/** Thrown when the database's migration state and this checkout's disagree. */
export class TestDatabaseDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestDatabaseDriftError';
  }
}

export interface EnsureTestDatabaseResult {
  database: string;
  /** True when this run created the database. */
  created: boolean;
  /** Migration names applied by this run. Empty on the reuse-if-current fast path. */
  applied: string[];
}

/** The slice of a Prisma client this module uses, so a test can stand in for it. */
export interface TestDatabaseClient {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $disconnect(): Promise<void>;
}

/**
 * The three side-effecting things this module does. Injected rather than imported
 * so the ownership rule is testable: the whole property is "with `owned: false`,
 * none of these run", and that cannot be asserted against a real Postgres without
 * risking the database it is protecting.
 */
export interface EnsureTestDatabaseDeps {
  openClient?: (url: string) => TestDatabaseClient;
  runMigrations?: (url: string, dbPackageRoot: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface EnsureTestDatabaseOptions extends EnsureTestDatabaseDeps {
  database: string;
  /** Server-level connection (`/postgres`) used for CREATE DATABASE. */
  maintenanceUrl: string;
  /** `packages/db` — where `prisma/migrations` and the Prisma CLI live. */
  dbPackageRoot: string;
  /**
   * Whether this checkout owns the database. FALSE for a `.env.test.local`
   * override: the database is then verified but never created and never migrated.
   */
  owned: boolean;
  /** Command to name in every error message. */
  resetHint: string;
  /** Recorded as a database COMMENT so a stranded database can be identified later. */
  checkoutRoot?: string;
  /** How many times to re-read `_prisma_migrations` while a migration is in flight. */
  inFlightRetries?: number;
  inFlightDelayMs?: number;
}

/** SQLSTATE 42P01, undefined_table — "there is no `_prisma_migrations` yet". */
const UNDEFINED_TABLE = '42P01';
/** SQLSTATE 42P04, duplicate_database — two runs in one checkout raced. */
const DUPLICATE_DATABASE = '42P04';

const DEFAULT_IN_FLIGHT_RETRIES = 5;
const DEFAULT_IN_FLIGHT_DELAY_MS = 1_000;

function isUnreachable(err: unknown): boolean {
  return /reach database server|ECONNREFUSED|P1001/.test(String(err));
}

function unreachable(url: string): Error {
  return new Error(
    `Cannot reach the test Postgres at ${new URL(url).host}. Start the test stack:\n\n` +
      '  docker compose -p vp-cockpit-test -f docker-compose.test.yml up -d\n',
  );
}

function defaultOpenClient(url: string): TestDatabaseClient {
  return createPrismaClient(url) as unknown as TestDatabaseClient;
}

function migrationDirNames(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) {
    throw new Error(`No migrations directory at ${migrationsDir}`);
  }
  return readdirSync(migrationsDir)
    .filter((name) => statSync(join(migrationsDir, name)).isDirectory())
    .sort();
}

/**
 * `_prisma_migrations`, or `null` when the table does not exist yet.
 *
 * The `null` is load-bearing — it means "never migrated" and sends the caller to
 * `migrate deploy`. So it MUST come only from the missing-table signal: a bare
 * `catch { return null }` here silently disables the ahead, behind and failed
 * checks on any transient first-query error, and `migrate deploy` is a no-op
 * against an ahead database, which is precisely the ~92-`P2022` shape this file
 * exists to prevent.
 */
async function readAppliedMigrations(
  url: string,
  openClient: (url: string) => TestDatabaseClient,
): Promise<MigrationRecord[] | null> {
  const client = openClient(url);
  try {
    return await client.$queryRawUnsafe<MigrationRecord[]>(
      'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at',
    );
  } catch (err) {
    if (String(err).includes(UNDEFINED_TABLE)) return null;
    if (isUnreachable(err)) throw unreachable(url);
    throw err;
  } finally {
    await client.$disconnect();
  }
}

async function createDatabase(options: {
  maintenanceUrl: string;
  database: string;
  checkoutRoot?: string;
  openClient: (url: string) => TestDatabaseClient;
}): Promise<boolean> {
  const admin = options.openClient(options.maintenanceUrl);
  try {
    const existing = await admin.$queryRawUnsafe<Array<{ datname: string }>>(
      'SELECT datname FROM pg_database WHERE datname = $1',
      options.database,
    );
    if (existing.length > 0) return false;
    // Identifiers, not values, so they cannot be parameterised. The name is
    // derived from a sha1 and an [a-z0-9_] slug, so there is nothing to inject;
    // the quotes are belt and braces.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${options.database}"`);
    if (options.checkoutRoot) {
      // Records WHOSE database this is. Once a worktree is deleted its path is
      // gone, so `derivedDatabaseName` can no longer produce the name and
      // `test:db:reset` becomes structurally unable to drop it. This comment is
      // the only recovery path — see `test:db:reset --list-orphans`.
      await admin.$executeRawUnsafe(
        `COMMENT ON DATABASE "${options.database}" IS '${options.checkoutRoot.replace(/'/g, "''")}'`,
      );
    }
    return true;
  } catch (err) {
    if (String(err).includes(DUPLICATE_DATABASE)) return false;
    // A stopped container is the single likeliest cause on a fresh machine, and
    // Prisma's own message does not say which container or how to start it.
    // Matched on the message, not on an error code: PrismaClientInitializationError
    // arrives here with `errorCode: undefined`, so P1001 never appears.
    if (isUnreachable(err)) throw unreachable(options.maintenanceUrl);
    throw err;
  } finally {
    await admin.$disconnect();
  }
}

function defaultRunMigrations(url: string, dbPackageRoot: string): void {
  const prismaBin = join(dbPackageRoot, 'node_modules', '.bin', 'prisma');
  if (!existsSync(prismaBin)) {
    throw new Error(`Prisma CLI not found at ${prismaBin}. Run: pnpm install --frozen-lockfile`);
  }
  try {
    execFileSync(
      prismaBin,
      ['migrate', 'deploy', '--schema', join(dbPackageRoot, 'prisma', 'schema.prisma')],
      { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', encoding: 'utf8' },
    );
  } catch (err) {
    const detail = err as { stdout?: string; stderr?: string };
    throw new Error(
      `prisma migrate deploy failed for the test database.\n${detail.stdout ?? ''}\n${detail.stderr ?? ''}`,
    );
  }
}

function aheadMessage(database: string, unknown: string[], resetHint: string): string {
  return [
    `Test database "${database}" is AHEAD of this checkout.`,
    '',
    'It holds migrations this branch does not contain:',
    ...unknown.map((name) => `  ${name}`),
    '',
    'That happens when this worktree previously ran a newer branch, or when the',
    'database is shared with one. Left alone it does not fail here — it fails as',
    'dozens of unrelated `P2022 column ... does not exist` errors spread across the',
    'suite, which reads as catastrophic product breakage and is not.',
    '',
    'Either rebase this branch onto the migrations above, or reset the database:',
    '',
    `  ${resetHint}`,
  ].join('\n');
}

function unownedMessage(database: string, detail: string, resetHint: string): string {
  return [
    `Test database "${database}" is not this checkout's, and ${detail}.`,
    '',
    'This checkout will NOT migrate a database it does not own. Applying one',
    "branch's migrations to a database other sessions share is the mechanism",
    'behind the ~92 `P2022 column owner_overridden does not exist` incident —',
    'repairing it forward is how the damage happened.',
    '',
    `  ${resetHint}`,
  ].join('\n');
}

function unfinishedMessage(database: string, failed: string[], resetHint: string): string {
  return [
    `Test database "${database}" has a migration that never finished: ${failed.join(', ')}.`,
    '',
    'If another run in this same checkout is migrating right now, let it finish and',
    'run again — this was re-read several times before reporting, so that is',
    'unlikely but possible under heavy load. Otherwise the database is genuinely',
    'half-migrated and needs resetting:',
    '',
    `  ${resetHint}`,
  ].join('\n');
}

/**
 * Ensures `url` names a database whose schema matches this checkout's migrations.
 *
 * The fast path — database exists, migration set identical — is a single query,
 * so this costs milliseconds on every run after the first.
 */
export async function ensureTestDatabase(
  url: string,
  options: EnsureTestDatabaseOptions,
): Promise<EnsureTestDatabaseResult> {
  const openClient = options.openClient ?? defaultOpenClient;
  const runMigrations = options.runMigrations ?? defaultRunMigrations;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.inFlightRetries ?? DEFAULT_IN_FLIGHT_RETRIES;
  const delayMs = options.inFlightDelayMs ?? DEFAULT_IN_FLIGHT_DELAY_MS;

  const local = migrationDirNames(join(options.dbPackageRoot, 'prisma', 'migrations'));

  const created = options.owned
    ? await createDatabase({
        maintenanceUrl: options.maintenanceUrl,
        database: options.database,
        checkoutRoot: options.checkoutRoot,
        openClient,
      })
    : false;

  // A concurrent run in the SAME checkout can be inside `migrate deploy` while we
  // read, which shows up as a started-but-unfinished row. Reporting that
  // immediately tells a developer to reset a perfectly healthy database, so
  // re-read a bounded number of times before believing it.
  let applied = await readAppliedMigrations(url, openClient);
  for (let attempt = 0; attempt < retries; attempt++) {
    if (applied === null) break;
    if (compareMigrations(local, applied).failed.length === 0) break;
    await sleep(delayMs);
    applied = await readAppliedMigrations(url, openClient);
  }

  if (applied === null) {
    // Never migrated — or, for an unowned database, quite possibly not there.
    if (!options.owned) {
      throw new TestDatabaseDriftError(
        unownedMessage(options.database, 'has no migrations applied at all', options.resetHint),
      );
    }
    runMigrations(url, options.dbPackageRoot);
    return { database: options.database, created, applied: local };
  }

  const { failed, unknown, missing } = compareMigrations(local, applied);

  if (failed.length > 0) {
    throw new TestDatabaseDriftError(
      unfinishedMessage(options.database, failed, options.resetHint),
    );
  }
  if (unknown.length > 0) {
    throw new TestDatabaseDriftError(aheadMessage(options.database, unknown, options.resetHint));
  }
  if (missing.length === 0) return { database: options.database, created, applied: [] };

  if (!options.owned) {
    throw new TestDatabaseDriftError(
      unownedMessage(
        options.database,
        `is BEHIND this branch by ${missing.length} migration(s): ${missing.join(', ')}`,
        options.resetHint,
      ),
    );
  }

  runMigrations(url, options.dbPackageRoot);
  return { database: options.database, created, applied: missing };
}
