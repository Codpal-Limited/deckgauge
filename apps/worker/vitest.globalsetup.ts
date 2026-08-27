/** See apps/api/vitest.globalsetup.ts — one typechecked implementation, shared. */
export {
  setup,
  // The teardown releases the exclusive-run lock, and vitest only calls a `teardown`
  // the globalSetup module actually exports — so it has to be forwarded here.
  //
  // The cost of omitting it is NOT what an earlier version of this comment claimed
  // ("would block the next package in a --concurrency=1 gate"). It would not: turbo
  // starts the next task only after this process exits, and Postgres drops a
  // session-scoped advisory lock with the connection, so the lock is gone before
  // anything else asks for it. The real beneficiary is `vitest --watch`, where the
  // process does NOT exit between runs — without this, the second run in a watch
  // session would fail to acquire a lock the first one still held.
  teardown,
} from '../../packages/db/src/test-support/globalsetup'
