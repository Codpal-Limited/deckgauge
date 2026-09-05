import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The CommonJS globals these CLI scripts used, recreated for ESM.
 *
 * `packages/db` became `"type": "module"` with the Prisma 7 upgrade — Prisma 7
 * ships ESM-only, so the package importing it has to be a module too. That
 * removes `__dirname` and `require.main`, both of which the tsx-run scripts in
 * this package relied on: `require.main === module` to decide whether they were
 * invoked directly, and `__dirname` to locate `clickhouse/schemas`.
 *
 * `tsc` does not catch this and neither does the test suite. @types/node
 * declares both as globals whatever the module system, so it typechecks; and
 * vitest's transform supplies `__dirname` to test files, so the suites stay
 * green. It surfaces only when a script is actually executed — which is how
 * `migrate:clickhouse` failed the staging deploy with `ReferenceError: require
 * is not defined in ES module scope` after everything else had passed.
 */
export function dirnameOf(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/** The ESM spelling of `require.main === module`. */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && importMetaUrl === pathToFileURL(entry).href;
}
