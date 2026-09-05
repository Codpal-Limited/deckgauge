import { createClient, type ClickHouseClient } from '@clickhouse/client';

const DEFAULT_URL = 'http://cockpit:cockpit@localhost:8123/cockpit';

/**
 * Client methods the guard below intercepts. Everything that opens a socket, and
 * nothing that does not — a Proxy that trapped every property would turn an
 * unrelated field read into a ClickHouse error raised from somewhere with no
 * visible connection to ClickHouse.
 */
const CONNECTING_METHODS = new Set(['query', 'insert', 'command', 'exec', 'ping']);

/**
 * Under a test run with no `CLICKHOUSE_URL`, `DEFAULT_URL` is not a default —
 * it is whatever server owns this host's 8123, and the answer has never been
 * "nothing".
 *
 * For most of this repository's life it was the STAGING ClickHouse, and a suite
 * that reached it read production rows while the gate stayed green;
 * `org-sync-aggregator.test.ts` did precisely that, discovering a tenant with an
 * unscoped `SELECT DISTINCT organization_id` and asserting against 2651 rows
 * somebody had synced. That suite was fixed. The FALLBACK was not, and it got
 * more dangerous rather than less when staging moved off the default ports:
 * 8123 is now unowned, so the next thing to claim it is an unrelated
 * installation on this machine — and a suite reaching it would be reading, or
 * writing, a database this repository has never heard of.
 *
 * Postgres has had a hard refusal for this shape for a while
 * (`assertSafeTestServerUrl`). This is its ClickHouse counterpart.
 *
 * It refuses USE, not construction. The barrel is imported all over the tree for
 * pure helpers like `chInsertManyWith`, and this module builds its client at
 * import time, so throwing on construction would take down suites that never
 * touch a server. `@clickhouse/client` connects lazily, so an unused client
 * costs nothing.
 *
 * The escape hatch is to name a server: set `CLICKHOUSE_URL`, or — normally —
 * build a client from `INTEGRATION_CLICKHOUSE_URL` and gate the suite with
 * `integrationGateLive('clickhouse')`, which is what every integration suite in
 * the repository already does.
 */
function refuseDefaultUnderTest(client: ClickHouseClient): ClickHouseClient {
  // Returns a REJECTED PROMISE rather than throwing synchronously. Every method
  // it stands in for is async, and callers write `.catch()` around them; a
  // synchronous throw would escape those handlers and surface as an uncaught
  // error somewhere unrelated, which is the opposite of what a guard is for.
  const refuse = (): Promise<never> =>
    Promise.reject(
      new Error(
        `ClickHouse: refusing to use the default URL (${DEFAULT_URL}) from a test run.\n` +
          "That address is not this repository's test stack. It is whatever is listening on " +
          "this host's 8123 — the staging server historically, and since staging moved off " +
          'the default ports, potentially an unrelated installation.\n' +
          'Name the server you mean: set CLICKHOUSE_URL, or build a client from ' +
          "INTEGRATION_CLICKHOUSE_URL and gate the suite with integrationGateLive('clickhouse').",
      ),
    );

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && CONNECTING_METHODS.has(prop)) return refuse;
      return Reflect.get(target, prop, receiver);
    },
  });
}

const client: ClickHouseClient = createClient({
  url: process.env.CLICKHOUSE_URL ?? DEFAULT_URL,
  clickhouse_settings: {
    // MV-aware deduplication keeps re-syncs idempotent against the
    // aggregating MVs (e.g. jira_flow_efficiency_state). ClickHouse 24.x
    // disallows pairing this with async_insert (Code 344
    // SUPPORT_IS_DISABLED), so we use sync inserts. chInsertMany batches
    // via JSONEachRow which gives plenty of throughput for the worker's
    // dual-write pattern (planning/CLICKHOUSE-ARCHITECTURE.md §8).
    deduplicate_blocks_in_dependent_materialized_views: 1,
    // Source APIs (GitHub/Jira/ADO) hand us ISO-8601 timestamps with a
    // trailing `T`/`Z` (e.g. "2026-06-17T16:09:53Z"). ClickHouse's default
    // `basic` parser rejects that into a DateTime column ("Cannot parse
    // input: expected '\"' before: 'Z'"), which silently broke every commit
    // and PR intelligence insert. `best_effort` parses ISO-8601 (and still
    // accepts the "YYYY-MM-DD HH:MM:SS" form) so all dual-writes land.
    date_time_input_format: 'best_effort',
  },
});

/**
 * `VITEST` is set by the runner in every worker process, so this is on for the
 * whole suite and off for every shipped code path. An explicit `CLICKHOUSE_URL`
 * always wins — a developer who names a server has said what they mean.
 */
export const clickhouse: ClickHouseClient =
  process.env.VITEST && !process.env.CLICKHOUSE_URL ? refuseDefaultUnderTest(client) : client;

// Large batches blow past ClickHouse's per-query memory cap (Code 241
// MEMORY_LIMIT_EXCEEDED) — observed on GitHub commit syncs where a single
// 4k-row payload allocated ~810 MiB. Chunk into smaller inserts so each
// HTTP request stays well below the server cap, regardless of repo size.
const CH_INSERT_CHUNK = 500;

interface InsertCapable {
  insert(params: {
    table: string;
    values: Array<Record<string, unknown>>;
    format: 'JSONEachRow';
  }): Promise<unknown>;
}

/**
 * Testable core of chInsertMany: same rules, but takes an injectable client
 * so tests can verify the tenant stamp and validation without a ClickHouse
 * container.
 */
export async function chInsertManyWith<T extends Record<string, unknown>>(
  client: InsertCapable,
  table: string,
  organizationId: string,
  rows: ReadonlyArray<T>,
): Promise<void> {
  if (organizationId.trim() === '') {
    // organization_id leads every ClickHouse table's sort key. A row that
    // lands without one matches no tenant's predicate, and because the
    // column is part of the sort key, ClickHouse has no UPDATE path (Code
    // 420 CANNOT_UPDATE_COLUMN) to fix it afterwards — the row would be
    // orphaned and undiscoverable forever. Fail before the network call
    // rather than write it.
    throw new Error(
      `chInsertMany(${table}): organizationId is required — a row written without one ` +
        'matches no tenant predicate, and because organization_id is a sort-key column it ' +
        'cannot be corrected after the fact',
    );
  }
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += CH_INSERT_CHUNK) {
    const chunk = rows
      .slice(i, i + CH_INSERT_CHUNK)
      // Spread the row first, then stamp — so a caller-supplied
      // organization_id in the row object can never win. The bound
      // organizationId is the only authority on which tenant owns this row.
      .map((row) => ({ ...row, organization_id: organizationId }));
    await client.insert({ table, values: chunk, format: 'JSONEachRow' });
  }
}

export async function chInsertMany<T extends Record<string, unknown>>(
  table: string,
  organizationId: string,
  rows: T[],
): Promise<void> {
  return chInsertManyWith(clickhouse as unknown as InsertCapable, table, organizationId, rows);
}

export type { ClickHouseClient };
