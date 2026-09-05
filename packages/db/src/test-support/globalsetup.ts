/**
 * The vitest `globalSetup` every package in this checkout shares.
 *
 * It lives in `packages/db/src` deliberately, for two reasons:
 *
 *  - it is inside `packages/db`'s tsconfig `include`, so `pnpm build` TYPECHECKS
 *    it. The `vitest.globalsetup.ts` files at app roots are outside their
 *    `include: ["src/**\/*"]`, so anything written there gets no type cover at
 *    all — which is why they are now one-line re-exports of this;
 *  - one implementation means apps/api, apps/worker and packages/enterprise
 *    cannot drift into ensuring different databases.
 *
 * Resolution starts from `process.cwd()`, which is the package vitest was invoked
 * in. `findCheckoutRoot` then asks GIT which worktree that is — it does not simply
 * walk up looking for a `pnpm-workspace.yaml`, because worktrees here nest inside
 * the primary checkout and a walk lands on the parent. A worktree root without a
 * workspace file is REFUSED rather than walked past; the walk survives only where
 * git cannot answer, such as an extracted tarball.
 */
import { join } from 'node:path';
import {
  acquireExclusiveRunLock,
  releaseExclusiveRunLock,
} from './exclusive-run-lock.js';
import { ensureTestDatabase, type EnsureTestDatabaseOptions } from './ensure-test-database.js';
import {
  resetHintFor,
  resolveCheckoutTestDatabase,
  type TestDatabaseResolution,
} from './test-database.js';

/**
 * Turns a resolution into the options `ensureTestDatabase` needs.
 *
 * Extracted and exported for ONE reason: `owned` is where the whole
 * never-migrate-a-shared-database property lives, and inline in `setup()` it was
 * a single token that no test could reach. Change `resolution.derived` to `true`
 * below and this branch's central defect returns intact — so it is asserted
 * directly in apps/api/src/test-support/globalsetup-wiring.test.ts.
 */
export function ensureOptionsFor(resolution: TestDatabaseResolution): EnsureTestDatabaseOptions {
  return {
    database: resolution.database,
    maintenanceUrl: resolution.maintenanceUrl,
    dbPackageRoot: join(resolution.checkoutRoot, 'packages', 'db'),
    owned: resolution.derived,
    resetHint: resetHintFor(resolution),
    checkoutRoot: resolution.checkoutRoot,
  };
}

/** How the one-line result is phrased, so the reporting is testable too. */
export function describeResult(result: {
  created: boolean;
  applied: string[];
  database: string;
}): string {
  const how = result.created
    ? 'created'
    : result.applied.length > 0
      ? `migrated (+${result.applied.length})`
      : 'reused';
  return `[test-db] ${result.database} — ${how}`;
}

export async function setup(): Promise<void> {
  const resolution = resolveCheckoutTestDatabase(process.cwd());
  const result = await ensureTestDatabase(resolution.url, ensureOptionsFor(resolution));
  console.log(describeResult(result));

  // One run at a time per database. This is the ENFORCED form of what
  // `--concurrency=1` merely requests: two files in apps/api clear the whole
  // organizations table and two in packages/db create organizations in it, so
  // overlapping runs corrupt each other's fixtures. See exclusive-run-lock.ts for
  // why an advisory lock rather than a pg_stat_activity check or a flag.
  await acquireExclusiveRunLock(resolution.url, resolution.database);
}

/**
 * Releases the exclusive-run lock and closes the connection holding it. That is ALL
 * it does — no database is dropped anywhere in the test path, see
 * `../scripts/reset-test-database.ts`.
 *
 * Not load-bearing for correctness: Postgres releases a session-scoped advisory lock
 * when the connection dies, so a crashed run needs no cleanup. This returns the lock
 * immediately rather than at process exit.
 */
export async function teardown(): Promise<void> {
  await releaseExclusiveRunLock();
}
