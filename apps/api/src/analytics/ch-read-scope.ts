import type { ClickHouseClient, QueryParams } from '@clickhouse/client';
// Deep import on purpose. The `@deckgauge/db` barrel re-exports
// packages/db/src/clickhouse.ts, which builds a ClickHouseClient *eagerly at
// module import* against a hard-coded `localhost:8123` fallback — the staging
// server. This module must never pull that singleton into scope: it is the
// ingest identity, which carries a permissive `ingest_all … USING 1` policy on
// every object and therefore reads every tenant no matter what role a query
// asks for. ch-row-policies has no such side effect.
import { roleNameFor } from '@deckgauge/db/dist/ch-row-policies.js';

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
  /** The ClickHouse role that scoping is expressed as. */
  readonly role: string;
  /** Runs a query with this organization's role activated, and no other. */
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
 * **Pass the organization resolved from the SESSION, never a value from the
 * request body, a query string or a header.** Everything above makes the role
 * unforgeable in SQL and says nothing about where the id came from; a
 * client-supplied organization id would simply be honoured.
 *
 * The client is injected rather than imported so this module never reaches for a
 * default URL or for the ingest singleton, and so tests need no server.
 */
export function chScopedReaderFor(
  client: ClickHouseClient,
  organizationId: string,
): ChScopedReader {
  // Validate before anything else, and refuse rather than widen. A blank or
  // missing organization id means the session did not resolve one, and the only
  // alternatives to throwing are running the query with no role — which on a
  // correctly provisioned read identity is `Code 497 ACCESS_DENIED`, an opaque
  // failure at a random call site — or falling back to a shared identity, which
  // reads every tenant. A misconfiguration has to look like an outage, not like
  // success, and it has to say so here rather than 30 frames away.
  if (typeof organizationId !== 'string' || organizationId.trim() === '') {
    throw new Error(
      'chScopedReaderFor requires a session-resolved organization id. Refusing to build an ' +
        'unscoped ClickHouse reader: a query with no role activates no per-organization row ' +
        'policy, and falling back to the shared ingest identity would read across every tenant.',
    );
  }
  const role = chReadRoleFor(organizationId);

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
    return client.query({ ...params, role });
  }) as ClickHouseClient['query'];

  return { organizationId, role, query };
}
