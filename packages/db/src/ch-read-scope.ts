import type { ClickHouseClient, QueryParams } from '@clickhouse/client';
// Relative import on purpose, NOT the `@deckgauge/db` barrel. `./clickhouse.ts`
// builds a ClickHouseClient *eagerly at module import* against a hard-coded
// `localhost:8123` fallback — the staging server — and the barrel re-exports it.
// This module must never pull that singleton into scope: it is the ingest
// identity, which carries a permissive `ingest_all … USING 1` policy on every
// object — so it reads every tenant when no role is activated, and REFUSES the
// query outright (`Code 512 SET_NON_GRANTED_ROLE`) if one is, because
// provisioning grants organization roles to the read identity and not to it.
// Neither outcome is what a reader wants. `./ch-row-policies.js` has no such
// side effect.
import { roleNameFor } from './ch-row-policies.js';

/**
 * The ClickHouse read boundary, shared by every app that reads analytics.
 *
 * **This lived in `apps/api/src/analytics/ch-read-scope.ts` and was moved here so
 * there is exactly one of it.** The worker needed the same boundary (its
 * `chClientFor(organizationId).queryRows` ignored its argument and ran through the
 * ingest singleton), and a second implementation of a tenant boundary is a hazard
 * in its own right: the two drift, and the drift is invisible until a tenant reads
 * another tenant's rows. `apps/api/src/analytics/ch-read-scope.ts` is now a
 * re-export of this module, so its ~20 importers are unchanged.
 *
 * Deep-import it as `@deckgauge/db/dist/ch-read-scope.js` for the reason in the
 * import comment above — the barrel constructs the ingest client.
 */

/**
 * The ClickHouse role that scopes reads to one organization.
 *
 * Derived from `roleNameFor` so the role a query activates and the role the row
 * policies are attached to cannot drift apart: rename one and the other follows.
 * It also inherits that function's validation — the id must match
 * /^[A-Za-z0-9_-]+$/ and must not be a grantee keyword (ALL / NONE /
 * CURRENT_USER) — which is the guarantee that matters here, because this value is
 * interpolated into the request's `role` search parameter and the same ids reach
 * policy DDL on the provisioning side.
 */
export function chReadRoleFor(organizationId: string): string {
  return roleNameFor(organizationId);
}

/**
 * Everything a READING service needs of a ClickHouse client: `query`, nothing
 * else.
 *
 * One shared name so the analytics services do not each invent their own narrow
 * alias. It is what lets a per-request `ChScopedReader` — which activates the
 * caller's organization role on every request — be passed to a service that
 * knows nothing about tenancy (§11 precondition 8), and it deliberately excludes
 * `insert`/`command` so a read path cannot quietly acquire a write.
 */
export type ChReadClient = Pick<ClickHouseClient, 'query'>;

/**
 * Query parameters a scoped reader accepts: everything `query()` takes except
 * `role`, which the reader owns.
 *
 * `role?: never` rather than `Omit<…>` alone so that passing one is a type error
 * at the call site and not merely ignored — the runtime check below is the
 * backstop for JavaScript callers and for `as any`.
 */
export type ChScopedQueryParams = Omit<QueryParams, 'role'> & { role?: never };

export interface ChScopedReader {
  /** The organization every query through this reader is scoped to. */
  readonly organizationId: string;
  /**
   * The ClickHouse role scoping is expressed as, or `null` when this reader
   * activates none — see `chUnroledReaderFor`. `null` means the row-policy layer
   * is NOT in force and the caller is relying on something else (the worker's SQL
   * predicate) or on nothing at all (the API on an unsplit deployment).
   */
  readonly role: string | null;
  /** Runs a query with this organization's role activated, if it has one. */
  query: ClickHouseClient['query'];
}

/**
 * Binds one ClickHouse client to one organization's read scope.
 *
 * This is the mechanism that activates the tenancy row policies on the read path
 * (design doc D3). ClickHouse applies an organization's `iso_` predicates to a
 * query when that query activates the organization's role, and `role` is a
 * **request-level parameter** — `@clickhouse/client` emits it as the `role` search
 * param, and ClickHouse ≥ 24.8 honours it per request. So one shared client is
 * enough: there is no per-organization credential to mint, store, rotate or leak,
 * and no per-organization connection pool. It replaced a per-organization client
 * cache, which existed only to carry per-organization passwords that no longer
 * exist.
 *
 * `role` being a request parameter is also what makes this safe in a product that
 * lets users author SQL. It is unreachable from the query text: `SELECT …
 * SETTINGS role='org_b'` fails with `Code 115 UNKNOWN_SETTING` because `role` is
 * not a SQL setting, and `SET ROLE …; SELECT …` fails with `Code 62` because
 * multi-statements are rejected over HTTP. Only the process building the request
 * can choose the role — which is this function, from a caller-supplied
 * organization id.
 *
 * **Pass the organization resolved from the SESSION (api) or from the entity the
 * job is syncing (worker) — never a value from a request body, a query string, a
 * header or a job payload field a client can set.** Everything above makes the
 * role unforgeable in SQL and says nothing about where the id came from; a
 * client-supplied organization id would simply be honoured.
 *
 * The client is injected rather than imported so this module never reaches for a
 * default URL or for the ingest singleton, and so tests need no server.
 */
export function chScopedReaderFor(
  client: ChReadClient,
  organizationId: string,
): ChScopedReader {
  return buildReader(client, organizationId, 'activate-role');
}

/**
 * A reader bound to one organization that activates **no ClickHouse role**.
 *
 * For an identity that holds no per-organization grant — in practice the INGEST
 * identity on a deployment that has not split its read path. It exists because
 * the obvious alternative does not work, and the comment that used to say
 * otherwise was measurably false.
 *
 * **`role=` on a non-granted user is a hard failure, not a no-op.** Verified
 * against ClickHouse 24.8:
 *
 * | request | result |
 * |---|---|
 * | ingest user, role it was never granted | `Code 512 SET_NON_GRANTED_ROLE` |
 * | ingest user, role that does not exist | `Code 511 UNKNOWN_ROLE` |
 * | ingest user, no role at all | succeeds |
 * | read identity, role it holds | succeeds |
 *
 * `ch-provisioning.ts` grants organization roles to the READ identity only
 * (`system.role_grants` on staging holds exactly one row, `reader → org_…`), so
 * there is no deployment state in which asking the ingest identity for a role
 * works: either the role is missing (511) or it is not granted (512). The earlier
 * belief — "the ingest identity's permissive `ingest_all … USING 1` policy makes
 * the role a no-op" — confused what a policy does with what SET ROLE does. The
 * policy governs which ROWS an activated role sees; it says nothing about whether
 * the role may be activated at all.
 *
 * **What this reader does and does not give you.** It keeps the organization
 * binding, the blank-id refusal and the caller-supplied-role refusal. It does NOT
 * give tenant isolation: with no role activated, the ingest identity's permissive
 * policy admits every tenant's rows. That is exactly `main`'s pre-split behaviour
 * and is correct only while the deployment has one organization — which is what
 * `isSplit: false` is for. A caller that needs a boundary on this path must supply
 * its own (the worker interpolates an `organization_id` predicate and refuses SQL
 * without one); a caller that cannot must treat `isSplit: false` as "no boundary".
 *
 * Why not fail closed instead: on the API that would make every analytics read on
 * every fresh install and the whole OSS edition throw 511/512, because
 * `CLICKHOUSE_READ_URL` is empty in both `.env.example` and `docker-compose.yml`.
 * On the worker it is worse than an error page — a sync whose reads throw still
 * COMPLETES and writes, zeroing `statsJson`, `heat`, `ranking` and `isActive`.
 */
export function chUnroledReaderFor(
  client: ChReadClient,
  organizationId: string,
): ChScopedReader {
  return buildReader(client, organizationId, 'no-role');
}

/**
 * The one implementation behind both factories, so the guards cannot drift apart.
 *
 * `mode` is a string union rather than a boolean because it is read at the call
 * site: `chUnroledReaderFor` vs `chScopedReaderFor` names the decision, and a
 * boolean flag on a single exported function is how "activate the role" quietly
 * becomes conditional on something else later.
 */
function buildReader(
  client: ChReadClient,
  organizationId: string,
  mode: 'activate-role' | 'no-role',
): ChScopedReader {
  // Validate before anything else, and refuse rather than widen. A blank or
  // missing organization id means the caller did not resolve one, and the
  // alternatives are worse: an unroled read on a permissive identity spans every
  // tenant, and an unroled read on a provisioned read identity matches the
  // catch-all `deny_uncovered … USING 0 TO ALL` and returns nothing at a random
  // call site. A misconfiguration has to look like an outage, not like success,
  // and it has to say so here rather than 30 frames away.
  if (typeof organizationId !== 'string' || organizationId.trim() === '') {
    throw new Error(
      'chScopedReaderFor requires a session-resolved organization id. Refusing to build an ' +
        'unscoped ClickHouse reader: a query with no role activates no per-organization row ' +
        'policy, and falling back to the shared ingest identity would read across every tenant.',
    );
  }
  const role = mode === 'activate-role' ? chReadRoleFor(organizationId) : null;

  const query = ((params: ChScopedQueryParams) => {
    // A caller-supplied role is refused, not overwritten. Silently replacing it
    // would let a call site read as though it chose the tenant while the reader
    // decided, and the next person to widen this function would make the
    // overwrite conditional. There is exactly one source of the role.
    if (params !== null && typeof params === 'object' && 'role' in params) {
      throw new Error(
        `A ClickHouse read scoped to organization ${organizationId} cannot also carry a caller ` +
          'supplied role. The role comes from the session-resolved organization; remove it from ' +
          'the query parameters.',
      );
    }
    // The `role` key is OMITTED rather than passed as null.
    //
    // Be precise about why, because the first version of this comment was itself a
    // wrong mechanism claim — in a module whose whole subject is a wrong mechanism
    // claim causing an outage. Measured against @clickhouse/client-common@1.19.0 and
    // ClickHouse 24.8.14.39:
    //
    //   - `toSearchParams` guards with `if (role)`, so `role: ''`, `null` and
    //     `undefined` are ALL dropped before the wire and all succeed. Passing
    //     `role: null` here would work today.
    //   - a raw `?role=` on the URL — an empty value that DID reach the wire — is
    //     `Code 511 UNKNOWN_ROLE` ("There is no role `` in user directories").
    //
    // So omitting the key is not load-bearing against today's client; it is cheap
    // insurance against a client version that stops filtering falsy values, and
    // against anyone hand-building the URL. Relying on the `if (role)` guard would
    // make this correctness depend on a dependency's internal detail.
    return role === null ? client.query({ ...params }) : client.query({ ...params, role });
  }) as ClickHouseClient['query'];

  return { organizationId, role, query };
}
