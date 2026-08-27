import { defineConfig } from 'vitest/config'
import { resolveCheckoutTestDatabase } from '../../packages/db/src/test-support/test-database'

/**
 * The worker's DB-touching suites used to reach the single shared `…:55432/cockpit`
 * every worktree wrote to — `notification-maintenance.handler.test.ts` via
 * `WORKER_TEST_DATABASE_URL`'s hardcoded default, and
 * `org-tree-sync/board-reverse-index.test.ts` via a bare `new PrismaClient()` with
 * no `DATABASE_URL` set at all (undefined in a clean shell, LIVE STAGING if the
 * operator had sourced the root `.env`).
 *
 * Both now get this checkout's derived database.
 *
 * Note what is NOT here: an `?? process.env.WORKER_TEST_DATABASE_URL` passthrough.
 * It looked like a courtesy and was a hole — an exported staging value went
 * straight through unchecked, AND diverged from the URL the globalSetup migrates.
 * Redirection goes through `apps/api/.env.test.local`, which is validated
 * (`assertSafeTestDatabaseUrl`) and read by every package in the checkout.
 */
const testDatabase = resolveCheckoutTestDatabase(__dirname)

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    // Creates and migrates the derived database if the api suite has not already.
    globalSetup: ['./vitest.globalsetup.ts'],
    env: {
      // `test.env` is applied before `setupFiles`, and `src/test-setup.ts` calls
      // dotenv without `override`, so this wins over the root `.env` — which points
      // at the live staging Postgres on :5433.
      DATABASE_URL: testDatabase.url,
      WORKER_TEST_DATABASE_URL: testDatabase.url,
      DECKGAUGE_TEST_DB: testDatabase.database,
      DECKGAUGE_TEST_DB_EXCLUSIVE: testDatabase.exclusive ? '1' : '0',
      DECKGAUGE_TEST_WORKTREE_TOKEN: testDatabase.token,
      /**
       * The ClickHouse the three `*-dual-writer.int.test.ts` suites write to.
       *
       * Until this line existed, those four tests had NEVER run: they are gated on
       * `INTEGRATION_CLICKHOUSE_URL`, and nothing in the repository set it — not
       * `.env.example`, not compose, not any vitest config, not the gate. They were
       * quoted as part of a clean "5 skipped" in nine separate reports.
       *
       * The value comes from `apps/api/.env.test` via `resolveCheckoutTestDatabase`,
       * which is the same file, the same reader and the same precedent `apps/api`
       * uses (it passes `testDatabase.env` through wholesale). Pulled out key by
       * key here rather than spread, deliberately: this config's whole reason for
       * listing keys is that a blanket passthrough once let an exported staging
       * `WORKER_TEST_DATABASE_URL` through unchecked.
       *
       * `??` and not `||`: an operator who deliberately sets it empty gets the
       * empty string, and `integrationGate` treats empty as unset and skips with a
       * reason — rather than this line silently substituting a default.
       */
      INTEGRATION_CLICKHOUSE_URL: testDatabase.env.INTEGRATION_CLICKHOUSE_URL ?? '',
    },
  },
})
