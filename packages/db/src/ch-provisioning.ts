import {
  CH_ISO_POLICY_OBJECTS_QUERY,
  CH_SHARED_OBJECTS,
  catchAllDenyDdl,
  fetchPolicyObjects,
  ingestIdentityDdl,
  organizationPolicyDdl,
  readIdentityDefaultRoleDdl,
  readIdentityPermissivePolicyQuery,
  readIdentityRoleGrantDdl,
  roleNameFor,
  sharedObjectAllowDdl,
  type ChPolicyQueryClient,
} from './ch-row-policies.js';

/**
 * Executes one ClickHouse statement and returns whatever rows it produced
 * (empty for DDL).
 *
 * The whole provisioning surface takes this function rather than a client
 * object so callers can inject it. `packages/db/src/clickhouse.ts` builds its
 * client at import time with a hard-coded fallback of localhost:8123 — the
 * STAGING server — so a unit test that constructs the real client points at
 * real data. One injected function makes that impossible to do by accident.
 */
export type ChStatementExecutor = (
  query: string,
) => Promise<ReadonlyArray<Record<string, unknown>>>;

/**
 * The subset of @clickhouse/client used here. `command` and `exec` are both
 * optional so this accepts every DDL-capable client shape in the repo —
 * `ClickhouseExecClient` (exec) and the migration script's `ChExec` (command) —
 * with at least one required at runtime.
 */
export interface ChCommandClient {
  /**
   * Preferred for DDL when present. `exec` hands back a response stream the
   * caller is expected to consume; provisioning issues dozens of DDL statements
   * in a row, and leaving that many streams open exhausts the client's
   * connection pool. `command` has no stream to leak.
   */
  command?(params: { query: string }): Promise<unknown>;
  exec?(params: { query: string }): Promise<unknown>;
  query(params: { query: string; format?: string }): Promise<{ json(): Promise<unknown> }>;
}

/**
 * Adapts a real ClickHouse client to ChStatementExecutor. SELECTs go through
 * `query` (they must return rows); everything else through `command`/`exec`.
 */
export function chExecutorFromClient(client: ChCommandClient): ChStatementExecutor {
  return async (query: string) => {
    if (/^\s*(SELECT|SHOW|DESCRIBE)\b/i.test(query)) {
      const result = await client.query({ query, format: 'JSONEachRow' });
      return (await result.json()) as ReadonlyArray<Record<string, unknown>>;
    }
    if (client.command) await client.command({ query });
    else if (client.exec) await client.exec({ query });
    else throw new Error('chExecutorFromClient: the client exposes neither command() nor exec()');
    return [];
  };
}

/**
 * The ClickHouse user the apps connect as when nothing overrides it — the same
 * default `docker-compose.yml` interpolates into `CLICKHOUSE_URL`
 * (`${CLICKHOUSE_USER:-cockpit}`).
 */
export const CH_DEFAULT_SERVICE_USER = 'cockpit';

/**
 * The identity every ClickHouse read in the product runs as, resolved from the
 * same configuration the apps themselves use.
 *
 * Both the API and the worker read through the singleton in
 * `packages/db/src/clickhouse.ts`, which connects with `CLICKHOUSE_URL` —
 * `http://${CLICKHOUSE_USER:-cockpit}:…@clickhouse:8123/cockpit` in
 * docker-compose. So the order here mirrors how the value is actually supplied:
 *
 *   1. `CLICKHOUSE_USER`, which is where an operator overrides the name;
 *   2. the userinfo of `CLICKHOUSE_URL`, because compose only passes
 *      `CLICKHOUSE_USER` to the ClickHouse *server* container — inside the api
 *      and worker containers the name exists solely inside the URL, so reading
 *      the env var alone would resolve to the default while the apps connect as
 *      something else;
 *   3. `CH_DEFAULT_SERVICE_USER`, the compose default.
 *
 * Deliberately not a hardcoded literal: the whole point is that whoever changes
 * the connection user does not also have to remember to change provisioning.
 */
export function resolveServiceIdentityUser(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env.CLICKHOUSE_USER?.trim();
  if (configured !== undefined && configured !== '') return configured;
  return userFromClickHouseUrl(env.CLICKHOUSE_URL) ?? CH_DEFAULT_SERVICE_USER;
}

/** The userinfo name in a ClickHouse URL, or undefined if there is none. */
function userFromClickHouseUrl(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === '') return undefined;
  try {
    const { username } = new URL(url);
    return username === '' ? undefined : decodeURIComponent(username);
  } catch {
    // A malformed URL is not this function's problem to report — the client
    // that connects with it will fail loudly enough. Fall through to the
    // default rather than crash provisioning on a parse error.
    return undefined;
  }
}

/**
 * The ClickHouse login the API reads product analytics through, resolved from
 * configuration — or `undefined` when no read identity is configured at all.
 *
 * **This is a DIFFERENT identity from resolveServiceIdentityUser(), and the two
 * must never resolve to the same user.** The ingest identity carries
 * `ingest_all … USING 1` on every object, which is correct for the worker (design
 * doc D1) and fatal for a reader: permissive policies OR together, so that one
 * policy makes every `role=` scoping request a no-op. Splitting the identities is
 * what makes D3's per-query role mean anything.
 *
 * Resolution mirrors resolveServiceIdentityUser: `CLICKHOUSE_READ_USER` first,
 * because that is where an operator names it, then the userinfo of
 * `CLICKHOUSE_READ_URL`, because a container is given the connection as a URL and
 * the name lives inside it.
 *
 * There is deliberately **no default**. An unset read identity means the read
 * path has not been split on this deployment yet — reads still go through the
 * ingest identity, exactly as they did before D3 — and provisioning skips the
 * read-identity steps and reports the absence rather than inventing a user name
 * and then refusing because it does not exist. Defaulting the name would turn
 * every existing deployment's next migration into a hard failure.
 */
export function resolveApiReadIdentityUser(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const configured = env.CLICKHOUSE_READ_USER?.trim();
  if (configured !== undefined && configured !== '') return configured;
  return userFromClickHouseUrl(env.CLICKHOUSE_READ_URL);
}

export interface ChBaselineOptions {
  /**
   * Overrides the service identity that gets the cross-organization read
   * policy. Defaults to resolveServiceIdentityUser(). Tests pass a user they
   * created; production leaves it alone and lets configuration decide.
   */
  readonly serviceUser?: string;
  /**
   * Overrides the API read identity that gets `DEFAULT ROLE NONE` plus a grant of
   * every organization's role. Defaults to resolveApiReadIdentityUser(), i.e.
   * configuration; `undefined` from both means no read identity is configured and
   * the read-identity steps are skipped.
   */
  readonly apiReadUser?: string;
}

/** What the row-policy baseline actually covered, per object class. */
export interface ChCoverageReport {
  /** Every object that now carries the catch-all deny. */
  readonly denied: readonly string[];
  /** Objects carrying organization_id, i.e. what a per-organization policy can re-admit. */
  readonly tenant: readonly string[];
  /** Declared non-tenant objects deliberately left world-readable (CH_SHARED_OBJECTS). */
  readonly shared: readonly string[];
  /**
   * Objects the catch-all denies that NO per-organization policy can re-admit,
   * because they have no organization_id and are not on the shared list. These
   * are readable by the ingest identity only. Reported rather than silently
   * tolerated: this is the state that would blank a future lookup or rollup
   * table's analytics, and callers are expected to surface it.
   */
  readonly unreadable: readonly string[];
  /**
   * Tenant-carrying objects that hold NO `iso_` policy yet, so no organization
   * can read them.
   *
   * This is the state a migration that adds a tenant table leaves behind: the
   * baseline denies the new table, and only re-provisioning writes the
   * per-organization predicates that let anyone read it. It fails closed, which
   * is correct — but it is otherwise invisible, because the object has an
   * organization_id and so never shows up in `unreadable`. Reported so "analytics
   * went empty after a deploy" is one line of output instead of an afternoon.
   */
  readonly needsReprovision: readonly string[];
  /**
   * The service identity that was re-admitted across every object, i.e. the user
   * the API and worker connect as.
   *
   * **This identity reads CROSS-ORGANIZATION, exactly as it did before this
   * branch — that is the deliberate, documented interim state.** Both apps share
   * one connection (`packages/db/src/clickhouse.ts`), no per-organization
   * ClickHouse credential exists yet, and inventing one is explicitly out of
   * scope. What the catch-all buys today is the *default*: any OTHER identity —
   * a console user, a future per-organization user, an operator's ad-hoc client
   * — is denied unless something grants it access, and a table added by a later
   * migration is denied the moment it appears. Application-level scoping is
   * still what separates tenants in the read path.
   *
   * Reported so it appears in the migration CLI output: an operator who expects
   * per-organization isolation at the connection layer should be able to see, in
   * one line, that one identity still spans every organization.
   */
  readonly serviceIdentity: string;
  /**
   * The API read identity that now holds `DEFAULT ROLE NONE` and a grant of every
   * organization's role — or `undefined` when none is configured.
   *
   * When it is set, this is the login the product's reads are meant to run
   * through, activating exactly one organization's role per query (design doc
   * D3). When it is `undefined`, no read identity exists on this deployment and
   * reads still go through `serviceIdentity`, which spans every organization.
   *
   * Reported for the same reason `serviceIdentity` is: an operator should be able
   * to see from one line of migration output whether the read path is split, and
   * not have to infer it from which environment variables happen to be set.
   */
  readonly apiReadIdentity: string | undefined;
}

export interface ChProvisionResult {
  /** The organization's ClickHouse role, as an unquoted logical name. */
  readonly role: string;
  readonly coverage: ChCoverageReport;
  /** How many statements were executed, for logging. */
  readonly statements: number;
}

function queryClientFor(exec: ChStatementExecutor): ChPolicyQueryClient {
  return {
    query: async ({ query }) => ({ json: async () => exec(query) }),
  };
}

async function runAll(exec: ChStatementExecutor, statements: readonly string[]): Promise<number> {
  for (const statement of statements) await exec(statement);
  return statements.length;
}

/**
 * Reads back whether the configured service identity exists as a ClickHouse
 * user, and refuses the whole pass if it does not.
 *
 * Why refuse rather than skip: `TO <grantee>` is resolved at DDL time and an
 * unknown name is looked up as a role, so the grant below would fail with
 * `Code 511 UNKNOWN_ROLE` anyway — but only *after* the catch-all had landed,
 * leaving the deny in place with nothing re-admitting the apps. Checking first
 * means a missing user aborts before any policy is written, so the server is
 * left exactly as it was. Skipping the grant instead would produce precisely the
 * silent failure this check exists to prevent: every dashboard reading zero rows
 * and no error anywhere.
 *
 * Reading `system.users` needs the same ACCESS MANAGEMENT grant that row-policy
 * DDL already needs, so this adds no new prerequisite; if the identity running
 * provisioning cannot read it, that error propagates rather than being guessed
 * around.
 */
async function chUserExists(exec: ChStatementExecutor, user: string): Promise<boolean> {
  // Safe to interpolate: every caller validates `user` through a DDL generator
  // (SAFE_ID plus the grantee-keyword rejection) before this runs.
  const rows = await exec(`SELECT count() AS c FROM system.users WHERE name = '${user}'`);
  return Number((rows[0] as { c?: unknown } | undefined)?.c ?? 0) > 0;
}

async function assertServiceIdentityExists(
  exec: ChStatementExecutor,
  user: string,
): Promise<void> {
  if (await chUserExists(exec, user)) return;
  throw new Error(
    `ClickHouse service identity '${user}' does not exist, so the row-policy baseline was NOT ` +
      `applied. The catch-all deny is 'USING 0 TO ALL' and TO ALL includes the user the API and ` +
      `worker connect as, so without a permissive policy for that user every ClickHouse read in ` +
      `the product returns zero rows — silently. Create the user, or point CLICKHOUSE_USER / ` +
      `CLICKHOUSE_URL at the identity the apps actually connect as, and re-run. Refusing here ` +
      `rather than skipping the grant: skipping it is the silent failure.`,
  );
}

/**
 * Refuses a configuration in which the API read identity and the ingest identity
 * are the same ClickHouse user.
 *
 * Not a style objection — it makes isolation a no-op. The baseline grants the
 * ingest identity `ingest_all … USING 1` on every object so the worker can write
 * for every tenant (design doc D1), and permissive row policies combine with OR.
 * A reader holding that policy therefore sees every organization's rows no matter
 * which role its query activates: the `role=` parameter is honoured and changes
 * nothing. Verified, not reasoned about.
 *
 * It is refused rather than warned about because the resulting state is
 * indistinguishable from success from the outside — every dashboard renders, every
 * query returns rows, and the rows are simply not filtered by tenant.
 */
function assertIdentitiesAreDistinct(
  serviceIdentity: string,
  apiReadIdentity: string | undefined,
): void {
  if (apiReadIdentity === undefined || apiReadIdentity !== serviceIdentity) return;
  throw new Error(
    `The ClickHouse API read identity and the ingest identity are both '${serviceIdentity}', ` +
      `so per-organization read isolation would be a no-op and NOTHING was applied. The ingest ` +
      `identity carries a permissive 'ingest_all … USING 1' policy on every object so the worker ` +
      `can write for every tenant, and ClickHouse row policies combine with OR — so that one ` +
      `policy makes a per-query role= scope read every organization's rows regardless of which ` +
      `role it activates. Configure CLICKHOUSE_READ_USER / CLICKHOUSE_READ_URL as a SEPARATE ` +
      `login from CLICKHOUSE_USER / CLICKHOUSE_URL, holding no policy of its own.`,
  );
}

/**
 * Refuses to provision an API read identity that carries a blanket permissive row
 * policy, naming every offending policy.
 *
 * 🔴 The single most important guard here. A permissive policy applied to the read
 * user by name ORs past every `iso_` predicate its active role contributes, so
 * `role=org_a` returns org A's rows *and* everyone else's. Reproduced exactly that
 * way: an `ingest_all … USING 1` policy on an otherwise correctly scoped reader
 * read both organizations. Nothing about the failure is visible from the query —
 * the role is accepted, the query succeeds, and the result set silently spans
 * tenants — which is why this is a refusal and not a log line.
 *
 * Runs before any DDL is written, so a deployment in that state is left exactly as
 * it was and the operator drops the named policy rather than reasoning about what
 * half-applied.
 *
 * See readIdentityPermissivePolicyQuery for which policies count and, just as
 * importantly, which deliberate `TO ALL` ones do not.
 */
async function assertReadIdentityHasNoPermissivePolicy(
  exec: ChStatementExecutor,
  user: string,
): Promise<void> {
  const rows = await exec(readIdentityPermissivePolicyQuery(user));
  if (rows.length === 0) return;
  const offenders = rows
    .map((row) => `${String(row.short_name)} ON ${String(row.database)}.${String(row.table)} ` +
      `USING ${String(row.filter)}`)
    .join('; ');
  throw new Error(
    `The ClickHouse API read identity '${user}' carries permissive row policies that are not ` +
      `tenant predicates, so per-organization read isolation would be a no-op and NOTHING was ` +
      `applied: ${offenders}. ClickHouse row policies combine with OR, so any such policy ORs ` +
      `past every per-organization 'iso_' predicate and a query scoped with role= reads EVERY ` +
      `organization's rows while still appearing to succeed. Drop the named policies (or point ` +
      `CLICKHOUSE_READ_USER at a login that holds none) and re-run. This is most often the ` +
      `'ingest_all' policy left behind by a login that used to be the ingest identity.`,
  );
}

/**
 * Read identity configured but absent from the server: refuse, for the same
 * reason a missing ingest identity refuses.
 *
 * Every organization's `SELECT` grant lives on its role, so once the read path
 * activates roles a non-existent login cannot be granted anything and every
 * dashboard reads nothing. That fails closed, which is right, and is invisible,
 * which is not.
 */
async function assertReadIdentityExists(
  exec: ChStatementExecutor,
  user: string,
): Promise<void> {
  if (await chUserExists(exec, user)) return;
  throw new Error(
    `ClickHouse API read identity '${user}' is configured (CLICKHOUSE_READ_USER / ` +
      `CLICKHOUSE_READ_URL) but does not exist on the server, so NOTHING was applied. Create the ` +
      `user with no row policy of its own and no direct SELECT grant on the database — its ` +
      `privileges come from the per-organization roles this pass grants it — or unset the ` +
      `variables to leave the read path on the shared ingest identity.`,
  );
}

/**
 * Applies the catch-all deny to every object the server reports, the permissive
 * policy for the declared shared objects, and the cross-organization read policy
 * for the configured service identity.
 *
 * **Must run as part of every schema migration, not only at onboarding.** A
 * table created after provisioning is covered by nothing, and ClickHouse row
 * policies are permissive by default, so it is world-readable — a reviewer read
 * two organizations' rows out of exactly such a table as an identity holding no
 * organization role. Re-running this pass is what closes that window, and it is
 * safe to re-run because every statement it emits is IF NOT EXISTS or an
 * idempotent drop-then-create.
 *
 * **The service-identity grant is part of the same pass on purpose.** `TO ALL`
 * includes the identity that created the policy, so a baseline that applied only
 * the deny would deny the API and the worker too — ~28 API modules' dashboards
 * would render zero and the worker's ADO revisions sweep would recompute dwell
 * values from an empty result set, with no error on either side. The deny is only
 * safe to apply *together* with the grant that re-admits the one identity the
 * product actually reads through. See ChCoverageReport.serviceIdentity for what
 * that identity can see and why that is still the right trade today.
 */
export async function applyRowPolicyBaseline(
  exec: ChStatementExecutor,
  options: ChBaselineOptions = {},
): Promise<ChCoverageReport> {
  const objects = await fetchPolicyObjects(queryClientFor(exec));
  const serviceIdentity = options.serviceUser ?? resolveServiceIdentityUser();
  const apiReadIdentity =
    'apiReadUser' in options ? options.apiReadUser : resolveApiReadIdentityUser();

  // Every DDL set is generated BEFORE anything is applied, and every identity
  // check runs before that too, because every one of those can throw:
  // sharedObjectAllowDdl if CH_SHARED_OBJECTS names a tenant-carrying object,
  // ingestIdentityDdl / readIdentityDefaultRoleDdl if a configured user name is
  // unsafe or is a grantee keyword, assertIdentitiesAreDistinct if the two
  // identities collapse into one, assertServiceIdentityExists /
  // assertReadIdentityExists if a user is not there, and
  // assertReadIdentityHasNoPermissivePolicy if the reader already holds a policy
  // that would OR past every tenant predicate. All of them must abort the pass
  // rather than land the deny and then fail.
  const sharedDdl = sharedObjectAllowDdl(objects);
  const serviceDdl = ingestIdentityDdl(serviceIdentity, objects.all);
  const readDdl =
    apiReadIdentity === undefined ? [] : readIdentityDefaultRoleDdl(apiReadIdentity);
  assertIdentitiesAreDistinct(serviceIdentity, apiReadIdentity);
  await assertServiceIdentityExists(exec, serviceIdentity);
  if (apiReadIdentity !== undefined) {
    await assertReadIdentityExists(exec, apiReadIdentity);
    await assertReadIdentityHasNoPermissivePolicy(exec, apiReadIdentity);
  }

  await runAll(exec, catchAllDenyDdl(objects.all));
  await runAll(exec, sharedDdl);
  await runAll(exec, serviceDdl);
  await runAll(exec, readDdl);
  const shared = objects.all.filter((object) => CH_SHARED_OBJECTS.includes(object));

  const isoRows = await exec(CH_ISO_POLICY_OBJECTS_QUERY);
  const isoCovered = new Set(isoRows.map((row) => String(row.table)));

  const tenant = new Set(objects.tenant);
  const sharedSet = new Set(shared);
  return {
    denied: objects.all,
    tenant: objects.tenant,
    shared,
    unreadable: objects.all.filter((object) => !tenant.has(object) && !sharedSet.has(object)),
    needsReprovision: objects.tenant.filter((object) => !isoCovered.has(object)),
    serviceIdentity,
    apiReadIdentity,
  };
}

/**
 * Gives one organization its ClickHouse identity: the baseline coverage, then
 * its role, SELECT grant and per-object predicate policies.
 *
 * Ordering is load-bearing. A row policy's `TO <grantee>` is resolved at DDL
 * time and an unknown name is looked up as a role, so applying a policy before
 * its grantee exists fails with `Code 511 UNKNOWN_ROLE`. organizationPolicyDdl
 * therefore emits `CREATE ROLE IF NOT EXISTS` before any policy that targets
 * it, and this function preserves that order. Granting the role to a USER is a
 * separate, later step — the user must exist before it is granted, and the role
 * must exist before the grant, so the full sequence is:
 * role → policies → (create user) → GRANT role TO user.
 *
 * The API read identity's grant is the last of those steps and is part of this
 * pass rather than a separate rollout action: an organization whose role nobody
 * holds is an organization nobody can read, and under D3 the read identity is
 * granted every organization's role precisely so that onboarding needs no new
 * credential. See organizationRoleGrantStatements.
 */
export async function provisionOrganizationAnalytics(
  exec: ChStatementExecutor,
  organizationId: string,
  options: ChBaselineOptions = {},
): Promise<ChProvisionResult> {
  const coverage = await applyRowPolicyBaseline(exec, options);
  const statements = [
    ...organizationPolicyDdl(organizationId, coverage.tenant),
    ...organizationRoleGrantStatements(organizationId, coverage.apiReadIdentity),
  ];
  await runAll(exec, statements);
  return { role: roleNameFor(organizationId), coverage, statements: statements.length };
}

/**
 * The grant that lets the API read identity activate this organization's role,
 * or nothing at all when no read identity is configured.
 *
 * Emitted after organizationPolicyDdl because the role has to exist before it can
 * be granted. Returning an empty list rather than throwing when unconfigured is
 * what keeps a deployment that has not split its read path yet migrating and
 * onboarding normally — the absence is reported through
 * ChCoverageReport.apiReadIdentity instead.
 */
function organizationRoleGrantStatements(
  organizationId: string,
  apiReadIdentity: string | undefined,
): string[] {
  if (apiReadIdentity === undefined) return [];
  return readIdentityRoleGrantDdl(organizationId, apiReadIdentity);
}

/**
 * Re-provisioning entry point for organizations that already exist.
 *
 * Staging's `Deckgauge` organization predates this code and will never pass
 * through the create/bootstrap path, so it would otherwise have no role and no
 * policies — and with the catch-all in place that means its users read nothing.
 * The baseline is fetched once and the per-organization DDL replayed per id, so
 * this is also the repair path for a stale predicate.
 */
export async function reprovisionOrganizations(
  exec: ChStatementExecutor,
  organizationIds: readonly string[],
  options: ChBaselineOptions = {},
): Promise<ChProvisionResult[]> {
  const coverage = await applyRowPolicyBaseline(exec, options);
  const results: ChProvisionResult[] = [];
  for (const organizationId of organizationIds) {
    const statements = [
      ...organizationPolicyDdl(organizationId, coverage.tenant),
      ...organizationRoleGrantStatements(organizationId, coverage.apiReadIdentity),
    ];
    await runAll(exec, statements);
    results.push({ role: roleNameFor(organizationId), coverage, statements: statements.length });
  }
  return results;
}
