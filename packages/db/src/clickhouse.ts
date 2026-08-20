import { createClient, type ClickHouseClient } from '@clickhouse/client';

const DEFAULT_URL = 'http://cockpit:cockpit@localhost:8123/cockpit';

export const clickhouse: ClickHouseClient = createClient({
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
