import { defineConfig } from 'vitest/config';
import { resolveCheckoutTestDatabase } from './src/test-support/test-database';
import { dockerCapabilityEnv } from './src/test-support/integration-capability';

/**
 * This config used to call `dotenv.config` on the ROOT `.env`, whose `DATABASE_URL`
 * points at the LIVE STAGING Postgres on :5433 — and two suites here `create` and
 * `deleteMany`. That single line is why the root `test` script carried
 * `--filter=!@deckgauge/db` and why this package sat outside the merge gate.
 *
 * It is gone. The database is now DERIVED per checkout, exactly as `apps/api` and
 * `apps/worker` derive theirs, from the same module — this package importing from
 * its own `src/`.
 *
 * Two things had to be true before the filter could be removed, and both are
 * asserted rather than described:
 *
 *  - **no suite here can reach :5433.** `assertSafeTestDatabaseUrl`, inside
 *    `resolveCheckoutTestDatabase`, refuses that port outright — and
 *    `src/test-support/staging-unreachable.test.ts` opens a real Prisma client the way the two
 *    board suites do and asserts `current_database()`, which proves where the
 *    writes land rather than what the configuration intended;
 *  - **no other run touches this database at the same time.** Two files in this
 *    package create and delete `organizations`, and two in `apps/api` clear that table
 *    outright to assert deployment-wide truths; overlapping runs corrupt each other's
 *    fixtures. Enforced by the Postgres advisory lock the shared globalSetup takes —
 *    `src/test-support/exclusive-run-lock.ts`.
 *
 *    This paragraph used to credit `--concurrency=1` on the root script and claim
 *    "both are asserted rather than described". Neither half survived: the flag is only
 *    a REQUEST (a bare `turbo run test`, a raised concurrency, or a second terminal all
 *    leave it behind), and the string assertion that was standing in for it is the
 *    thing the lock replaced. `--concurrency=1` stays on the script for VM memory,
 *    which is a different reason.
 *
 * Nothing else from the root `.env` was load-bearing here: the ClickHouse suites
 * either start their own container or mock `createClient`, and
 * `bootstrap-admin.test.ts` supplies its connection explicitly.
 */
const testDatabase = resolveCheckoutTestDatabase(__dirname);

export default defineConfig({
  test: {
    environment: 'node',

    // Several suites here start a real ClickHouse container
    // (startClickHouseContainer). Run test FILES one at a time.
    //
    // Run in parallel they contend for memory on a developer machine and fail
    // in ways that look like product bugs rather than resource starvation:
    // observed on this host as `Test timed out in 5000ms` plus
    // `Table cockpit.jira_issues__v2 is dropped or detached`, with the same 7
    // files passing 76/76 immediately afterwards under --no-file-parallelism.
    // The convergence suite alone starts two containers sequentially, so
    // parallel files can mean three or more servers at once.
    //
    // Correctness does not depend on this — isolation does not come from test
    // ordering — but a suite that is only green when invoked with an extra flag
    // is a suite people will believe is broken.
    fileParallelism: false,

    // Creates and migrates this checkout's derived database if apps/api or
    // apps/worker has not already, or refuses to start with a named reason. The
    // implementation is shared with both, so the three cannot drift into ensuring
    // different databases.
    globalSetup: ['./src/test-support/globalsetup.ts'],

    /**
     * `dockerCapabilityEnv()` resolves `docker info` HERE — once, in the main process
     * — and stamps the answer for every worker.
     *
     * Not a micro-optimisation. Six files in this package gate on `docker` at
     * collection time, each in its own worker, and per-worker spawns disagree: one
     * file's `docker info` failed under memory pressure while the coverage suite's
     * succeeded, so 18 tenancy tests vanished and the gate stayed green. That is the
     * defect this whole mechanism removes, reappearing one level down.
     */
    env: { ...testDatabase.env, ...dockerCapabilityEnv() },

    // Container startup dominates these tests; the 5s default expires while a
    // server is still booting.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
