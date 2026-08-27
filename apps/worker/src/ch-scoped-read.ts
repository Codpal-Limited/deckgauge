/**
 * The worker's ClickHouse READ boundary.
 *
 * The worker's writes have been tenant-bound since `chClientFor(organizationId)`
 * landed. Its reads were not: `queryRows` ignored the organization it was
 * constructed with and ran through the ingest singleton, whose
 * `ingest_all … USING 1` policy ORs past — and therefore removes — every
 * per-organization row policy. Two live consequences, both recorded in
 * `planning/STATE.md`: `org-sync-aggregator.ts` credited one tenant's commits,
 * PRs and reviews to another tenant's employees, and `ado-transition-priors.ts`
 * read a foreign `from_state` and **wrote it back** under the correct tenant,
 * which persists rather than merely leaking.
 *
 * ## Two layers, and which one is load-bearing
 *
 * 1. **The `organization_id` predicate in the SQL** — primary, and the reason
 *    this module exists. It is correct on every deployment, configured or not.
 * 2. **The ClickHouse role** (`packages/db/src/ch-read-scope.ts`, shared with the
 *    API) — defence in depth, and only present when the deployment has split its
 *    read identity (`CLICKHOUSE_READ_URL`).
 *
 *    On the ingest identity the role is not requested AT ALL, and the reason is
 *    not the one an earlier version of this comment gave. It said the permissive
 *    `ingest_all … USING 1` policy "makes any `role=` a no-op". It does not:
 *    `ch-provisioning.ts` grants organization roles to the READ identity only, and
 *    ClickHouse 24.8 answers a non-granted role with `Code 512
 *    SET_NON_GRANTED_ROLE` and a missing one with `Code 511 UNKNOWN_ROLE` —
 *    verified against staging. Two separate facts had been conflated: a permissive
 *    policy defeats an ACTIVATED role's predicate, which is why the identities must
 *    differ; it says nothing about whether the role may be activated. So the
 *    unsplit path uses `chUnroledReaderFor` and layer 1 carries the boundary
 *    alone.
 *
 * **The API's layering is the other way round and that is not an inconsistency —
 * it is the difference between a request and a sync.** The API's ~35 query
 * builders deliberately mention no `organization_id`: they are tenancy-agnostic,
 * the role is the whole boundary, and a forgotten scope fails CLOSED (zero rows)
 * because the catch-all `deny_uncovered … USING 0 TO ALL` policy matches. Zero
 * rows in a widget is a visible, reported bug.
 *
 * A sync cannot take that trade. Zero rows here does not surface as an error, it
 * surfaces as a WRITE: `runOrgTreeSync` would mark every employee unmatched and
 * inactive, drop `heat` and `ranking` from `statsJson`, and `buildAdoTransitions`
 * would report every in-window change as a creation with `from_state: ''` and zero
 * dwell. Silently overwriting good data with zeroes is worse than not running, so
 * the sync's correctness must not depend on a deployment having opted into the
 * read split. Hence the predicate first, the role second.
 */
import {
  chScopedReaderFor,
  chUnroledReaderFor,
  type ChReadClient,
  type ChScopedReader,
} from '@deckgauge/db/dist/ch-read-scope.js';

/**
 * A ClickHouse read client bound to exactly one organization.
 *
 * `organizationId` is READABLE so a call site can build its own predicate, and
 * not WRITABLE so it cannot choose a different one — the same property
 * `insertRows` has. Every read site in the worker takes this shape rather than a
 * bare `ClickHouseClient`, which is what makes "a read with no tenant" something
 * the type system refuses to express.
 */
export interface ChScopedReadClient {
  /** The organization every query through this client is scoped to. */
  readonly organizationId: string;
  /**
   * Runs `sql` and returns its rows. The SQL MUST carry this organization's
   * `organization_id` predicate — see `assertOrgScopedSql`.
   */
  queryRows<T>(sql: string): Promise<T[]>;
}

/** A factory that binds a read client to one organization. */
export type ChScopedReadClientFactory = (organizationId: string) => ChScopedReadClient;

/**
 * Escape a value for a single-quoted ClickHouse string literal.
 *
 * ClickHouse cannot bind parameters in the HTTP `query` body form these call
 * sites use, so ids are interpolated. Organization ids are cuid/uuid-shaped and
 * `chReadRoleFor` rejects anything outside /^[A-Za-z0-9_-]+$/ before a role is
 * built from the same value, so this is belt-and-braces rather than the only
 * guard.
 */
function quoteLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * The tenant predicate, as SQL. One function so all ~19 worker read queries spell
 * it identically and a grep for `orgPredicate` finds every scoped read.
 */
export function orgPredicate(organizationId: string): string {
  // Refuses rather than rendering `organization_id = 'undefined'`, which matches no
  // row and so turns a wiring mistake into a silent zero — precisely the outcome
  // this module exists to prevent, since a sync then writes those zeroes. Found by
  // a real one: the ADO processor's test doubles had no `organizationId`, and the
  // resulting TypeError was swallowed by the sweep's best-effort catch, so the
  // symptom was "no transitions written" with nothing in the log to explain it.
  if (typeof organizationId !== 'string' || organizationId.trim() === '') {
    throw new Error(
      'orgPredicate requires a non-empty organization id. A read client with no tenant cannot ' +
        'produce a scoped predicate, and an empty one silently matches nothing — which a sync ' +
        'writes back as zeroes.',
    );
  }
  return `organization_id = '${quoteLiteral(organizationId)}'`;
}

/**
 * Refuses SQL that does not name this organization.
 *
 * The chokepoint, and the reason it is a runtime check rather than a convention:
 * this defect shipped once already because a factory took an `organizationId` and
 * then did not use it, and nothing anywhere noticed. A convention cannot fail; a
 * guard can. The next worker read that forgets its predicate throws at its own
 * call site instead of quietly aggregating every tenant.
 *
 * **Deliberately textual, and it says so.** It proves the predicate is PRESENT,
 * not that it is correctly placed — `WHERE a OR organization_id = 'x'` satisfies
 * it. That is why the role is activated as well, and why the per-query tests
 * assert the predicate's position in the emitted SQL rather than only its
 * presence. A cheap check that runs on every query beats an expensive one that
 * gets deleted.
 *
 * There is no escape hatch on purpose. A worker read that genuinely spans tenants
 * (the AI-detection backfill script is the only one, and it holds its own
 * connection) does not come through here.
 */
export function assertOrgScopedSql(sql: string, organizationId: string): void {
  if (sql.includes(orgPredicate(organizationId))) return;
  throw new Error(
    `Refusing an unscoped ClickHouse read for organization ${organizationId}: the SQL does not ` +
      `carry \`${orgPredicate(organizationId)}\`. Worker reads are scoped by an explicit ` +
      'predicate (orgPredicate) because a sync that reads zero rows WRITES zeroes over good ' +
      `data. SQL was: ${sql.slice(0, 300)}`,
  );
}

/**
 * Wraps a ClickHouse client as a read client bound to one organization: asserts
 * the predicate, activates the organization's role, returns rows.
 *
 * The role comes from the SHARED `chScopedReaderFor` in `packages/db` — the same
 * function the API's `request.chRead` is built from — so the role a worker query
 * activates and the role the `iso_` row policies are attached to cannot drift.
 * A worker-local copy of that logic was the obvious alternative and is the thing
 * a tenant boundary least survives.
 */
export function chScopedReadClientFor(
  client: ChReadClient,
  organizationId: string,
): ChScopedReadClient {
  return clientOver(chScopedReaderFor(client, organizationId));
}

/**
 * Both layers minus the role: asserts the predicate, activates nothing.
 *
 * For the INGEST identity, which holds no per-organization grant — so asking it
 * for a role is `Code 512 SET_NON_GRANTED_ROLE` on every query, not a harmless
 * no-op. See `chUnroledReaderFor` in `packages/db` for the verified matrix.
 *
 * **This is the path an unconfigured deployment takes, so it is the one that must
 * not throw.** A worker read that throws does not surface as an error page: all
 * four aggregator fetchers `console.error` and continue, `runOrgTreeSync`
 * completes, and it WRITES — `statsJson` replaced wholesale with `heat` and
 * `ranking` gone, and `reduceEmployeeSnapshot([])` marking every employee
 * `matched: false`, `isActive: false`, `lastContributionAt: null`. Meanwhile the
 * ADO sweep's catch swallows the same throw, writes no transitions, and never
 * advances its watermark — so ADO dwell, DORA and CapEx freeze silently and
 * permanently after the first watermarked run.
 *
 * The predicate is what makes this safe rather than merely working: the read is
 * still scoped to one tenant, by SQL instead of by row policy.
 */
export function chPredicateOnlyReadClientFor(
  client: ChReadClient,
  organizationId: string,
): ChScopedReadClient {
  return clientOver(chUnroledReaderFor(client, organizationId));
}

/** The one wrapper, so the predicate assertion cannot be skipped on either path. */
function clientOver(reader: ChScopedReader): ChScopedReadClient {
  return {
    organizationId: reader.organizationId,
    async queryRows<T>(sql: string): Promise<T[]> {
      assertOrgScopedSql(sql, reader.organizationId);
      const result = await reader.query({ query: sql, format: 'JSONEachRow' });
      return (await result.json()) as T[];
    },
  };
}
