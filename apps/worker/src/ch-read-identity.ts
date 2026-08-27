import { createClient } from '@clickhouse/client';
import { resolveApiReadIdentityUser } from '@deckgauge/db/dist/ch-provisioning.js';
import type { ChReadClient } from '@deckgauge/db/dist/ch-read-scope.js';
import {
  chPredicateOnlyReadClientFor,
  chScopedReadClientFor,
  type ChScopedReadClient,
} from './ch-scoped-read.js';

/**
 * WHICH ClickHouse login the worker reads through, resolved once per process.
 *
 * The same two environment variables the API uses — `CLICKHOUSE_READ_USER` /
 * `CLICKHOUSE_READ_URL`, resolved by the SAME `resolveApiReadIdentityUser` helper
 * in `packages/db` — and deliberately the same identity, not a third one. That
 * matters operationally: `provisionOrganizationAnalytics` and
 * `retrofitReadIdentityGrants` grant every organization's role to exactly one read
 * login, so reusing it means the worker needs no new credential, no new grant
 * pass, and no new thing for an operator to forget. A worker-specific read user
 * would be a fourth ClickHouse identity (ingest, api-read, console, worker-read)
 * that provisioning knows nothing about, and `role=org_x` on an ungranted user
 * fails with "role should be granted".
 *
 * Resolution is done at BOOT, not per job, for the reason the API states: whether
 * the read path is split is a deployment fact, and discovering it differently on
 * two jobs is worse than discovering it once.
 *
 * ## The failure mode, chosen deliberately
 *
 * When no read identity is configured, the worker reads through the INGEST client
 * **with no role activated** and warns. It does not refuse to read, and it does
 * not read zero rows.
 *
 * The "no role activated" half is load-bearing and was wrong in the first version
 * of this file, which routed the ingest client through `chScopedReaderFor` and
 * therefore sent `role=org_<id>` on every query. `ch-provisioning.ts` grants
 * organization roles to the READ identity only, and ClickHouse 24.8 refuses a
 * non-granted role outright — `Code 512 SET_NON_GRANTED_ROLE`, or `Code 511
 * UNKNOWN_ROLE` if the role does not exist. So the fallback could not execute at
 * all, and because a worker read that throws is swallowed by a `console.error`
 * (aggregator) or a best-effort `catch` (ADO sweep), the sync still COMPLETED and
 * wrote zeroes — the exact outcome the reasoning below exists to prevent, reached
 * from the other side. `main` worked here precisely because it sent no role.
 *
 * Fail-closed is right for a request path — the API does exactly that, and an
 * empty widget is a visible bug. It is wrong here, and the reason is asymmetric
 * consequence: a sync that reads nothing does not render an empty page, it
 * **writes**. `runOrgTreeSync` would mark every employee unmatched and inactive
 * and drop `heat`/`ranking` from `statsJson`; `buildAdoTransitions` would report
 * every in-window change as a creation with `from_state: ''` and zero dwell.
 * Zeroes over good data are worse than a stale-but-correct snapshot, and worse
 * than not running.
 *
 * That is only a safe choice because the ingest fallback is not unscoped: every
 * worker read carries an `organization_id` predicate enforced by
 * `assertOrgScopedSql`, which is correct whether or not a role narrows anything.
 * The role is the second layer. Were the predicate the thing that went missing,
 * this fallback would be the bug — which is why the guard throws rather than
 * warns.
 *
 * `isSplit` is surfaced rather than hidden so the boot log says which of the two
 * layers is actually in force.
 */
export interface WorkerChReadIdentity {
  /** A read client scoped to one organization. */
  readerFor(organizationId: string): ChScopedReadClient;
  /**
   * True when a separate read login is configured, so the per-organization role
   * can narrow. False means reads run through the ingest identity and the SQL
   * predicate is the only layer in force.
   */
  readonly isSplit: boolean;
  /** The read login in use, for diagnostics. `undefined` when not split. */
  readonly user: string | undefined;
}

export interface WorkerChReadIdentityDeps {
  /** The ingest client, used only as the not-split fallback. */
  readonly ingestClient: ChReadClient;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: { warn: (msg: string) => void; info: (msg: string) => void };
  /** Test seam: build a client from a URL without reaching the network. */
  readonly makeClient?: (url: string) => ChReadClient;
}

export function buildWorkerChReadIdentity(
  deps: WorkerChReadIdentityDeps,
): WorkerChReadIdentity {
  const env = deps.env ?? process.env;
  const user = resolveApiReadIdentityUser(env);
  const url = env.CLICKHOUSE_READ_URL?.trim();

  // Both halves are required, exactly as in the API: a user with no URL cannot be
  // connected to, and a URL with no resolvable user is not an identity
  // provisioning can name in a role grant. Either alone is a misconfiguration and
  // is reported rather than half-applied.
  if (!user || !url) {
    if (user || url) {
      deps.log?.warn(
        '[ch-read] worker read identity is half-configured: ' +
          `${user ? 'CLICKHOUSE_READ_USER is set' : 'CLICKHOUSE_READ_USER is unset'} but ` +
          `${url ? 'CLICKHOUSE_READ_URL is set' : 'CLICKHOUSE_READ_URL is unset'}. ` +
          'Reads fall back to the INGEST identity with no role activated; the ' +
          'organization_id predicate still scopes them, but the row-policy layer is ABSENT. ' +
          'Set both, or neither.',
      );
    } else {
      deps.log?.info(
        '[ch-read] no CLICKHOUSE_READ_URL: worker reads run through the ingest identity with ' +
          'NO ClickHouse role activated, so the row-policy layer is ABSENT and the ' +
          'organization_id predicate is the only thing scoping them. Set CLICKHOUSE_READ_URL ' +
          'to add the row-policy layer (see planning/TENANCY-PROGRAMME.md §11 precondition 8).',
      );
    }
    return {
      isSplit: false,
      user: undefined,
      // Predicate-only, and NOT through chScopedReadClientFor. The ingest identity
      // holds no per-organization grant, so requesting a role is Code 512 on every
      // query rather than a no-op — see the docblock above and chUnroledReaderFor.
      // The predicate is still asserted, so the read is still scoped to one tenant;
      // what is missing is the row-policy layer, which is what isSplit reports.
      readerFor: (organizationId: string) =>
        chPredicateOnlyReadClientFor(deps.ingestClient, organizationId),
    };
  }

  const client = (deps.makeClient ?? ((u: string) => createClient({ url: u })))(url);
  deps.log?.info(`[ch-read] worker reads scoped through the read identity '${user}'.`);
  return {
    isSplit: true,
    user,
    readerFor: (organizationId: string) => chScopedReadClientFor(client, organizationId),
  };
}
