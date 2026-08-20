import { CH_TENANT_TABLES } from './ch-tenancy-tables.js';

/** The database every policy is scoped to. */
export const CH_POLICY_DATABASE = 'cockpit';

/**
 * Every object in the database, which is the catch-all deny's coverage set.
 *
 * Driven from the server rather than from a constant on purpose. An earlier
 * version generated the catch-all from CH_TENANT_TABLES, which lists physical
 * tables only — so cockpit.mv_jira_flow_efficiency got no policy and leaked
 * every organization's rows to any identity. A `TO`-target materialized view
 * resolves row policies against the name in the query, so denying its
 * destination table is not enough; the view needs its own policy. Asking the
 * server means an object added later is covered without anyone remembering to
 * update a list.
 */
export const CH_ALL_OBJECTS_QUERY =
  `SELECT name FROM system.tables WHERE database = '${CH_POLICY_DATABASE}' ORDER BY name`;

/**
 * The objects that carry an organization_id, which is the per-organization
 * predicate policies' coverage set — a predicate policy needs the column to
 * filter on. This is CH_TENANT_TABLES plus the materialized view, whose
 * SELECT passes organization_id through, so the view is readable by an
 * organization's own role instead of being denied outright by the catch-all.
 */
export const CH_TENANT_OBJECTS_QUERY =
  `SELECT DISTINCT table FROM system.columns ` +
  `WHERE database = '${CH_POLICY_DATABASE}' AND name = 'organization_id' ORDER BY table`;

/**
 * The objects that already carry at least one per-organization `iso_` policy.
 *
 * A tenant-carrying object with none is denied to every organization: the
 * catch-all covers it and nothing re-admits it. That fails closed, which is
 * right, but it is invisible — the object has an organization_id, so it is not
 * in the "no tenant column" bucket either. Reading this back is what turns a
 * new tenant table into a reported `needsReprovision` entry instead of analytics
 * that just went empty.
 *
 * `startsWith` rather than LIKE 'iso\\_%': in LIKE, `_` matches any character.
 */
export const CH_ISO_POLICY_OBJECTS_QUERY =
  `SELECT DISTINCT table FROM system.row_policies ` +
  `WHERE database = '${CH_POLICY_DATABASE}' AND startsWith(short_name, 'iso_') ORDER BY table`;

/** The minimum a ClickHouse client must do for fetchPolicyObjects. */
export interface ChPolicyQueryClient {
  query(params: {
    query: string;
    format: 'JSONEachRow';
  }): Promise<{ json(): Promise<unknown> }>;
}

export interface ChPolicyObjects {
  /** Every object in the database — what the catch-all deny and the ingest identity cover. */
  readonly all: readonly string[];
  /** Objects carrying organization_id — what the per-organization predicate policies cover. */
  readonly tenant: readonly string[];
}

/** The values allowed to reach DDL as a caller-supplied identifier. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Grantee keywords, which a character-class allowlist structurally cannot
 * catch: they need no quote and no statement terminator, so `TO ALL` is valid
 * DDL that grants a policy to everyone and defeats the catch-all. Rejected
 * case-insensitively wherever a grantee is interpolated. (Quoting the grantee
 * also neutralises them — ClickHouse resolves TO `ALL` as a role name and
 * fails with UNKNOWN_ROLE — but the check must not depend on a future edit
 * keeping the quotes.)
 */
const GRANTEE_KEYWORDS = new Set(['all', 'none', 'current_user']);

/**
 * ClickHouse DDL cannot bind identifiers, so ids and names are interpolated.
 * They are validated rather than escaped: anything that could close a quote or
 * end a statement is rejected outright, so no escaping rule has to be trusted.
 */
function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(
      `${label} must match ${String(SAFE_ID)} to appear in ClickHouse DDL; got ${JSON.stringify(value)}`,
    );
  }
}

function assertNotGranteeKeyword(value: string, label: string): void {
  if (GRANTEE_KEYWORDS.has(value.toLowerCase())) {
    throw new Error(
      `${label} must not be a ClickHouse grantee keyword (ALL, NONE, CURRENT_USER); ` +
        `got ${JSON.stringify(value)} — as a grantee that would apply the policy to every user`,
    );
  }
}

/**
 * Backtick-quote an identifier so separators inside it cannot change how it
 * parses. Server-sourced object names go through here rather than through
 * SAFE_ID because legitimate ones can contain dots — a non-`TO` materialized
 * view produces an `.inner_id.<uuid>` table. Only the two characters that
 * could escape the quoting are rejected.
 */
function quoteIdent(name: string, label: string): string {
  if (name.length === 0 || /[`\\]/.test(name)) {
    throw new Error(
      `${label} cannot be safely quoted for ClickHouse DDL; got ${JSON.stringify(name)}`,
    );
  }
  return `\`${name}\``;
}

function qualified(object: string): string {
  return `${CH_POLICY_DATABASE}.${quoteIdent(object, 'object name')}`;
}

/**
 * Reads both coverage sets off the server.
 *
 * Also asserts the tenant set still contains every CH_TENANT_TABLES entry, so
 * a mis-scoped query cannot silently under-cover: the constant is the floor,
 * the server is the source.
 */
export async function fetchPolicyObjects(client: ChPolicyQueryClient): Promise<ChPolicyObjects> {
  const read = async (query: string, field: 'name' | 'table'): Promise<string[]> => {
    const result = await client.query({ query, format: 'JSONEachRow' });
    const rows = (await result.json()) as Array<Record<string, string>>;
    return rows.map((row) => row[field] as string);
  };

  const all = await read(CH_ALL_OBJECTS_QUERY, 'name');
  const tenant = await read(CH_TENANT_OBJECTS_QUERY, 'table');

  const missing = CH_TENANT_TABLES.filter((t) => !tenant.includes(t.table)).map((t) => t.table);
  if (missing.length > 0) {
    throw new Error(
      `ClickHouse is missing organization_id on known tenant tables, so policies would ` +
        `under-cover: ${missing.join(', ')}. Run the organization-tenancy migration first.`,
    );
  }
  return { all, tenant };
}

/**
 * The ClickHouse role that carries an organization's row policies.
 *
 * Injective: the id is embedded verbatim, so 'org-a' and 'org_a' cannot
 * collide. An earlier version replaced hyphens with underscores, which mapped
 * both to org_org_a — and because the generators used IF NOT EXISTS, the second
 * organization's policy was silently discarded and its users inherited the
 * first organization's filter. The name is therefore backtick-quoted wherever
 * it appears in DDL, since a bare hyphen would otherwise parse as minus.
 *
 * Task 10 derives connection user names from this same function so the two
 * cannot drift.
 */
export function roleNameFor(organizationId: string): string {
  assertSafeId(organizationId, 'organizationId');
  assertNotGranteeKeyword(organizationId, 'organizationId');
  return `org_${organizationId}`;
}

/**
 * Objects that deliberately have NO organization_id and are still readable by
 * everyone. Deny-by-default is the rule; this is the declared exception list,
 * and it is deliberately tiny.
 *
 * `_ch_migrations` is here because the catch-all covers every object in the
 * database including the migration ledger, and row policies apply to every
 * user — there is no admin bypass in 24.3. Denied, the migrator's
 * `SELECT filename FROM cockpit._ch_migrations` returns zero rows, so every
 * migration re-applies on every run and the ledger accumulates duplicates.
 * The ledger holds filenames only, so making it world-readable leaks nothing.
 *
 * Anything NOT on this list and without an organization_id stays denied — see
 * sharedObjectAllowDdl for why that direction was chosen.
 */
export const CH_SHARED_OBJECTS: readonly string[] = ['_ch_migrations'];

/**
 * One deny-everything policy per object, applied TO ALL.
 *
 * Required because ClickHouse row policies are PERMISSIVE: an identity covered
 * by no policy on an object sees every row, not none, and 24.3 exposes no
 * server or session setting to invert that (verified: neither system.settings
 * nor system.server_settings has a row_policy entry). This catch-all is what
 * turns "policies exist" into "isolation exists".
 *
 * Permissive policies combine with OR, so it coexists with the per-organization
 * policies and needs no EXCEPT list — which is why onboarding an organization
 * never edits it. It also denies the admin/service identity, so any identity
 * needing cross-organization reads needs ingestIdentityDdl() — which is why
 * applyRowPolicyBaseline applies this deny and the service identity's grant in
 * the same pass, and never one without the other.
 *
 * **IF NOT EXISTS, never drop-then-create.** This is the one policy family that
 * must not converge by replacement, because the replacement is not atomic and
 * the gap between the DROP and the CREATE is fully open: an uncovered identity
 * read all three organizations' rows through it, and a crash in that window
 * leaves the object permanently unprotected. There is nothing to converge
 * anyway — `USING 0 TO ALL` is the identical DDL for every object forever, so a
 * pre-existing deny_uncovered is already correct by construction. Only the
 * per-organization `iso_` policies carry a predicate that can go stale, and
 * dropping one of those fails CLOSED, which is why replaceRowPolicy is right
 * there and wrong here. Do not unify the two paths.
 *
 * Pass the server's object list from fetchPolicyObjects().all — see
 * CH_ALL_OBJECTS_QUERY for why this is not generated from a constant.
 */
export function catchAllDenyDdl(objects: readonly string[]): string[] {
  return objects.map((object) => createRowPolicyIfNotExists('deny_uncovered', object, '0', 'ALL'));
}

/**
 * An explicit permissive `USING 1 TO ALL` for the declared shared objects.
 *
 * The decision this encodes: an object with no organization_id is denied to
 * every identity except the ingest user, because the catch-all covers it and no
 * per-organization policy can re-admit it (a predicate policy needs a column to
 * filter on). Left implicit that is a trap — a future lookup or rollup table
 * would silently return zero rows and blank analytics. So the set is split
 * explicitly:
 *
 *   - on CH_SHARED_OBJECTS → this permissive policy, world-readable on purpose;
 *   - anything else         → stays denied, and the provisioning pass REPORTS it
 *                             (see ChCoverageReport.unreadable) so it is loud
 *                             rather than silent.
 *
 * Denied is the default rather than allowed because the two failure modes are
 * not symmetric: a blanked lookup table is a visible, recoverable bug, while a
 * permissive default on an untenanted rollup is a cross-organization read — the
 * exact class of leak the materialized view already demonstrated. Adding a
 * genuinely global object to CH_SHARED_OBJECTS is a one-line, reviewable act.
 *
 * Also IF NOT EXISTS: like the catch-all, `USING 1 TO ALL` is constant DDL, so
 * there is never a stale predicate to replace. (If a crash lands between the
 * catch-all and this policy the object is merely denied, and the next pass puts
 * it back — it self-heals in the safe direction.)
 *
 * Takes the whole ChPolicyObjects pair rather than just the object list so the
 * guard below cannot be skipped by a caller that only has one of them.
 */
export function sharedObjectAllowDdl(objects: ChPolicyObjects): string[] {
  assertSharedObjectsCarryNoTenantColumn(objects.tenant);
  return objects.all
    .filter((object) => CH_SHARED_OBJECTS.includes(object))
    .map((object) => createRowPolicyIfNotExists('shared_all', object, '1', 'ALL'));
}

/**
 * Refuses to emit a permissive allow-all for an object that carries an
 * organization_id.
 *
 * `shared_all` is `USING 1 TO ALL`, and permissive policies combine with OR — so
 * on a tenant-carrying object it ORs straight past both `deny_uncovered` and
 * every `iso_` predicate and makes EVERY organization's rows readable by EVERY
 * user. Worse, it is IF NOT EXISTS, so reverting CH_SHARED_OBJECTS afterwards
 * does not remove it; someone has to know to drop the policy by hand.
 *
 * The list is small and hand-maintained, which is exactly the kind of edit that
 * gets made under time pressure while chasing an empty-analytics report — so the
 * mistake is refused here rather than documented.
 */
function assertSharedObjectsCarryNoTenantColumn(tenantObjects: readonly string[]): void {
  const offenders = CH_SHARED_OBJECTS.filter((object) => tenantObjects.includes(object));
  if (offenders.length > 0) {
    throw new Error(
      `CH_SHARED_OBJECTS must never list an object that carries organization_id, and ` +
        `${offenders.join(', ')} does. A permissive 'USING 1 TO ALL' policy on a ` +
        `tenant-carrying object ORs past the catch-all deny and every per-organization ` +
        `predicate, making every organization's rows readable by every user. Remove it ` +
        `from CH_SHARED_OBJECTS; a tenant table is protected by its iso_ policies instead.`,
    );
  }
}

/**
 * The role, its SELECT grant, and one permissive policy per organization-scoped
 * object, re-admitting exactly this organization's rows through the catch-all
 * deny. Because the filter lives on the server, a query that forgets its tenant
 * predicate returns fewer rows, never another organization's.
 *
 * Pass fetchPolicyObjects().tenant — objects without an organization_id column
 * cannot carry a predicate policy.
 *
 * The role is created here, so grant it to users afterwards. See
 * ingestIdentityDdl for the ordering rule that applies to grantees generally.
 */
export function organizationPolicyDdl(
  organizationId: string,
  objects: readonly string[],
): string[] {
  const role = roleNameFor(organizationId);
  const quotedRole = quoteIdent(role, 'role name');
  return [
    // Not CREATE OR REPLACE: replacing a role drops the grants of it that
    // existing users hold. Roles carry no state that needs converging — the
    // policies attached to them do, and those are replaced below.
    `CREATE ROLE IF NOT EXISTS ${quotedRole}`,
    `GRANT SELECT ON ${CH_POLICY_DATABASE}.* TO ${quotedRole}`,
    ...objects.flatMap((object) =>
      replaceRowPolicy(
        `iso_${role}`,
        object,
        `organization_id = '${organizationId}'`,
        quotedRole,
      ),
    ),
  ];
}

/**
 * The cross-organization permissive policy for a single named user: `USING 1` on
 * every object passed in.
 *
 * Two callers, one shape. The worker ingests for every organization from one
 * queue, so it needs this — without it the catch-all denies its writes' identity
 * too; write correctness therefore rests on the bound client in chInsertMany, not
 * on this policy (design doc D1). And `applyRowPolicyBaseline` calls it for the
 * configured *service* identity (`resolveServiceIdentityUser()`), which today is
 * the same single user both apps read through — because `TO ALL` in the catch-all
 * includes that user, so the deny and this grant have to land together or every
 * read in the product returns zero rows.
 *
 * Pass fetchPolicyObjects().all so the identity is not blocked on an object the
 * catch-all covers.
 *
 * **The user must already exist.** A policy's `TO <grantee>` is resolved at DDL
 * time, and a name that is not a known user is looked up as a role, so applying
 * this before creating the user fails with `Code 511 UNKNOWN_ROLE`. Provision
 * the identity first, then its policies.
 */
export function ingestIdentityDdl(user: string, objects: readonly string[]): string[] {
  assertSafeId(user, 'user');
  assertNotGranteeKeyword(user, 'user');
  const quotedUser = quoteIdent(user, 'user');
  return objects.flatMap((object) => replaceRowPolicy('ingest_all', object, '1', quotedUser));
}

/**
 * The DDL that makes a single login safe to scope with a per-query `role`
 * (design doc D3): it holds no role by default, so a query that supplies none
 * activates none.
 *
 * That is what makes the read path fail CLOSED. The organization's `SELECT` grant
 * lives on its role, not on the user, so with no role active the API read
 * identity has no privilege on `cockpit.*` at all and ClickHouse answers `Code
 * 497 ACCESS_DENIED` — verified on 24.8.14.39. Were the roles default instead,
 * an un-scoped query would silently activate every one of them and their
 * permissive `iso_` predicates would OR together into a cross-organization read:
 * the same failure shape as `ingest_all`, arrived at by omission rather than by
 * configuration.
 *
 * Idempotent, and deliberately re-emitted alongside every role grant — see
 * readIdentityRoleGrantDdl.
 */
export function readIdentityDefaultRoleDdl(user: string): string[] {
  assertSafeId(user, 'user');
  assertNotGranteeKeyword(user, 'user');
  return [`ALTER USER ${quoteIdent(user, 'user')} DEFAULT ROLE NONE`];
}

/**
 * Grants one organization's role to the API read identity, and re-asserts
 * `DEFAULT ROLE NONE` immediately afterwards.
 *
 * The pair is generated together rather than left to the caller because the
 * order is load-bearing and the second half is easy to forget: whether a fresh
 * `GRANT` also joins the user's default roles depends on the user's current
 * default-role setting, so re-asserting NONE after each grant makes the outcome
 * independent of that. Every grant therefore ends with the user holding the role
 * but activating nothing until a query names it.
 *
 * The role must already exist (organizationPolicyDdl creates it) and so must the
 * user — a `GRANT` to an unknown user fails rather than creating one.
 */
export function readIdentityRoleGrantDdl(organizationId: string, user: string): string[] {
  const role = roleNameFor(organizationId);
  assertSafeId(user, 'user');
  assertNotGranteeKeyword(user, 'user');
  return [
    `GRANT ${quoteIdent(role, 'role name')} TO ${quoteIdent(user, 'user')}`,
    ...readIdentityDefaultRoleDdl(user),
  ];
}

/**
 * Finds the permissive row policies that would defeat role scoping for one user.
 *
 * 🔴 This is the trap the whole mechanism turns on. ClickHouse row policies are
 * PERMISSIVE and combine with **OR**, so a single blanket policy naming the read
 * identity ORs straight past every `iso_` predicate its active role contributes.
 * Verified: a user querying with `role=org_a` while also holding an
 * `ingest_all … USING 1` policy read BOTH organizations' rows. The role was
 * applied and the isolation was still gone.
 *
 * Matches on `apply_to_list` — policies targeted at this user *by name* — and not
 * on `apply_to_all`, because the two `TO ALL` families are deliberate and safe:
 * `deny_uncovered` is `USING 0`, and `shared_all` is `USING 1` on objects that by
 * construction carry no tenant column (assertSharedObjectsCarryNoTenantColumn
 * refuses otherwise).
 *
 * A filter mentioning `organization_id` is left alone: that is the shape of a
 * tenant predicate, so it narrows rather than widens. Everything else applied to
 * this user by name — `1`, `1 = 1`, `true`, or any other blanket expression — is
 * reported. `coalesce` because `select_filter` is nullable, and a policy with no
 * SELECT filter constrains nothing.
 */
export function readIdentityPermissivePolicyQuery(user: string): string {
  assertSafeId(user, 'user');
  assertNotGranteeKeyword(user, 'user');
  return (
    `SELECT database, table, short_name, coalesce(select_filter, '') AS filter ` +
    `FROM system.row_policies ` +
    `WHERE is_restrictive = 0 AND has(apply_to_list, '${user}') ` +
    `AND position(coalesce(select_filter, '1'), 'organization_id') = 0 ` +
    `ORDER BY database, table, short_name`
  );
}

/**
 * Drop-then-create, because 24.3 has no CREATE OR REPLACE ROW POLICY (verified:
 * it is a syntax error). IF NOT EXISTS would leave a stale or wrong predicate
 * in place, so re-running provisioning could never repair a bad policy — and it
 * is what let the role-name collision above fail silently. These are generated
 * as an adjacent pair so every caller converges.
 */
function replaceRowPolicy(
  shortName: string,
  object: string,
  filter: string,
  grantee: string,
): string[] {
  const target = `${qualified(object)}`;
  const name = quoteIdent(shortName, 'policy name');
  return [
    `DROP ROW POLICY IF EXISTS ${name} ON ${target}`,
    `CREATE ROW POLICY ${name} ON ${target} USING ${filter} TO ${grantee}`,
  ];
}

/**
 * The non-destructive counterpart, for the policies whose DDL is a constant
 * (`USING 0 TO ALL`, `USING 1 TO ALL`). One statement, no window in which the
 * object is unprotected. See catchAllDenyDdl for why that matters here and not
 * for the predicate-carrying policies.
 */
function createRowPolicyIfNotExists(
  shortName: string,
  object: string,
  filter: string,
  grantee: string,
): string {
  const name = quoteIdent(shortName, 'policy name');
  return `CREATE ROW POLICY IF NOT EXISTS ${name} ON ${qualified(object)} USING ${filter} TO ${grantee}`;
}
