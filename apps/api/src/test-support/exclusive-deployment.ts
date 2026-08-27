import type { PrismaClient } from '@deckgauge/db';

/**
 * Two suites in this app assert DEPLOYMENT-WIDE truths — "no organization
 * exists", "exactly one exists" — because that is genuinely their subject: the
 * single-organization cap is enforced by an UNFILTERED `findFirst`, and
 * `GET /organization/bootstrap-state` answers `NEEDS_BOOTSTRAP` from a count over
 * the whole table. No per-fixture scoping can express either one.
 *
 * To hold them, those files clear the `organizations` table outright. That was
 * previously justified by a COMMENT, against a database shared by every worktree
 * on the machine — so the justification was false, and three separate agents
 * reported the resulting failures as product regressions.
 *
 * This makes the claim executable instead. The suite refuses to delete anything
 * unless the run really does own the database:
 *
 *   - `DECKGAUGE_TEST_DB_EXCLUSIVE=1` — set by vitest.config.ts only when the
 *     database name was derived from this checkout's path, or when a
 *     `.env.test.local` override explicitly claims exclusivity;
 *   - `current_database()` matches `DECKGAUGE_TEST_DB` — asserting the connection
 *     actually opened, not merely what the configuration intended. (The same
 *     reasoning as `packages/db/src/scripts/bootstrap-admin.test.ts`, which was
 *     the only place in the repository already doing this.)
 *
 * The isolation argument has three legs, and all three are enforced rather than
 * asserted in prose:
 *
 *   - no other FILE in this run is writing — `fileParallelism: false` here;
 *   - no other CHECKOUT can reach this database — the name is derived from this
 *     checkout's path, and the two conditions above prove the connection matches;
 *   - no other PACKAGE's suite is running — the root `test` script passes
 *     `--concurrency=1` to turbo.
 *
 * The third leg is new, and it is what made it possible for `packages/db` to rejoin
 * the gate. This docblock previously ended by naming the hazard and then dismissing
 * it on the strength of another module's current state: "the worker's suites are
 * prefix-scoped and do not read deployment-wide counts, so they do not collide with
 * these two files today; if that changes, this needs a Postgres advisory lock." That
 * day arrived — `packages/db/__tests__/board-owners-statuses.test.ts` and
 * `board-github-source-allowed-types.test.ts` both `create` organizations, in this
 * same derived database — and an argument resting on what a sibling package happens
 * not to do is an argument that expires without anybody editing this file.
 *
 * The third leg is the Postgres advisory lock in
 * `packages/db/src/test-support/exclusive-run-lock.ts`, taken once per run by the
 * shared globalSetup. `--concurrency=1` on the root script REQUESTS that property;
 * the lock ESTABLISHES it, and it keeps holding under
 * `pnpm test --concurrency=10`, a bare `turbo run test`, or a second vitest in
 * another terminal — each of which leaves a flag-shaped assertion green. Postgres
 * drops a session-scoped lock with its connection, so a crashed run leaves nothing
 * stale behind.
 *
 * What this file still adds on top: a run can own the database and be alone in it and
 * STILL be pointed somewhere unexpected by an override, which is what the two checks
 * below establish on the connection the deletes will travel through.
 */
export async function assertExclusiveDeployment(prisma: PrismaClient): Promise<void> {
  const [row] = await prisma.$queryRaw<Array<{ database: string }>>`
    SELECT current_database() AS database
  `;
  const actual = row?.database;
  const expected = process.env.DECKGAUGE_TEST_DB;

  if (process.env.DECKGAUGE_TEST_DB_EXCLUSIVE !== '1') {
    throw new Error(
      `This suite clears the whole organizations table, so it needs a database no other ` +
        `session is writing to. This run is pointed at "${actual}", which is not marked ` +
        `exclusive.\n\n` +
        `Remove the DATABASE_URL override from apps/api/.env.test.local to get a private ` +
        `per-worktree database, or — if you are certain nothing else writes to ` +
        `"${actual}" — add DECKGAUGE_TEST_DB_EXCLUSIVE=1 to that file.`,
    );
  }

  if (!actual || actual !== expected) {
    throw new Error(
      `Expected to be connected to the exclusive test database "${expected}", but ` +
        `current_database() is "${actual}". Something is overriding the connection; ` +
        `this suite deletes rows and will not run blind.`,
    );
  }
}
