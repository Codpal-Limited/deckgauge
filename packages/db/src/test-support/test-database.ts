/**
 * Which Postgres database the test suites talk to — derived, never pinned.
 *
 * WHY THIS EXISTS
 *
 * `apps/api/.env.test` used to pin
 * `DATABASE_URL=postgresql://cockpit:cockpit@localhost:55432/cockpit`, so every
 * worktree and every concurrent session wrote to ONE database. In 48 hours that
 * produced at least six misdiagnoses, all of them expensive because the evidence
 * looked like product breakage:
 *
 *  - ~92 `P2022 column owner_overridden does not exist` failures on a branch
 *    whose own schema was fine — another session's migration had dropped the
 *    column;
 *  - `P2003 org_memberships_organization_id_fkey` INSIDE a transaction, twice in
 *    five runs, because a concurrent session was pulling the FK out mid-flight;
 *  - a different file failing on each of four consecutive runs, every one of them
 *    green in isolation.
 *
 * The repository already had a convention — per-plan databases (`cockpit_slice1`,
 * `cockpit_sdd_orgaccess`, …) — but it was manual, and applying it meant editing
 * `apps/api/.env.test`, a TRACKED file, which then dirtied every merge gate and
 * had to be reverted by hand. So in practice nobody did it.
 *
 * WHAT REPLACES IT
 *
 * The database NAME is derived from the checkout that is running the tests:
 * `cockpit_wt_<dirname>_<sha1(realpath)[0..8]>`. Two worktrees cannot collide,
 * the same worktree always gets the same database back (so it is created and
 * migrated once, not per run), and no tracked file is edited to get there.
 *
 * A database this module did not derive is an ALLOWLIST decision, not a denylist
 * one: `assertSafeTestDatabaseUrl` accepts `cockpit_wt_*` and refuses everything
 * else unless `DECKGAUGE_TEST_DB_ALLOW_SHARED=1` says otherwise, and refuses
 * `cockpit` even then. A two-name denylist was the first
 * shape of this and it was wrong twice over: it was consulted only where the name
 * was derived and so could never match, and it covered 2 of the ~10 databases
 * this server actually holds. Both halves matter, because an override reaches
 * `prisma migrate deploy` — and forward-repairing a database other sessions read
 * IS the `owner_overridden` incident, not the recovery from it.
 *
 * This module is deliberately dependency-free (node builtins only) so the vitest
 * CONFIG files can import it before anything is built, and it uses neither
 * `__dirname` nor `import.meta`, so it behaves identically whether it is loaded
 * as compiled CJS (tsx, `dist/`) or transformed on the fly by vite-node.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Every derived database carries this prefix, and only derived ones do. */
export const DERIVED_DATABASE_PREFIX = 'cockpit_wt_';

/**
 * Databases refused as a test target even WITH explicit consent.
 *
 * Exactly one name, and the narrowness is the point. `cockpit` was the value
 * pinned in `apps/api/.env.test`, so it is the database all six misdiagnoses ran
 * through; it earns a tripwire that no flag can disarm.
 *
 * `cockpit_integration` used to be here too and has been moved under
 * `DECKGAUGE_TEST_DB_ALLOW_SHARED` with the rest of the per-plan family. The
 * flag's contract is "I accept sharing", ownership is enforced separately — an
 * opted-in target is never created and never migrated — so under that contract it
 * is no more dangerous than `cockpit_mainbase`, and it was created deliberately as
 * a private database. Refusing it unconditionally punished its owner.
 *
 * Matching is EXACT, not by prefix: `cockpit_tnc_integration` is a different
 * database and is not caught here.
 */
export const NEVER_TEST_DATABASES = ['cockpit'] as const;

/** Opt-in for a non-derived database. Set it in the untracked `.env.test.local`. */
export const ALLOW_NON_DERIVED_ENV = 'DECKGAUGE_TEST_DB_ALLOW_SHARED';

/** The disposable test Postgres from `docker-compose.test.yml`. */
export const DEFAULT_TEST_POSTGRES_SERVER_URL = 'postgresql://cockpit:cockpit@localhost:55432';

/**
 * The STAGING Postgres. `packages/db`'s own vitest config loads the root `.env`,
 * which points here — this repository has already had test suites write to it.
 * A test URL that resolves to this port is a configuration accident, not a
 * choice, so it is refused rather than used.
 */
const STAGING_POSTGRES_PORT = '5433';

/**
 * Slug budget inside the derived name. Changing it changes
 * `MAX_WORKTREE_TOKEN_LENGTH`, which downstream consumers size their own
 * identifiers against — see the exact-length assertions in the tests, which exist
 * because raising this silently reintroduced a 63-byte identifier collision in
 * `packages/enterprise`.
 */
const MAX_SLUG_LENGTH = 20;

/** slug (≤20) + `_` + 8 hex. Consumers that prefix the token budget against this. */
export const MAX_WORKTREE_TOKEN_LENGTH = MAX_SLUG_LENGTH + 1 + 8;

/**
 * Where the test-database knobs live, relative to the checkout root. ONE location
 * for the whole checkout — apps/worker and packages/enterprise read these too, so
 * a checkout cannot end up with two packages resolving two different databases.
 */
export const CHECKOUT_ENV_FILES = ['apps/api/.env.test', 'apps/api/.env.test.local'] as const;

/** Resolves a directory to its git worktree root, or null when git cannot say. */
export function gitToplevelOf(dir: string): string | null {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? realpathSync(out) : null;
  } catch {
    // Not a git checkout, or git is not installed. Both are legitimate — an
    // extracted tarball still has a pnpm-workspace.yaml — so fall back rather
    // than fail.
    return null;
  }
}

/**
 * The checkout that owns this test run.
 *
 * GIT IS THE PRIMARY SOURCE, and that is the whole point of this function's
 * shape. Worktrees in this repository live at `<primary>/.claude/worktrees/<name>`
 * — NESTED INSIDE the primary checkout. A plain "walk up to the first
 * pnpm-workspace.yaml" therefore sails straight past a worktree that does not
 * have one at its own root (sparse or partially-populated checkouts) and lands on
 * the PRIMARY, which then gets its database created and migrated by somebody
 * else's branch. Same class as the recorded absolute-path footgun, and the one
 * path where the per-checkout property genuinely broke.
 *
 * So: ask git which worktree we are in, and if that root has no
 * pnpm-workspace.yaml, REFUSE rather than keep walking. The walk survives only as
 * the non-git fallback.
 */
export function findCheckoutRoot(
  startDir: string,
  gitToplevel: (dir: string) => string | null = gitToplevelOf,
): string {
  const start = realpathSync(startDir);

  const top = gitToplevel(start);
  if (top) {
    if (!existsSync(join(top, 'pnpm-workspace.yaml'))) {
      throw new Error(
        `${start} is inside the git worktree ${top}, which has no pnpm-workspace.yaml.\n` +
          'Refusing to look further up: the next one belongs to the PARENT checkout, and using ' +
          "it would run this worktree's tests against the parent's database. Populate this " +
          'worktree fully, or run the tests from a complete checkout.',
      );
    }
    return top;
  }

  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find the checkout root above ${startDir} ` +
          '(no pnpm-workspace.yaml on any parent directory, and git could not name a worktree).',
      );
    }
    dir = parent;
  }
}

/**
 * A stable, filesystem-derived identity for this checkout.
 *
 * The directory name carries it so a human can tell whose database is whose; the
 * path hash carries the uniqueness, because two worktrees can share a basename.
 * `realpathSync` first, so a symlinked path does not mint a second identity for
 * the same checkout — there is a test that drives this through an actual symlink,
 * because a test whose helper pre-normalises the path cannot observe it.
 *
 * KNOWN PROPERTY: identity is the PATH, not the git worktree. A new checkout
 * created at a deleted one's path inherits its database, rows and all. Run
 * `pnpm --filter @deckgauge/api test:db:reset` if that matters to you;
 * `test:db:reset --list-orphans` shows databases whose checkout is gone.
 */
export function worktreeToken(checkoutRoot: string): string {
  const real = realpathSync(checkoutRoot);
  const slug =
    basename(real)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, MAX_SLUG_LENGTH) || 'checkout';
  const hash = createHash('sha1').update(real).digest('hex').slice(0, 8);
  return `${slug}_${hash}`;
}

/** The database name this checkout owns. */
export function derivedDatabaseName(checkoutRoot: string): string {
  return `${DERIVED_DATABASE_PREFIX}${worktreeToken(checkoutRoot)}`;
}

/** True for a name this module could have derived. The allowlist's shape test. */
export function isDerivedDatabaseName(database: string): boolean {
  return new RegExp(`^${DERIVED_DATABASE_PREFIX}[a-z0-9_]+_[0-9a-f]{8}$`).test(database);
}

/**
 * Reads a `KEY=value` env file. Skips blanks and `#` comments, unwraps matching
 * quotes. Intentionally no dotenv dependency — this is imported by vitest config
 * files, which load before any install-time assumption is safe.
 */
export function parseEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** The database name a connection URL names, or `''` if it names none. */
export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/**
 * Refuses every SERVER a test run must never open. Split out from the
 * database-name rules because maintenance URLs (`/postgres`) are legitimate
 * connections that name no test database — `ENTERPRISE_TEST_ADMIN_URL` is one,
 * and it is the only ambient value in the repository on a path that issues
 * `DROP DATABASE`.
 *
 * Two refusals, each with its own scar:
 *  - the staging PORT (:5433) — `packages/db`'s tests already write there;
 *  - NO explicit port — `@localhost/cockpit` is nobody's intent, and a port-only
 *    staging check waves it through to Postgres' default 5432.
 */
export function assertSafeTestServerUrl(url: string, context?: string): URL {
  const where = context ? ` (${context})` : '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Test database URL${where} is not a valid URL: ${url}`);
  }

  if (parsed.port === STAGING_POSTGRES_PORT) {
    throw new Error(
      `Refusing to run tests against ${parsed.host}${where} — port ${STAGING_POSTGRES_PORT} is ` +
        'the STAGING Postgres and the suites here create, mutate and delete rows. ' +
        'Point at the disposable test stack (docker-compose.test.yml, :55432), or remove the ' +
        'override from apps/api/.env.test.local.',
    );
  }

  if (!parsed.port) {
    throw new Error(
      `Test database URL${where} names no port: ${url}\n` +
        "Name the port explicitly. A portless URL silently takes Postgres' default 5432, " +
        'which is not the test stack (:55432) and defeats the staging-port check above.',
    );
  }

  return parsed;
}

/**
 * Refuses every URL a test run must never open as its TARGET. Called on the
 * resolved URL AND on any ambient override, because an unchecked passthrough is
 * how a staging value exported in a shell reached a worker fixture.
 *
 * ALLOWLIST: a derived `cockpit_wt_*` name passes; anything else needs
 * `allowNonDerived`; `NEVER_TEST_DATABASES` passes under no circumstances.
 */
export function assertSafeTestDatabaseUrl(
  url: string,
  options: { context?: string; allowNonDerived?: boolean } = {},
): void {
  const where = options.context ? ` (${options.context})` : '';
  assertSafeTestServerUrl(url, options.context);

  const database = databaseNameOf(url);
  if (!database) throw new Error(`Test DATABASE_URL${where} names no database: ${url}`);

  if ((NEVER_TEST_DATABASES as readonly string[]).includes(database)) {
    throw new Error(
      `Refusing to run tests against "${database}"${where} — under any setting.\n\n` +
        'Other worktrees and other sessions read it, and these suites create, mutate and delete ' +
        "rows — including applying this branch's migrations to it, which is the mechanism behind " +
        'the ~92 `P2022 column owner_overridden does not exist` incident.\n\n' +
        'Delete the DATABASE_URL override from apps/api/.env.test.local: every checkout already ' +
        'gets its own private database, which is what the per-plan-database convention was for.',
    );
  }

  if (!isDerivedDatabaseName(database) && !options.allowNonDerived) {
    throw new Error(
      `"${database}"${where} is not a database this checkout derived, so it may be shared with ` +
        'another worktree — these suites create, mutate and delete rows.\n\n' +
        'Delete the DATABASE_URL override to get a private per-worktree database. If you really ' +
        `mean to share one, say so in apps/api/.env.test.local:\n\n  ${ALLOW_NON_DERIVED_ENV}=1\n\n` +
        'It will still never be created or migrated by this checkout, and ' +
        `${NEVER_TEST_DATABASES.join(' / ')} is refused even with that set.`,
    );
  }
}

export interface TestDatabaseResolution {
  /** The full connection URL the suites must use. */
  url: string;
  /** Just the database name, for `current_database()` comparisons. */
  database: string;
  /**
   * Same SERVER, `postgres` database — for CREATE/DROP DATABASE.
   *
   * Always built from `TEST_POSTGRES_SERVER_URL`, never from an override, so an
   * override cannot redirect a `DROP … WITH (FORCE)` at another server.
   */
  maintenanceUrl: string;
  /**
   * True when the name came from this checkout's path rather than an override.
   *
   * This is also OWNERSHIP: `ensureTestDatabase` only creates or migrates a
   * database when it is true. A database somebody else named is verified, never
   * repaired forward.
   */
  derived: boolean;
  /**
   * True when this run may assume no other CHECKOUT is writing to the database,
   * which is what the two deployment-wide suites need before they clear a whole
   * table. Derived databases are exclusive by construction; an override has to
   * say so.
   */
  exclusive: boolean;
  /** Stable per-checkout token, also used to name shared ClickHouse objects. */
  token: string;
  checkoutRoot: string;
  /**
   * Which env file supplied `DATABASE_URL`, when one did. Undefined for a derived
   * database. Every message that names a file must use THIS rather than assume
   * `.env.test.local` — `parseEnvFile` discards provenance, and a pin in the
   * tracked `.env.test` was sending readers to a file that did not exist.
   */
  origin?: string;
  /** What to hand vitest as `test.env`. */
  env: Record<string, string>;
}

/**
 * Names the file a value actually came from, relative to the checkout, and says so
 * loudly when that file is TRACKED — because editing `apps/api/.env.test` is the
 * original footgun: it dirties every merge gate and has to be reverted by hand.
 */
function originOf(file: string | undefined, checkoutRoot: string): string | undefined {
  if (!file) return undefined;
  return file.startsWith(checkoutRoot) ? file.slice(checkoutRoot.length + 1) : file;
}

function describeOrigin(file: string | undefined, checkoutRoot: string): string {
  const relative = originOf(file, checkoutRoot);
  if (!relative) return 'DATABASE_URL override';
  const tracked = relative.endsWith('.env.test');
  return tracked
    ? `${relative} — a TRACKED file; put local overrides in ${relative}.local instead, ` +
        'so they do not dirty the merge gate'
    : relative;
}

/**
 * Resolves the test database for a checkout.
 *
 * `envFiles` are merged in order, so a later file overrides an earlier one —
 * `apps/api/.env.test` (tracked defaults) then `apps/api/.env.test.local`
 * (untracked, gitignored, per-developer).
 */
export function resolveTestDatabase(options: {
  startDir: string;
  envFiles?: string[];
  gitToplevel?: (dir: string) => string | null;
}): TestDatabaseResolution {
  const checkoutRoot = findCheckoutRoot(options.startDir, options.gitToplevel ?? gitToplevelOf);
  // Merge order = precedence, and PROVENANCE is kept per key. Without it every
  // refusal blamed `.env.test.local` by assumption — including when the value came
  // from the TRACKED `.env.test`, which is a live case: a worktree with an
  // uncommitted pin in that file was about to be sent to a file that does not
  // exist.
  const merged: Record<string, string> = {};
  const cameFrom: Record<string, string> = {};
  for (const file of options.envFiles ?? []) {
    for (const [key, value] of Object.entries(parseEnvFile(file))) {
      merged[key] = value;
      cameFrom[key] = file;
    }
  }

  const serverUrl = (merged.TEST_POSTGRES_SERVER_URL || DEFAULT_TEST_POSTGRES_SERVER_URL).replace(
    /\/+$/,
    '',
  );
  const override = merged.DATABASE_URL?.trim();
  const token = worktreeToken(checkoutRoot);

  const url = override || `${serverUrl}/${derivedDatabaseName(checkoutRoot)}`;
  const derived = !override;
  // An override may well be a per-plan database shared by several worktrees, so
  // it is NOT exclusive unless whoever wrote it says it is.
  const exclusive = derived || merged.DECKGAUGE_TEST_DB_EXCLUSIVE === '1';

  assertSafeTestDatabaseUrl(url, {
    context: derived ? undefined : describeOrigin(cameFrom.DATABASE_URL, checkoutRoot),
    allowNonDerived: merged[ALLOW_NON_DERIVED_ENV] === '1',
  });

  return {
    url,
    database: databaseNameOf(url),
    maintenanceUrl: `${serverUrl}/postgres`,
    derived,
    exclusive,
    token,
    checkoutRoot,
    origin: derived ? undefined : originOf(cameFrom.DATABASE_URL, checkoutRoot),
    env: {
      ...merged,
      DATABASE_URL: url,
      // Read by the suites that need to know they are alone. Deliberately two
      // variables: the name proves WHICH database, the flag proves the claim.
      DECKGAUGE_TEST_DB: databaseNameOf(url),
      DECKGAUGE_TEST_DB_EXCLUSIVE: exclusive ? '1' : '0',
      // Suffix for shared ClickHouse objects (roles, users, probe tables) and for
      // any suite that creates a fixed-name throwaway database: both are
      // server-global and therefore collide across worktrees by default.
      DECKGAUGE_TEST_WORKTREE_TOKEN: token,
    },
  };
}

/**
 * `resolveTestDatabase` with the canonical env-file locations filled in. Every
 * package's vitest config should use THIS.
 */
export function resolveCheckoutTestDatabase(
  startDir: string,
  gitToplevel: (dir: string) => string | null = gitToplevelOf,
): TestDatabaseResolution {
  const checkoutRoot = findCheckoutRoot(startDir, gitToplevel);
  return resolveTestDatabase({
    startDir,
    gitToplevel,
    envFiles: CHECKOUT_ENV_FILES.map((relative) => join(checkoutRoot, relative)),
  });
}

/**
 * The command that repairs this checkout's own database, named in every error
 * message so nobody has to go looking for it.
 */
export function resetHintFor(resolution: TestDatabaseResolution): string {
  if (resolution.derived) return 'pnpm --filter @deckgauge/api test:db:reset';
  // `resolution.origin`, not a hardcoded filename: the pin may well be in the
  // TRACKED `apps/api/.env.test`, and naming the wrong file sends its reader
  // somewhere that does not exist.
  const where = resolution.origin ?? 'your DATABASE_URL override';
  return (
    `${where} pins DATABASE_URL to "${resolution.database}", which this checkout does not own ` +
    '— reset it yourself, or delete the override to get a private per-worktree database'
  );
}

/** One row of `_prisma_migrations`, reduced to what the comparison needs. */
export interface MigrationRecord {
  migration_name: string;
  finished_at: Date | string | null;
  rolled_back_at: Date | string | null;
}

export interface MigrationComparison {
  /** Started, never finished, never rolled back. */
  failed: string[];
  /** Applied to the database but absent from this checkout — the database is AHEAD. */
  unknown: string[];
  /** Present in this checkout but not applied — the database is BEHIND. */
  missing: string[];
}

/**
 * Compares this checkout's migration directories against what a database has
 * applied. Pure, so the ahead/behind logic can be tested against a fake list
 * instead of only by breaking a real database.
 */
export function compareMigrations(
  local: string[],
  applied: MigrationRecord[],
): MigrationComparison {
  const localSet = new Set(local);
  const appliedSet = new Set(applied.map((m) => m.migration_name));
  return {
    failed: applied
      .filter((m) => m.finished_at === null && m.rolled_back_at === null)
      .map((m) => m.migration_name),
    unknown: applied
      .filter((m) => m.rolled_back_at === null && !localSet.has(m.migration_name))
      .map((m) => m.migration_name),
    missing: local.filter((name) => !appliedSet.has(name)),
  };
}
