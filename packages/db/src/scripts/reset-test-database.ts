/**
 * Drops THIS checkout's derived test database, and nothing else.
 *
 *   pnpm --filter @deckgauge/api test:db:reset
 *   pnpm --filter @deckgauge/api test:db:reset --list-orphans
 *
 * Run it when `ensureTestDatabase` reports drift. The next test run recreates and
 * re-migrates the database, so there is no follow-up step.
 *
 * The guards below are deliberately paranoid. An over-eager teardown that removed
 * another session's database would be strictly worse than the shared-database
 * problem this whole mechanism exists to fix, so this script will only ever drop a
 * name that (a) carries the derived prefix and (b) is byte-for-byte the name THIS
 * checkout's path derives. Both checks are recomputed here rather than taken from
 * input: there is no argument, and no env var, that can name the target.
 *
 * `--list-orphans` exists because the identity is a path. Once a worktree is
 * deleted, `derivedDatabaseName` can no longer produce its name, so nothing can
 * drop it — the database COMMENT written at creation is the only way back to it.
 * Listing is READ-ONLY on purpose; it prints the `DROP` for a human to run, and
 * this file never drops a database it did not derive.
 */
import { PrismaClient } from '@prisma/client';
import {
  DERIVED_DATABASE_PREFIX,
  NEVER_TEST_DATABASES,
  derivedDatabaseName,
  isDerivedDatabaseName,
  resolveCheckoutTestDatabase,
} from '../test-support/test-database';

interface DerivedDatabaseRow {
  datname: string;
  /** The checkout path recorded by `COMMENT ON DATABASE`, or null for older ones. */
  comment: string | null;
}

async function listOrphans(admin: PrismaClient): Promise<void> {
  const { existsSync } = await import('node:fs');
  const rows = await admin.$queryRawUnsafe<DerivedDatabaseRow[]>(
    `SELECT d.datname, shobj_description(d.oid, 'pg_database') AS comment
       FROM pg_database d
      WHERE d.datname LIKE $1
      ORDER BY d.datname`,
    `${DERIVED_DATABASE_PREFIX}%`,
  );

  if (rows.length === 0) {
    console.log('No derived test databases on this server.');
    return;
  }

  // A no-comment row is UNKNOWN, not orphaned. It predates path recording and may
  // well belong to a live checkout, so it is listed but never suggested for
  // dropping — the whole point of this command is that it cannot cost anyone their
  // database, and a confident DROP for a database we cannot place would.
  const orphans = rows.filter((r) => r.comment && !existsSync(r.comment));
  const unknown = rows.filter((r) => !r.comment);
  console.log(
    `${rows.length} derived test database(s); ${orphans.length} orphaned, ` +
      `${unknown.length} of unknown provenance.\n`,
  );
  for (const row of rows) {
    const state = !row.comment
      ? 'UNKNOWN (predates path recording — may belong to a live checkout)'
      : existsSync(row.comment)
        ? `live    ${row.comment}`
        : `ORPHAN  ${row.comment} (gone)`;
    console.log(`  ${row.datname.padEnd(44)} ${state}`);
  }
  if (orphans.length > 0) {
    console.log(
      '\nThis command will not drop a database it cannot derive. To remove an orphan whose\n' +
        'checkout is provably gone, by hand:\n' +
        orphans.map((r) => `  DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE);`).join('\n'),
    );
  }
  if (unknown.length > 0) {
    console.log(
      '\nNo DROP is suggested for the UNKNOWN rows above: their checkout was never recorded,\n' +
        'so "gone" cannot be distinguished from "in use". Identify them yourself first.',
    );
  }
}

async function main(): Promise<void> {
  // `__dirname` is fine here and only here: this script is only ever run by tsx,
  // and `packages/db` has no `"type": "module"`, so it executes as CJS.
  const resolution = resolveCheckoutTestDatabase(__dirname);
  // NOTE: `maintenanceUrl` follows TEST_POSTGRES_SERVER_URL, never a DATABASE_URL
  // override — otherwise an override would redirect `DROP … WITH (FORCE)` at
  // whatever server it names.
  const admin = new PrismaClient({ datasources: { db: { url: resolution.maintenanceUrl } } });

  try {
    if (process.argv.includes('--list-orphans')) {
      await listOrphans(admin);
      return;
    }

    const database = derivedDatabaseName(resolution.checkoutRoot);
    if (!database.startsWith(DERIVED_DATABASE_PREFIX) || !isDerivedDatabaseName(database)) {
      throw new Error(`Refusing to drop "${database}" — not a derived test database.`);
    }
    if ((NEVER_TEST_DATABASES as readonly string[]).includes(database)) {
      throw new Error(`Refusing to drop "${database}" — other work depends on it.`);
    }

    const existing = await admin.$queryRawUnsafe<Array<{ datname: string }>>(
      'SELECT datname FROM pg_database WHERE datname = $1',
      database,
    );
    if (existing.length === 0) {
      console.log(`Nothing to do — "${database}" does not exist.`);
      return;
    }
    // FORCE terminates leftover connections; without it a stray Prisma pool from a
    // crashed run blocks the drop and the message blames the wrong thing.
    await admin.$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    console.log(
      `Dropped "${database}" (this worktree only: ${resolution.checkoutRoot}). ` +
        'The next test run recreates and migrates it.',
    );
  } finally {
    await admin.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
