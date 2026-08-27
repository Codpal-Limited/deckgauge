import { defineConfig } from "vitest/config";
import { resolveCheckoutTestDatabase } from "../../packages/db/src/test-support/test-database";

/**
 * DATABASE_URL is DERIVED here, not read from a file — see
 * `packages/db/src/test-support/test-database.ts` for why, and
 * `apps/api/.env.test` for how to override it.
 *
 * It has to happen in this file: `test.env` OVERRIDES the ambient environment, so
 * exporting DATABASE_URL in a shell does nothing. That is the constraint that made
 * the old scheme require editing a tracked file.
 */
const testDatabase = resolveCheckoutTestDatabase(__dirname);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Every suite in this run shares one Postgres — this checkout's own, never
    // another session's — and the one-org cap (OrganizationService.bootstrap does
    // an unfiltered findFirst) can only be asserted when no other file is creating
    // organizations concurrently. Prefix-scoped cleanup cannot substitute: the
    // assertion is global by nature, not per-fixture.
    fileParallelism: false,
    // Creates and migrates the derived database, or refuses to start with a named
    // reason, and takes the exclusive-run lock so no second run can touch this
    // database concurrently.
    //
    // It DOES have a teardown now — this comment said "deliberately has no teardown"
    // and was made stale by the commit that added one. What that teardown does is
    // release the lock and close its one connection; the property the old wording was
    // protecting still holds exactly: nothing here ever drops a database.
    globalSetup: ["./vitest.globalsetup.ts"],
    env: testDatabase.env,
  },
});
