import { createClient, type ClickHouseClient } from '@clickhouse/client';

let client: ClickHouseClient | null = null;

/**
 * Lazily constructs a read-only ClickHouse client for the SQL console.
 *
 * Reads `CLICKHOUSE_CONSOLE_URL` (or falls back to `CLICKHOUSE_URL` /
 * `INTEGRATION_CLICKHOUSE_URL`), with credentials from
 * `CLICKHOUSE_CONSOLE_USER` (defaults to `deckgauge_console`) and
 * `CLICKHOUSE_CONSOLE_PASSWORD`.
 *
 * The `readonly=1` clickhouse_settings ensure that even if our SQL-layer
 * defenses were bypassed, the database engine itself refuses non-SELECT.
 * This is the third layer of defense after AST rewriting + second-line
 * assertion.
 */
export function getConsoleClickhouse(): ClickHouseClient {
  if (client) return client;
  const url =
    process.env.CLICKHOUSE_CONSOLE_URL ??
    process.env.CLICKHOUSE_URL ??
    process.env.INTEGRATION_CLICKHOUSE_URL;
  if (!url) {
    throw new Error(
      'CLICKHOUSE_CONSOLE_URL (or CLICKHOUSE_URL / INTEGRATION_CLICKHOUSE_URL) must be set',
    );
  }
  client = createClient({
    url,
    username: process.env.CLICKHOUSE_CONSOLE_USER ?? 'deckgauge_console',
    password: process.env.CLICKHOUSE_CONSOLE_PASSWORD ?? '',
    clickhouse_settings: {
      readonly: '1',
      max_execution_time: 15,
      max_rows_to_read: '1000000',
    },
  });
  return client!;
}

// Test-only — reset the memoised client between tests.
export function __resetConsoleClickhouseForTests(): void {
  client = null;
}
