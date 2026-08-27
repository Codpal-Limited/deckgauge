/**
 * Why an integration suite is allowed not to run — declared in ONE place, and
 * enforced in the merge gate.
 *
 * ## The failure mode this exists to remove
 *
 * A conditional skip is the most comfortable failure mode in this repository,
 * because it reports as health. Two incidents in one week, both from suites that
 * looked green:
 *
 *  - `apps/api/src/__isolation__/clickhouse-row-policy.int.test.ts` holds the
 *    assertion "the reader cannot activate a role it was never granted" — the exact
 *    fact that six docblocks, a design memo and a compose comment had backwards.
 *    It skipped for days, because the test ClickHouse had loaded its config before
 *    `vp_cockpit_console.xml` existed, so its access-management probe failed and the
 *    suite reported `↓ skipped`. In the meantime a defect shipped to `main` that
 *    broke analytics for every fresh install and for the whole OSS edition.
 *  - `apps/worker/src/__tests__/integration/*-dual-writer.int.test.ts` were gated on
 *    `INTEGRATION_CLICKHOUSE_URL`, which NOTHING in this repository set. Four tests
 *    that had never executed once, quoted as "5 skipped — clean" in nine reports.
 *
 * Both are the same bug, and it is not in any of those files: the gate had no way
 * to tell a suite that PASSED from a suite that never ran.
 *
 * ## The mechanism, in three parts
 *
 * 1. **A registry** (below). Every reason an integration suite may decline to run
 *    is a named capability with the env vars it needs, a live probe, and a remedy
 *    sentence. Nothing else is a legitimate reason.
 * 2. **One entry point**, `integrationGate(name)`, that a suite calls to decide
 *    whether to run. It is deliberately the only accepted spelling, so
 *    `scanIntegrationSuites` can find every suite that has one — and, more to the
 *    point, every suite that does NOT.
 * 3. **Strict mode**, `DECKGAUGE_TEST_STRICT_INTEGRATION=1`, which the root `test`
 *    script (the merge gate) sets. Under it, an unavailable capability is a NAMED
 *    FAILURE from the per-package coverage suite rather than a silent skip.
 *
 * ## Why strictness lives in a coverage suite and not in `integrationGate`
 *
 * The tempting shape is `describe.skipIf(unavailable && !strict)`, i.e. run the
 * suite anyway under strict mode and let it fail. That was rejected: it turns one
 * missing env var into a wall of ClickHouse connection errors across several files,
 * with the actual cause — "the test stack is not up" — nowhere in the output. The
 * gate needs to go red, but it needs to go red once, with the reason and the fix.
 *
 * So `integrationGate().skip` is `!available`, always. A skipped suite stays a
 * clean skip. What changes under strict mode is that
 * `integration-coverage.test.ts` in the same package fails, naming the capability,
 * the missing variables, and the command that repairs it.
 *
 * ## Why the check is not "did file X execute?"
 *
 * Vitest runs each test file in its own worker, so no test can observe whether
 * another file ran. Writing run-markers to disk and asserting over them was
 * considered and dropped — it depends on file ordering, leaves state behind, and
 * is wrong on the first run after a suite is renamed.
 *
 * The equivalent is provable in-process and is what the coverage suite asserts:
 * every integration suite in the package gets its condition from THIS registry
 * (`scanIntegrationSuites` proves there are no others), and every capability the
 * package declares is available (`probeCapability` proves the condition is false).
 * A gate that is open, over a set of suites with no other way to close, means the
 * suites ran.
 *
 * ## Alternatives weighed
 *
 * - **A reporter that prints skip reasons.** Kept as a property of the messages
 *   rather than as code: a reporter informs a human who is already reading the
 *   output, and cannot fail a gate. Nine reports quoted "5 skipped" without opening
 *   anything, so more text in the summary was not the missing piece.
 * - **A hand-written manifest of integration suites.** A tracked list drifts, and
 *   the thing it must catch is a NEW suite — the case where nobody remembers to
 *   edit the list. The scan derives the same list from the tree, so a new suite is
 *   caught by existing code.
 *
 * This module is dependency-free (node builtins only), like its sibling
 * `test-database.ts`, so vitest CONFIG files can import it before anything is built.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The merge gate sets this. See the root `test` script. */
export const STRICT_INTEGRATION_ENV = 'DECKGAUGE_TEST_STRICT_INTEGRATION';

/** How to bring the disposable test stack up — named in several remedies. */
export const TEST_STACK_UP_COMMAND =
  'docker compose -p vp-cockpit-test -f docker-compose.test.yml up -d';

export type CapabilityName =
  | 'clickhouse'
  | 'clickhouse-access-management'
  | 'clickhouse-console-user'
  | 'docker';

export interface CapabilityDefinition {
  /** Env vars that must all be non-empty before the capability can be attempted. */
  readonly requires: readonly string[];
  /** One sentence: what the capability is for. */
  readonly purpose: string;
  /** One sentence: what to run to get it. */
  readonly remedy: string;
  /**
   * A SYNCHRONOUS availability check, for a capability that no env var describes.
   *
   * `docker` has one and needs it: with `requires: []` and no sync check,
   * `integrationGate('docker').skip` would be permanently false and the six
   * testcontainer suites in this package would try to start containers on a machine
   * with no Docker — turning a clean skip into six timeouts. The previous condition
   * (`!hasDocker()`) really did probe, so anything weaker here is a regression.
   *
   * Synchronous because `describe.skipIf(...)` is evaluated at collection time.
   */
  readonly checkSync?: (env: Env) => { ok: boolean; detail: string };
}

/**
 * Every legitimate reason an integration suite in this repository may decline to
 * run. Adding a reason means adding an entry here, which is the point: an ad-hoc
 * `process.env.SOMETHING` condition is exactly what shipped four tests that never
 * executed, and `scanIntegrationSuites` now refuses it.
 */
export const CAPABILITIES: Readonly<Record<CapabilityName, CapabilityDefinition>> = {
  clickhouse: {
    /**
     * NOT validated the way `TEST_POSTGRES_SERVER_URL` is, and that asymmetry is a
     * known slice rather than a decision.
     *
     * `assertSafeTestServerUrl` refuses port 5433 (staging Postgres) and
     * `assertSafeTestDatabaseUrl` refuses the `cockpit` database under any flag. There
     * is no equivalent for this variable: whatever it names is where the suites read
     * and — since this branch — WRITE and DELETE. It is not reachable by accident,
     * because the only tracked value (`apps/api/.env.test`) is :58123 and an override
     * lives in the untracked `.env.test.local`. But the suite that was found reading
     * production ClickHouse now INSERTs and `DELETE`s through this variable, and one
     * suite (`timesheet-fetch-carry-in.int.test.ts`) hand-rolls the port check that
     * ought to live here for all of them. Lifting it into an
     * `assertSafeTestClickhouseUrl` is the fix; it is a slice, not a line.
     */
    requires: ['INTEGRATION_CLICKHOUSE_URL'],
    purpose: 'reads and writes the disposable test ClickHouse on :58123',
    remedy: `start the test stack — ${TEST_STACK_UP_COMMAND}`,
  },
  'clickhouse-access-management': {
    // Same two variables the row-policy suite used to check inline. They live here
    // now so the suite and the gate cannot disagree about what "available" means.
    requires: ['CLICKHOUSE_CONSOLE_URL', 'CLICKHOUSE_CONSOLE_PASSWORD'],
    purpose:
      'runs CREATE ROLE / CREATE ROW POLICY on the test ClickHouse, which every ' +
      'tenant boundary in ClickHouse depends on',
    remedy:
      'recreate the test ClickHouse so its entrypoint reapplies ' +
      'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 — docker compose -p vp-cockpit-test ' +
      '-f docker-compose.test.yml up -d --force-recreate clickhouse',
  },
  'clickhouse-console-user': {
    // A SEPARATE LOGIN from the ingest identity, so user-authored SQL runs
    // readonly. Distinct from `clickhouse-access-management` on purpose: that one
    // wants DDL rights as `cockpit`, this one wants this login to authenticate at
    // all — and a suite that checked only `CLICKHOUSE_CONSOLE_URL` +
    // `CLICKHOUSE_CONSOLE_PASSWORD` could not tell the two apart.
    requires: ['CLICKHOUSE_CONSOLE_URL', 'CLICKHOUSE_CONSOLE_USER', 'CLICKHOUSE_CONSOLE_PASSWORD'],
    purpose: 'runs user-authored SQL as the readonly query-console login',
    remedy:
      "recreate the test ClickHouse from a checkout that has the console user's " +
      'users.d XML mounted — an auth failure here is that missing mount, not a ' +
      'flake: docker compose -p vp-cockpit-test -f docker-compose.test.yml up -d ' +
      '--force-recreate clickhouse',
  },
  docker: {
    requires: [],
    purpose: 'starts throwaway containers (testcontainer suites)',
    remedy:
      'start the container engine (Rancher Desktop) and check `docker info` answers ' +
      'from the host — dockerd can be alive while the host socket bridge is down',
    checkSync: dockerAvailable,
  },
};

/** Where a vitest config stamps the once-per-RUN answer. See `dockerCapabilityEnv`. */
export const DOCKER_AVAILABLE_ENV = 'DECKGAUGE_DOCKER_AVAILABLE';
export const DOCKER_DETAIL_ENV = 'DECKGAUGE_DOCKER_DETAIL';

/**
 * `docker info`, resolved ONCE PER RUN rather than once per worker.
 *
 * Vitest gives each test file its own worker, so a spawn-based check is answered
 * independently in each — and the answers can differ. Observed on this host while
 * building this mechanism: one `packages/db` file skipped its 18 tests because its
 * worker's `docker info` failed under memory pressure, while the coverage suite's
 * own worker succeeded and therefore reported the capability available. The gate went
 * green with 18 tests silently absent, which is the exact defect this module exists
 * to remove, reappearing one level down.
 *
 * So the answer is resolved in the vitest CONFIG — which runs once, in the main
 * process — and stamped into `test.env` by `dockerCapabilityEnv()`. Every worker,
 * the coverage suite included, then reads the SAME answer.
 *
 * The spawn remains as a fallback for any caller outside that wiring, memoised per
 * process so six collection-time evaluations cost one spawn.
 */
let dockerCache: { ok: boolean; detail: string } | null = null;
function dockerAvailable(env: Env = process.env): { ok: boolean; detail: string } {
  const stamped = env[DOCKER_AVAILABLE_ENV];
  if (stamped === '1') return { ok: true, detail: '' };
  if (stamped === '0') {
    return {
      ok: false,
      detail: env[DOCKER_DETAIL_ENV] ?? '`docker info` did not succeed when this run started.',
    };
  }

  if (dockerCache) return dockerCache;
  dockerCache = probeDockerCli();
  return dockerCache;
}

/**
 * How long a single `docker info` gets, and how many attempts it gets.
 *
 * `docker info` is not a cheap local call on this host — it round-trips to a VM — and
 * it was measured TIMING OUT on 1 of 4 attempts under memory pressure while a shell
 * `docker info` answered in 0.12s. That matters more than it looks: the answer is now
 * resolved once per RUN, so a single unlucky attempt flips all 49 docker-gated tests
 * in `packages/db` to skipped and (under strict mode) reddens the gate for a reason
 * that has nothing to do with the code.
 *
 * So: a longer per-attempt budget than the generic network probe, and a retry. A
 * genuinely absent daemon still fails both attempts quickly — `docker info` returns a
 * connection error rather than hanging — so the cost of the retry is paid only in the
 * case it exists to fix.
 */
const DOCKER_PROBE_TIMEOUT_MS = 30_000;
const DOCKER_PROBE_ATTEMPTS = 2;

function probeDockerCli(): { ok: boolean; detail: string } {
  let last = '';
  for (let attempt = 1; attempt <= DOCKER_PROBE_ATTEMPTS; attempt++) {
    const info = spawnSync('docker', ['info'], {
      stdio: 'pipe',
      timeout: DOCKER_PROBE_TIMEOUT_MS,
    });
    if (info.status === 0) return { ok: true, detail: '' };
    // `error` is set when the spawn itself failed or the timeout fired; `status` is
    // null in that case, so reporting only the status hides the difference between
    // "no daemon" and "took too long", which are different problems.
    last =
      info.error?.message ??
      `exit ${info.status ?? 'null'}${info.signal ? ` (signal ${info.signal})` : ''}`;
  }
  return {
    ok: false,
    // No "dockerd may be alive while the socket bridge is down" here: the remedy
    // sentence already carries it, and printing it twice in one message trains readers
    // to skim the whole thing.
    detail:
      `\`docker info\` did not succeed from this host after ${DOCKER_PROBE_ATTEMPTS} ` +
      `attempts of up to ${DOCKER_PROBE_TIMEOUT_MS / 1000}s each — last: ${last}.`,
  };
}

/**
 * The env a vitest config must merge into `test.env` for any package whose suites
 * gate on `docker` — see the note above on why per-worker spawns disagree.
 *
 * Called from the config, so it runs once, before any worker starts.
 */
export function dockerCapabilityEnv(): Record<string, string> {
  // Deliberately NOT read from the ambient environment here: this is the function
  // that establishes the answer, and honouring a pre-set value would let a stale
  // export from an earlier shell decide it.
  const result = dockerAvailable({});
  return {
    [DOCKER_AVAILABLE_ENV]: result.ok ? '1' : '0',
    [DOCKER_DETAIL_ENV]: result.detail,
  };
}

const CAPABILITY_NAMES = Object.keys(CAPABILITIES) as CapabilityName[];

export function isCapabilityName(value: string): value is CapabilityName {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, value);
}

export interface CapabilityReport {
  readonly name: CapabilityName;
  readonly available: boolean;
  /** Env vars the definition asks for that are absent or empty. */
  readonly missing: readonly string[];
  /** Non-null exactly when `available` is false. Names the cause AND the fix. */
  readonly reason: string | null;
}

type Env = Record<string, string | undefined>;

function present(env: Env, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && value.trim() !== '';
}

function unavailable(name: CapabilityName, missing: string[], detail: string): CapabilityReport {
  const definition = CAPABILITIES[name];
  return {
    name,
    available: false,
    missing,
    reason:
      `integration capability "${name}" is NOT available, so the suites that need it ` +
      `did not run. It ${definition.purpose}. ${detail} Fix: ${definition.remedy}.`,
  };
}

function availableReport(name: CapabilityName): CapabilityReport {
  return { name, available: true, missing: [], reason: null };
}

/**
 * The env-only half: is the capability CONFIGURED?
 *
 * Synchronous on purpose — `describe.skipIf(...)` is evaluated at collection time,
 * so the condition a suite uses cannot be async.
 */
export function capabilityConfigured(
  name: CapabilityName,
  env: Env = process.env,
): CapabilityReport {
  const definition = CAPABILITIES[name];
  const missing = definition.requires.filter((key) => !present(env, key));
  if (missing.length > 0) {
    return unavailable(
      name,
      missing,
      `Unset or empty in this run's environment: ${missing.join(', ')}.`,
    );
  }
  if (definition.checkSync) {
    const result = definition.checkSync(env);
    if (!result.ok) return unavailable(name, [], result.detail);
  }
  return availableReport(name);
}

/**
 * The ONE way a suite in this repository decides whether to run.
 *
 * Deliberately the only accepted spelling: `scanIntegrationSuites` looks for this
 * call, so a suite that invents its own `process.env` condition fails the ratchet
 * instead of quietly never running.
 */
export function integrationGate(
  name: CapabilityName,
  env: Env = process.env,
): { skip: boolean; reason: string | null } {
  const report = capabilityConfigured(name, env);
  // `skip` is `!available` under strict mode too. Strictness is enforced by the
  // package's coverage suite, so an unavailable capability produces one named
  // failure rather than a wall of connection errors — see the header.
  return { skip: !report.available, reason: report.reason };
}

/**
 * `integrationGate` with the live probe folded in, for a suite that wants
 * unreachability to be a skip rather than a wall of connection errors.
 *
 * Use it with a top-level `await` — vitest evaluates that before collection, so it
 * is still a valid `describe.skipIf` condition. Two of the api suites already did
 * exactly this by hand; they now share the probe with the coverage suite, so the
 * two cannot disagree about what "reachable" means.
 */
export async function integrationGateLive(
  name: CapabilityName,
  env: Env = process.env,
): Promise<{ skip: boolean; reason: string | null }> {
  const report = await probeCapability(name, env);
  return { skip: !report.available, reason: report.reason };
}

export function isStrictIntegration(env: Env = process.env): boolean {
  return env[STRICT_INTEGRATION_ENV] === '1';
}

/**
 * What the coverage suite should do about a report. Pure, and separated from the
 * test so the strict/lenient branching is itself testable without a live stack.
 */
export type Enforcement =
  | { outcome: 'ok' }
  | { outcome: 'fail'; message: string }
  | { outcome: 'skip'; message: string };

export function enforce(report: CapabilityReport, env: Env = process.env): Enforcement {
  if (report.available) return { outcome: 'ok' };
  const reason = report.reason ?? `integration capability "${report.name}" is NOT available.`;
  if (isStrictIntegration(env)) {
    return {
      outcome: 'fail',
      message:
        `${reason}\n\nThis is a FAILURE rather than a skip because ` +
        `${STRICT_INTEGRATION_ENV}=1 — the merge gate runs strict, so a suite that ` +
        'does not run cannot report as one that passed. Running a single package ' +
        '(`pnpm --filter @deckgauge/api test`) is lenient and will skip instead.',
    };
  }
  return {
    outcome: 'skip',
    message:
      `${reason}\n\nSkipped rather than failed because ${STRICT_INTEGRATION_ENV} is ` +
      'not 1. The merge gate (`pnpm test`) runs strict and will FAIL on this.',
  };
}

/* ────────────────────────────── live probes ────────────────────────────── */

/** Strips userinfo out of a URL and returns it as a Basic credential. */
function splitCredentials(raw: string): { origin: string; authorization: string | null } {
  const url = new URL(raw);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  const authorization =
    user || password
      ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
      : null;
  return { origin: url.origin, authorization };
}

const PROBE_TIMEOUT_MS = 10_000;

async function clickhouseStatement(
  baseUrl: string,
  statement: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { origin, authorization } = splitCredentials(baseUrl);
  try {
    const response = await fetch(origin, {
      method: 'POST',
      body: statement,
      headers: authorization ? { authorization } : undefined,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}: ${text.trim()}` };
    // ClickHouse answers 200 with an exception body for some access errors, so the
    // status alone is not the answer. Positive check on the payload rather than a
    // `not.toContain`-shaped one: an empty body is the success case for DDL.
    if (/^Code: \d+\. DB::Exception/.test(text.trim())) {
      return { ok: false, detail: text.trim() };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Same as `clickhouseStatement`, but with the credentials supplied separately —
 * ClickHouse's HTTP interface takes them as `X-ClickHouse-User` / `-Key` headers,
 * which is how a login other than the URL's userinfo is exercised.
 */
async function clickhouseStatementAs(
  origin: string,
  user: string,
  password: string,
  statement: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const response = await fetch(origin, {
      method: 'POST',
      body: statement,
      headers: { 'X-ClickHouse-User': user, 'X-ClickHouse-Key': password },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}: ${text.trim()}` };
    if (/^Code: \d+\. DB::Exception/.test(text.trim())) {
      return { ok: false, detail: text.trim() };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A per-checkout suffix for the throwaway objects a probe creates. ClickHouse
 * roles are server-global, so an unsuffixed probe role is a name two worktrees
 * fight over.
 */
function probeToken(env: Env): string {
  return env.DECKGAUGE_TEST_WORKTREE_TOKEN ?? 'local';
}

/**
 * Configured AND actually reachable.
 *
 * The second half is not decoration: the row-policy incident had every variable
 * set and the capability revoked underneath the running container, which is
 * precisely the case an env-presence check reports as healthy.
 */
export async function probeCapability(
  name: CapabilityName,
  env: Env = process.env,
): Promise<CapabilityReport> {
  const configured = capabilityConfigured(name, env);
  if (!configured.available) return configured;

  if (name === 'clickhouse') {
    const result = await clickhouseStatement(env.INTEGRATION_CLICKHOUSE_URL!, 'SELECT 1');
    if (result.ok) return availableReport(name);
    return unavailable(
      name,
      [],
      `INTEGRATION_CLICKHOUSE_URL is set but the server did not answer. ${result.detail}`,
    );
  }

  if (name === 'clickhouse-access-management') {
    // Same shape the row-policy suite used inline: the console URL names the HOST,
    // and the statements run as the ingest login, which is the one the entrypoint
    // grants access management to.
    const host = new URL(env.CLICKHOUSE_CONSOLE_URL!).host;
    const adminUrl = `http://cockpit:cockpit@${host}`;
    const role = `dg_capability_probe_${probeToken(env)}`;
    const created = await clickhouseStatement(adminUrl, `CREATE ROLE IF NOT EXISTS ${role}`);
    if (!created.ok) {
      return unavailable(
        name,
        [],
        'CREATE ROLE was refused, so row policies cannot be provisioned. ' +
          `The image applies CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT by rewriting a MOUNTED users.d file, and a \`git checkout\` of that file revokes it from the running server. ${created.detail}`,
      );
    }
    await clickhouseStatement(adminUrl, `DROP ROLE IF EXISTS ${role}`);
    return availableReport(name);
  }

  if (name === 'clickhouse-console-user') {
    const { origin } = splitCredentials(env.CLICKHOUSE_CONSOLE_URL!);
    const result = await clickhouseStatementAs(
      origin,
      env.CLICKHOUSE_CONSOLE_USER!,
      env.CLICKHOUSE_CONSOLE_PASSWORD!,
      'SELECT 1',
    );
    if (result.ok) return availableReport(name);
    return unavailable(
      name,
      [],
      `The console login "${env.CLICKHOUSE_CONSOLE_USER}" could not authenticate. ${result.detail}`,
    );
  }

  // docker: the sync check inside `capabilityConfigured` above IS the probe, so
  // reaching here means it already passed. Returning early rather than repeating the
  // spawn keeps one definition of "docker is available", which is the property this
  // whole module exists to hold.
  return configured;
}

/* ─────────────────────── the ratchet over test files ─────────────────────── */

/**
 * Line and block comments removed, so a mention in prose cannot satisfy a check.
 *
 * ## Why this is a scanner and not two regexes
 *
 * It used to be a block-comment regex followed by a line-comment regex, and that is
 * unsound on ordinary code, because a comment OPENER and a comment CLOSER both occur
 * inside ordinary STRING LITERALS. Measured, on the smallest realistic input — two
 * turbo globs in one JSON object:
 *
 *     {"a":["dist/**"],"b":["src/**\/*.ts"]}
 *       becomes
 *     {"a":["dist*.ts"]}
 *
 * The opener came from inside `"dist/**"`, the closer from inside the second glob, and
 * everything between them vanished — while the result still PARSED as JSON. The first
 * of those globs is on line 6 of this repository's own `turbo.json`, and the second is
 * the commonest turbo `inputs` glob, so the two halves genuinely co-occur.
 *
 * In the JSON path that direction fails loudly. In the SCANNER path it is a SILENT
 * FALSE NEGATIVE: a suite whose `describe.skipIf(` sits between two such literals goes
 * invisible, which is exactly the class of defect this module exists to remove. Nine
 * tracked test files already carry unbalanced opener/closer sequences, one of them a
 * docker-gated suite — so the old version held by luck, and the next glob somebody
 * added would have decided it.
 *
 * So this tracks string state instead: single-quoted, double-quoted and template
 * literals are copied through untouched (honouring backslash escapes, and returning to
 * code inside a template's interpolation), and only an opener reached in CODE state
 * starts a comment. Newlines are preserved so reported line numbers still land.
 *
 * ## The one boundary that remains, stated rather than papered over
 *
 * Regex literals are not tracked — telling `/re/` from division needs real parsing. In
 * practice a regex that means a literal comment opener writes it escaped, which
 * contains no bare opener, so it does not bite in this repository today. A character
 * class holding both characters would. If that ever appears the fix is a tokenizer,
 * not another special case.
 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  /** Depth of `${...}` inside template literals, so `}` knows where to return to. */
  let templateDepth = 0;
  let state: 'code' | 'single' | 'double' | 'template' = 'code';

  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
          if (text[i] === '\n') out += '\n';
          i++;
        }
        i += 2;
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      else if (ch === '}' && templateDepth > 0) {
        templateDepth--;
        state = 'template';
      }
      out += ch;
      i++;
      continue;
    }

    if (ch === '\\') {
      out += ch;
      if (i + 1 < text.length) out += text[i + 1];
      i += 2;
      continue;
    }
    if (state === 'single' && ch === "'") state = 'code';
    else if (state === 'double' && ch === '"') state = 'code';
    else if (state === 'template') {
      if (ch === '`') state = 'code';
      else if (ch === '$' && next === '{') {
        templateDepth++;
        state = 'code';
        out += '${';
        i += 2;
        continue;
      }
    }
    out += ch;
    i++;
  }

  return out;
}

/**
 * A file this ratchet holds to the registry.
 *
 * Two shapes, because either one on its own leaves a hole:
 *  - named `*.int.test.ts` — declares itself an integration suite, so it must say
 *    what it needs even if it currently has no gate at all;
 *  - can decline to run at all, whatever it is named — see `CONDITIONAL_SKIP_FORMS`.
 *    This is the half that catches a suite which grows a condition later.
 */
export const INTEGRATION_FILE_SUFFIX = '.int.test.ts';

/**
 * Every way a suite in this repository can decide, at run time, not to run.
 *
 * **This list was one regex, `/\.skipIf\s*\(/`, and that was a false claim.** The
 * docblock above already said "whatever it is named"; the pattern only implemented
 * `describe.skipIf(...)`. `apps/worker/src/org-tree-sync/org-sync-aggregator.test.ts`
 * declined through `if (!organizationId) ctx.skip()` — vitest's TEST-CONTEXT skip,
 * a different token — so the scan could not see it, and the worker's coverage suite
 * asserted "every skippable test file declares a registry capability" and passed with
 * a skippable suite outside the registry. The cost was not hypothetical: that suite
 * read the `clickhouse` singleton, which with `CLICKHOUSE_URL` unset falls back to
 * :8123 — **staging** — so a green gate run had read production rows.
 *
 * ## Derived from a corrected scan, and the first scan's error is recorded
 *
 * Over all **783 tracked `*.test.ts(x)`** files (plus 7 playwright `*.spec.ts`, which
 * vitest does not run), using the string-aware `stripComments` below:
 *
 * | form | files |
 * |---|---|
 * | `.skipIf(` | 18 |
 * | `.runIf(` | 0 |
 * | context `.skip(` | 4 |
 * | unconditional `describe｜it｜test.skip(` | 1 vitest (+2 playwright) |
 * | `describe.skip` as a VALUE (ternary/alias) | 3 |
 * | `.todo(`, `it.fails(` | 0 |
 *
 * The first attempt at this table reported `.skipIf(` as 17 and "unconditional" as 3.
 * Both were wrong, in instructive ways. 17 came from the OLD regex-pair
 * `stripComments`, which over-ate string literals and swallowed a `skipIf` along with
 * them. The 3 counted the two playwright `.spec.ts` files as though vitest ran them.
 *
 * And the last row **did not exist in that scan at all** — there was no pattern for
 * `describe.skip` used as a VALUE. That, not a miscount, is why
 * `packages/enterprise/src/billing/measured-counter.integration.test.ts` went
 * unrecorded while its sibling `store.integration.test.ts` was disclosed: the sibling
 * had been read by hand for an unrelated reason, and nothing surfaced the other. **A
 * bucket that does not exist reports zero, and zero reads as clean.**
 *
 * ## What is deliberately NOT here, and the boundary is real
 *
 * An unconditional `describe.skip(` / `it.skip(` CALL is honest — it is disabled, it
 * reports as disabled every single run, and nothing about the environment can make it
 * look like a pass. An early `return` inside a test body is not statically detectable
 * and nothing here pretends to catch it. If you are tempted to write one, the reason
 * your suite may not run is a capability, and this file is where it goes.
 */
export interface SkipForm {
  /** Stable name, so a test can assert WHICH form a file uses. */
  readonly label: string;
  readonly pattern: RegExp;
}

export const CONDITIONAL_SKIP_FORMS: readonly SkipForm[] = [
  // `describe.skipIf(...)` / `it.skipIf(...)` / `test.skipIf(...)`.
  { label: 'skipIf', pattern: /\.skipIf\s*\(/ },
  // The inverse, same hazard.
  { label: 'runIf', pattern: /\.runIf\s*\(/ },
  // A test-context skip: `ctx.skip()`, `context.skip(reason)`. Negative lookahead on
  // the honest unconditional forms, which are a different thing — see above.
  {
    label: 'context-skip',
    pattern: /\b(?!describe\b|it\b|test\b|suite\b)[A-Za-z_$][\w$]*\s*\.\s*skip\s*\(/,
  },
  // `const suite = available ? describe : describe.skip` — the form both
  // `packages/enterprise` integration suites use, and the one no pattern here had.
  //
  // It cannot distinguish a conditional ternary from an unconditional alias
  // (`const suite = describe.skip`), and it deliberately errs toward "declare it":
  // for a ratchet, a false positive costs one line in an EXEMPT list, while a false
  // negative costs a suite that silently never runs. This branch exists because the
  // second kind was cheaper to live with than to notice.
  { label: 'skip-as-value', pattern: /\b(?:describe|it|test)\s*\.\s*skip\b(?!\s*\()/ },
];

/** Which forms a file uses, by label. Empty means it always runs. */
export function matchingSkipForms(code: string): string[] {
  return CONDITIONAL_SKIP_FORMS.filter((f) => f.pattern.test(code)).map((f) => f.label);
}

function canDeclineToRun(code: string): boolean {
  return CONDITIONAL_SKIP_FORMS.some((f) => f.pattern.test(code));
}
/**
 * `integrationGate('clickhouse')` or `integrationGateLive('clickhouse')` — single
 * or double quoted. Both spellings, because the async one is the right choice for
 * a suite that wants unreachability (not just an unset variable) to be a skip.
 */
const GATE_CALL = /integrationGate(?:Live)?\s*\(\s*['"]([a-z-]+)['"]/g;

export interface IntegrationSuiteScan {
  /** Path relative to the scanned root. */
  readonly file: string;
  /** Registry capabilities the file declares, sorted and de-duplicated. */
  readonly capabilities: readonly CapabilityName[];
  /** True when the file can decline to run but declares no registry capability. */
  readonly undeclared: boolean;
}

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__fixtures__') continue;
      testFiles(full, acc);
      continue;
    }
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) acc.push(full);
  }
  return acc;
}

/**
 * Every file under `root` that can decline to run, and what it says it needs.
 *
 * `exempt` takes paths relative to `root`, matched as prefixes. Use it only for a
 * skip that is genuinely not about an integration capability, and say why at the
 * call site — an exemption is the one way back to the defect this file removes.
 */
export function scanIntegrationSuites(
  root: string,
  exempt: readonly string[] = [],
): IntegrationSuiteScan[] {
  const scans: IntegrationSuiteScan[] = [];
  for (const file of testFiles(root)) {
    const rel = relative(root, file);
    if (exempt.some((prefix) => rel === prefix || rel.startsWith(prefix))) continue;

    const raw = readFileSync(file, 'utf8');
    const isIntegrationName = file.endsWith(INTEGRATION_FILE_SUFFIX);
    // Comments stripped BEFORE the check. A ratchet in this repository was already
    // defeated once by its own explanatory comment satisfying the pattern it
    // scanned for.
    const code = stripComments(raw);
    const canSkip = canDeclineToRun(code);
    if (!isIntegrationName && !canSkip) continue;

    const capabilities = new Set<CapabilityName>();
    for (const match of code.matchAll(GATE_CALL)) {
      const name = match[1];
      if (name && isCapabilityName(name)) capabilities.add(name);
    }
    scans.push({
      file: rel,
      capabilities: [...capabilities].sort(),
      undeclared: capabilities.size === 0,
    });
  }
  return scans.sort((a, b) => a.file.localeCompare(b.file));
}

/** The capabilities a whole package's integration suites depend on. */
export function capabilitiesDeclaredIn(scans: readonly IntegrationSuiteScan[]): CapabilityName[] {
  const all = new Set<CapabilityName>();
  for (const scan of scans) for (const name of scan.capabilities) all.add(name);
  return [...all].sort();
}

/** Exported for the registry's own tests. */
export const ALL_CAPABILITIES: readonly CapabilityName[] = CAPABILITY_NAMES;

/* ─────────────── the repository-wide half of the same question ─────────────── */

/**
 * Every package that owns a coverage suite is identified by this basename, and the
 * set of them is DERIVED rather than listed. A hand-written list of "packages with
 * integration suites" is the thing that goes stale when somebody adds the ninth.
 */
export const COVERAGE_SUITE_BASENAME = 'integration-coverage.test.ts';

export interface CoverageAudit {
  /** Every tracked `*.int.test.ts` in the checkout, repo-relative. */
  readonly suites: readonly string[];
  /** Every tracked coverage suite, repo-relative. */
  readonly coverageSuites: readonly string[];
  /** Package `src/` roots that a coverage suite covers, e.g. `apps/api/src/`. */
  readonly coveredRoots: readonly string[];
  /** Integration suites in a package with NO coverage suite. Must be empty. */
  readonly uncovered: readonly string[];
}

/**
 * Answers the question a per-package ratchet structurally cannot: is there an
 * integration suite somewhere in this repository that no coverage suite watches?
 *
 * `apps/api/src/__isolation__/ch-read-adoption.test.ts` records the lesson this
 * implements — a ratchet proves something about the directory it scans and nothing
 * about any other, and an empty list from one directory was read as evidence about
 * the whole codebase. So rather than each package asserting its sibling exists by
 * name, the roots are derived from where the coverage suites actually are and every
 * integration suite must fall inside one.
 *
 * Uses `git ls-files`, so an untracked scratch file is not a gate failure.
 */
export function auditIntegrationCoverage(checkoutRoot: string): CoverageAudit {
  const tracked = execFileSync('git', ['-C', checkoutRoot, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\0')
    .filter(Boolean);

  const suites = tracked.filter((f) => f.endsWith(INTEGRATION_FILE_SUFFIX)).sort();
  const coverageSuites = tracked
    .filter((f) => f.endsWith(`/${COVERAGE_SUITE_BASENAME}`))
    .sort();

  const coveredRoots = coveredRootsOf(coverageSuites);
  return { suites, coverageSuites, coveredRoots, uncovered: uncoveredIn(suites, coveredRoots) };
}

/**
 * The package `src/` roots a set of coverage-suite paths covers — the path up to and
 * including `/src/`, which is the same boundary `scanIntegrationSuites` is handed.
 */
export function coveredRootsOf(coverageSuites: readonly string[]): string[] {
  return [
    ...new Set(
      coverageSuites
        .map((f) => {
          const marker = f.indexOf('/src/');
          return marker === -1 ? null : f.slice(0, marker + '/src/'.length);
        })
        .filter((root): root is string => root !== null),
    ),
  ].sort();
}

/**
 * Integration suites that fall inside none of the covered roots.
 *
 * **Exported for one reason, and it is not tidiness.** This logic was inline in
 * `auditIntegrationCoverage`, and its test declared its own arrays and
 * re-implemented the filter in the test body — so hardcoding `uncovered` to `[]`
 * left every assertion green, including the `toEqual([])` that is the whole point.
 * The test asserted `Array.prototype.filter`. That is this repository's recorded
 * "assert the value, not a proxy" defect, and it had reappeared inside the unit suite
 * of the mechanism built to eliminate it. Pulling the pure part out means the test can
 * call the REAL function with fixture inputs.
 */
export function uncoveredIn(
  suites: readonly string[],
  coveredRoots: readonly string[],
): string[] {
  return suites.filter((f) => !coveredRoots.some((root) => f.startsWith(root)));
}
