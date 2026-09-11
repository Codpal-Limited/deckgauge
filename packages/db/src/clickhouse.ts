import { createClient, type ClickHouseClient } from '@clickhouse/client';

/**
 * The URL handed to `createClient` when `CLICKHOUSE_URL` is unset.
 *
 * It is deliberately UNRESOLVABLE and carries no credential. This line used to
 * read `http://cockpit:cockpit@localhost:8123/cockpit` — a working password,
 * committed to a public repository, in product source. Every install shared it,
 * which is what made the fallback appear to work at all.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, so if the refusal
 * below is ever removed the failure is a DNS error naming this constant rather
 * than a silent connection to whatever owns this host's 8123.
 */
const UNCONFIGURED_URL = 'http://unconfigured.invalid:8123';

/**
 * Client methods the guard below intercepts. Everything that opens a socket, and
 * nothing that does not — a Proxy that trapped every property would turn an
 * unrelated field read into a ClickHouse error raised from somewhere with no
 * visible connection to ClickHouse.
 */
const CONNECTING_METHODS = new Set(['query', 'insert', 'command', 'exec', 'ping']);

/**
 * With no `CLICKHOUSE_URL` there is no server to talk to, and there never really
 * was: the old fallback was not a default so much as "whatever owns this host's
 * 8123", and the answer has never been "nothing".
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
 * IT APPLIES OUTSIDE TESTS TOO, which it did not before. The refusal used to be
 * gated on `VITEST`, so a HOST-path api or worker with no `CLICKHOUSE_URL` still
 * got `cockpit:cockpit@localhost:8123` — and once each install generates its own
 * password that address cannot authenticate anyway. The choice was between an
 * authentication error naming nothing and a refusal naming the variable.
 *
 * `.env.example` deliberately does NOT declare `CLICKHOUSE_URL`, and that is not
 * an oversight: `apps/worker/src/test-setup.ts` calls dotenv on the ROOT `.env`,
 * so a value there would reach the worker's test run and switch this guard off —
 * pointing the suite at a real server, which is the exact scar it exists for.
 * Compose builds the variable for the containers; a host-path developer exports
 * it for the command.
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
function refuseUnconfigured(client: ClickHouseClient): ClickHouseClient {
  // Returns a REJECTED PROMISE rather than throwing synchronously. Every method
  // it stands in for is async, and callers write `.catch()` around them; a
  // synchronous throw would escape those handlers and surface as an uncaught
  // error somewhere unrelated, which is the opposite of what a guard is for.
  const refuse = (): Promise<never> =>
    Promise.reject(
      new Error(
        'ClickHouse: CLICKHOUSE_URL is not set, so there is no server to use.\n' +
          'There is no longer a default. It used to be a localhost URL carrying a password ' +
          "committed to a public repository, resolving to whatever owns this host's 8123: " +
          'the staging server historically, and since staging moved off the default ports, ' +
          'potentially an unrelated installation.\n' +
          'Name the server you mean. Under Docker, docker-compose.yml builds CLICKHOUSE_URL ' +
          'from CLICKHOUSE_USER and CLICKHOUSE_PASSWORD and this cannot happen. On the host, ' +
          'export CLICKHOUSE_URL for the command. In a test, build a client from ' +
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
  url: process.env.CLICKHOUSE_URL ?? UNCONFIGURED_URL,
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
 * An explicit `CLICKHOUSE_URL` always wins — anyone who names a server has said
 * what they mean. Everything else refuses on use.
 *
 * The condition used to be `VITEST && !CLICKHOUSE_URL`, i.e. the guard was off
 * for every shipped path, which is where the committed credential still worked.
 */
export const clickhouse: ClickHouseClient = process.env.CLICKHOUSE_URL
  ? client
  : refuseUnconfigured(client);

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
