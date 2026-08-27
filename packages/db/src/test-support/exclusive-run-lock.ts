/**
 * One vitest run at a time per test database — enforced, not requested.
 *
 * ## Why a flag was not enough
 *
 * Two files in `apps/api` clear the whole `organizations` table, because the facts
 * they assert are deployment-wide (`OrganizationService.bootstrap` does an unfiltered
 * `findFirst`; the bootstrap-state route counts the whole table). Since `packages/db`
 * rejoined the gate, two of ITS suites create organizations in the same per-checkout
 * database. In parallel they corrupt each other's fixtures.
 *
 * The first version of that argument was `--concurrency=1` on the root `test` script,
 * asserted by checking that the string appeared in `package.json`. That is an
 * assertion about a script, not about the world: `pnpm test --concurrency=10`, a bare
 * `turbo run test`, or a second `vitest` in another terminal all leave it behind and
 * leave the assertion green. Same shape as the defect this whole branch is about — a
 * check that reports health without establishing the fact.
 *
 * ## Why an advisory lock, specifically
 *
 * `pg_stat_activity` cannot answer the question, and it is worth recording why so the
 * next person does not spend the afternoon on it. Prisma opens a POOL, so this run
 * legitimately holds several backends, and they are indistinguishable from another
 * run's: same `datname`, same `usename`, same `client_addr`, and an empty
 * `application_name` on both sides. Any filter narrow enough to exclude our own pool
 * also excludes the intruder — a guard that cannot fire.
 *
 * A session-scoped advisory lock has the one property that matters here: **Postgres
 * releases it when the connection dies.** A crashed or killed run therefore leaves no
 * stale lock to block the next one, which is what makes this safe in the gate's
 * critical path. A lock file or a table row would not have that property.
 *
 * Acquired once per RUN in the globalSetup — one process, one connection, held for the
 * whole run — and released in `teardown`. Nothing is created and nothing is dropped:
 * this file adds a lock and closes a client.
 */
import { PrismaClient } from '@prisma/client';

/**
 * The lock id. Any 64-bit integer works; a fixed arbitrary constant so every checkout
 * computes the same value without hashing anything.
 *
 * Scope note: advisory locks are per-DATABASE, so one id already gives per-database
 * mutual exclusion — two checkouts with different derived databases do NOT block each
 * other, which is exactly right.
 */
export const EXCLUSIVE_RUN_LOCK_ID = 7920260827;

export interface LockClient {
  $queryRawUnsafe<T>(query: string): Promise<T>;
  $disconnect(): Promise<void>;
}

let held: LockClient | null = null;

/** Exported for the tests; production passes nothing. */
export function defaultLockClient(url: string): LockClient {
  return new PrismaClient({ datasources: { db: { url } } }) as unknown as LockClient;
}

export function exclusiveRunLockUnavailableMessage(database: string): string {
  return (
    `Another vitest run already holds the exclusive-run lock on "${database}".\n\n` +
    'Two suites in apps/api clear the whole organizations table, and two in ' +
    'packages/db create organizations in it, so exactly one run at a time may touch ' +
    'this database.\n\n' +
    'The root `pnpm test` passes --concurrency=1 so packages do not overlap. A bare ' +
    '`turbo run test`, a raised --concurrency, or a second vitest in another terminal ' +
    'all reintroduce the overlap — run `pnpm test`, or wait for the other run to ' +
    'finish. (Nothing to clean up if a run crashed: Postgres drops the lock with the ' +
    'connection.)'
  );
}

export async function acquireExclusiveRunLock(
  url: string,
  database: string,
  open: (u: string) => LockClient = defaultLockClient,
): Promise<void> {
  const client = open(url);
  const rows = await client.$queryRawUnsafe<Array<{ locked: boolean }>>(
    `SELECT pg_try_advisory_lock(${EXCLUSIVE_RUN_LOCK_ID}::bigint) AS locked`,
  );

  if (rows[0]?.locked !== true) {
    await client.$disconnect().catch(() => undefined);
    throw new Error(exclusiveRunLockUnavailableMessage(database));
  }

  held = client;
}

export async function releaseExclusiveRunLock(): Promise<void> {
  if (!held) return;
  const client = held;
  held = null;
  // Explicit unlock, then disconnect. The disconnect alone would do it; the explicit
  // release means a pooled connection handed back to a reused client does not keep it.
  await client
    .$queryRawUnsafe(`SELECT pg_advisory_unlock(${EXCLUSIVE_RUN_LOCK_ID}::bigint)`)
    .catch(() => undefined);
  await client.$disconnect().catch(() => undefined);
}

/** Whether this process currently holds the lock. For the tests. */
export function holdsExclusiveRunLock(): boolean {
  return held !== null;
}
